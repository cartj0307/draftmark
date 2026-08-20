"use strict";

/* Walks your seat through a full auto-draft and prints what F9 would put at
 * the top of the board at every one of your picks. The failure this exists to
 * catch is the one that is invisible in aggregate: a board that recommends
 * nothing but kickers and defenses from round 7 on.
 *
 *   node build/check_recs.js
 */

const fs = require("fs");
const path = require("path");
const dist = require("../src/distributions.js");
const intel = require("../src/intel.js");
const scoring = require("../src/scoring.js");
const sim = require("../src/sim.js");
const rec = require("../src/recommend.js");
const auto = require("../src/autopick.js");
const core = require("../src/draft_core.js");

intel.useGammaSurvival(dist.gammaSurvival);
sim.configureSim({ score: scoring.score, sampleGamma: dist.sampleGamma,
  samplePoisson: dist.samplePoisson, sampleNegBin: dist.sampleNegBin,
  gaussian: dist.gaussian, normCdf: intel.normCdf, expectedWeek: intel.expectedWeek });
rec.configureRecommend({ prepareSimPlayers: sim.prepareSimPlayers,
  runChampionshipSim: sim.runChampionshipSim, makeRng: sim.makeRng });
auto.configureAutopick({ survivalForecast: rec.survivalForecast,
  rankByVona: rec.rankByVona, makeRng: sim.makeRng,
  seatFloors: rec.seatFloors, marginalGain: rec.marginalGain,
  valsByPos: rec.valsByPos });

const ROOT = path.join(__dirname, "..");
const league = JSON.parse(fs.readFileSync(path.join(ROOT, "config/league.json"), "utf8"));
const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, "data/bundle.json"), "utf8"));
const YOU = league.your_slot;
const REG = league.schedule.regular_season_weeks[1] - league.schedule.regular_season_weeks[0] + 1;

const skill = bundle.players.map((p) => ({
  id: p.draftmark_id, name: p.name, position: p.position, team: p.team,
  bye: (bundle.teams[p.team] || {}).bye }));
const { values } = intel.computeValues(bundle.players.map((p) => ({
  id: p.draftmark_id, name: p.name, position: p.position, team: p.team,
  td_model: p.td_model, yardage_model: p.yardage_model,
  availability: p.availability })), league);

function withVor(list, r) {
  const s = list.map((p) => ({ ...p, es: p.mean * REG })).sort((a, b) => b.es - a.es);
  const repl = s[Math.min(r - 1, s.length - 1)].es;
  return s.map((p) => ({ ...p, val: p.es - repl }));
}
const dsts = withVor(bundle.dst.filter((d) => d.model).map((d) => ({
  id: "dst_" + d.team, name: d.team + " D/ST", position: "DST", team: d.team,
  bye: (bundle.teams[d.team] || {}).bye, mean: d.model.mean })), 12);
const ks = withVor(bundle.kickers.filter((k) => k.model).map((k) => ({
  id: k.draftmark_id, name: k.name, position: "K", team: k.team,
  bye: (bundle.teams[k.team] || {}).bye, mean: k.model.mean })), 12);

const POOL = [
  ...skill.map((p) => ({ ...p, val: values.get(p.id) ? values.get(p.id).vor : null })),
  ...dsts, ...ks,
].filter((p) => p.val != null).sort((a, b) => b.val - a.val);

const BY = Object.fromEntries(POOL.map((p) => [p.id, p]));
const posOf = (id) => (BY[id] ? BY[id].position : "?");
const valOf = (id) => (BY[id] ? BY[id].val : 0);
const byeOf = (id) => (BY[id] ? BY[id].bye : null);
const WAIVER = rec.waiverBaselines(POOL, league);
const timing = { _kdstFloor: 7 };
const cells = core.generateOrder(league.teams, league.draft.rounds);

console.log("\nWAIVER BASELINE — VOR of the best body waivers hand you, by position");
for (const [pos, v] of Object.entries(WAIVER).sort((a, b) => a[1] - b[1])) {
  console.log(`  ${pos.padEnd(4)} ${v.toFixed(1).padStart(7)}`);
}

let open = cells.map((c) => ({ slot: c.slot, round: c.round, overall: c.overall }));
const rosters = {}; for (let s = 1; s <= league.teams; s++) rosters[s] = [];
const taken = new Set();

console.log("\nWHAT F9 PUTS AT THE TOP OF YOUR BOARD, EVERY PICK\n");
let kdstSweeps = 0;

while (open.length) {
  const cell = open[0];
  const pool = POOL.filter((p) => !taken.has(p.id));

  if (cell.slot === YOU) {
    const fc = rec.survivalForecast(open, rosters, pool, YOU, league, posOf, timing, 80);
    const ranked = rec.rankByVona(pool, rosters[YOU], league, posOf, fc, {
      waiver: WAIVER,
      floors: rec.seatFloors(pool, rosters, league, posOf, WAIVER),
      valOf, round: cell.round,
      earliestK: league.draft.your_earliest_K_round,
      earliestDST: league.draft.your_earliest_DST_round,
    });
    const top = ranked.slice(0, 5);
    const allKD = top.every((x) => x.player.position === "K" || x.player.position === "DST");
    if (allKD) kdstSweeps++;
    console.log(`  R${String(cell.round).padStart(2)} pick ${String(cell.overall).padStart(3)}  ` +
      top.map((x) => `${x.player.position} ${x.player.name.split(" ").slice(-1)[0]} ` +
                     `${x.score.toFixed(1)}`).join("  ·  ") + (allKD ? "   <-- ALL K/DST" : ""));
  }

  const r = auto.autoPick({ openCells: open, rosters, pool, cfg: league,
                            posOf, timing, byeOf, valOf, waiver: WAIVER },
                          { preset: "pro", runs: 30, seed: cell.overall * 7919 });
  if (!r) break;
  taken.add(r.player.id);
  rosters[r.slot].push(r.player.id);
  open = open.slice(1);
}

const c = {};
for (const id of rosters[YOU]) { const q = posOf(id); c[q] = (c[q] || 0) + 1; }
console.log(`\n  your final shape: ` +
  ["QB", "RB", "WR", "TE", "K", "DST"].map((p) => `${p}${c[p] || 0}`).join(" "));
console.log(`  picks where the top 5 were all K/DST: ${kdstSweeps}`);
