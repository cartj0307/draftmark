"use strict";

/* Individual mocks diverge chaotically when the forecast depth changes — one
 * different pick cascades through every pick after it. That says nothing about
 * whether a cheap forecast is good enough, because a mock is never read on its
 * own; it is read as one draw from a distribution. So compare the aggregate:
 * across many mocks, does the board that reaches your picks look the same, and
 * do the rosters come out equally strong?
 *
 *   node build/calibrate_mocks.js
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
  rankByVona: rec.rankByVona, makeRng: sim.makeRng });

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
  td_model: p.td_model, yardage_model: p.yardage_model, availability: p.availability })), league);

function withVor(list, replIdx) {
  const s = list.map((p) => ({ ...p, es: p.mean * REG })).sort((a, b) => b.es - a.es);
  const repl = s[Math.min(replIdx - 1, s.length - 1)].es;
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
const timing = { _kdstFloor: 7 };
const cells = core.generateOrder(league.teams, league.draft.rounds);

/** VOR of the players actually occupying starting seats. */
function starterStrength(ids) {
  const byPos = {};
  for (const id of ids) (byPos[posOf(id)] = byPos[posOf(id)] || []).push(valOf(id));
  let total = 0;
  for (const [pos, n] of Object.entries(league.roster.starters)) {
    const list = (byPos[pos] || []).sort((a, b) => b - a);
    for (let i = 0; i < n; i++) total += list[i] ?? -40;   // unfilled seat is a real hole
  }
  return total;
}

function mock(runs, seed) {
  let open = cells.map((c) => ({ slot: c.slot, round: c.round, overall: c.overall }));
  const rosters = {}; for (let s = 1; s <= league.teams; s++) rosters[s] = [];
  const taken = new Set();
  const bestAtYourPicks = {};
  while (open.length) {
    const pool = POOL.filter((p) => !taken.has(p.id));
    if (open[0].slot === YOU) {
      const b = {};
      for (const p of pool) if (b[p.position] === undefined) b[p.position] = p.val;
      bestAtYourPicks[open[0].overall] = b;
    }
    const r = auto.autoPick({ openCells: open, rosters, pool, cfg: league,
                              posOf, timing, byeOf, valOf },
                            { preset: "realistic", runs, seed: seed + open[0].overall * 7919 });
    if (!r) break;
    taken.add(r.player.id);
    rosters[r.slot].push(r.player.id);
    open = open.slice(1);
  }
  return { rosters, bestAtYourPicks };
}

const N = +(process.env.N || 10);
const DEPTHS = [60, 30, 15, 8];
const out = {};

for (const runs of DEPTHS) {
  const strengths = [], best = {};
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const { rosters, bestAtYourPicks } = mock(runs, 900000 + i * 7717);
    for (let s = 1; s <= league.teams; s++) strengths.push(starterStrength(rosters[s]));
    for (const [ov, b] of Object.entries(bestAtYourPicks)) {
      for (const [pos, v] of Object.entries(b)) {
        ((best[ov] = best[ov] || {})[pos] = best[ov][pos] || []).push(v);
      }
    }
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) * (x - m)))); };
  out[runs] = { strengths, best, mean: mean(strengths), sd: sd(strengths),
                secs: (Date.now() - t0) / 1000 };
}

console.log(`\n${N} mocks at each forecast depth, preset=realistic\n`);
console.log("ROSTER STRENGTH — total VOR of the 8 starting seats, all 12 teams pooled");
console.log("  depth   mean      sd     time/mock");
for (const runs of DEPTHS) {
  const o = out[runs];
  console.log(`  ${String(runs).padStart(3)}   ${o.mean.toFixed(1).padStart(7)}  ${o.sd.toFixed(1).padStart(6)}` +
              `   ${(o.secs / N).toFixed(2)}s`);
}

console.log("\nBEST AVAILABLE AT YOUR PICKS — mean VOR, by forecast depth");
const ovs = Object.keys(out[60].best).map(Number).sort((a, b) => a - b);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log("  pick   " + DEPTHS.map((d) => `d=${d}`.padStart(8)).join("") + "    spread");
for (const ov of ovs.slice(0, 8)) {
  for (const pos of ["RB", "WR"]) {
    const vals = DEPTHS.map((d) => {
      const a = (out[d].best[ov] || {})[pos];
      return a && a.length ? mean(a) : null;
    });
    if (vals.some((v) => v == null)) continue;
    const spread = Math.max(...vals) - Math.min(...vals);
    console.log(`  ${String(ov).padStart(3)} ${pos}  ` +
      vals.map((v) => v.toFixed(1).padStart(8)).join("") +
      `   ${spread.toFixed(1).padStart(6)}`);
  }
}
