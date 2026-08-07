"use strict";

const fs = require("fs");
const path = require("path");
const dist = require("../src/distributions.js");
const intel = require("../src/intel.js");
const sim = require("../src/sim.js");
const rec = require("../src/recommend.js");
const core = require("../src/draft_core.js");
intel.useGammaSurvival(dist.gammaSurvival);
sim.configureSim({ score: require("../src/scoring.js").score, sampleGamma: dist.sampleGamma,
  samplePoisson: dist.samplePoisson, sampleNegBin: dist.sampleNegBin,
  gaussian: dist.gaussian, normCdf: intel.normCdf, expectedWeek: intel.expectedWeek });
rec.configureRecommend({ prepareSimPlayers: sim.prepareSimPlayers,
  runChampionshipSim: sim.runChampionshipSim, makeRng: sim.makeRng });

const ROOT = path.join(__dirname, "..");
const league = JSON.parse(fs.readFileSync(path.join(ROOT, "config/league.json"), "utf8"));
const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, "data/bundle.json"), "utf8"));
const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, "data/league/manager_profiles.json"), "utf8"));
const YOU = league.your_slot;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

/* ---- pool ---- */
const skill = bundle.players.map((p) => ({
  id: p.draftmark_id, name: p.name, position: p.position, team: p.team,
  td_model: p.td_model, yardage_model: p.yardage_model, availability: p.availability }));
const { values } = intel.computeValues(skill, league);
const REG = league.schedule.regular_season_weeks[1] - league.schedule.regular_season_weeks[0] + 1;
function withVor(list, r) {
  const s = list.map((p) => ({ ...p, es: p.mean * REG })).sort((a, b) => b.es - a.es);
  const repl = s[Math.min(r - 1, s.length - 1)].es;
  return s.map((p) => ({ ...p, val: p.es - repl }));
}
const POOL = [
  ...skill.map((p) => ({ ...p, val: values.get(p.id) ? values.get(p.id).vor : null })),
  ...withVor(bundle.dst.filter((d) => d.model).map((d) => ({
    id: "dst_" + d.team, name: d.team + " D/ST", position: "DST", team: d.team,
    mean: d.model.mean })), league.replacement_levels.DST || 12),
  ...withVor(bundle.kickers.filter((k) => k.model).map((k) => ({
    id: k.draftmark_id, name: k.name, position: "K", team: k.team,
    mean: k.model.mean })), league.replacement_levels.K || 12),
].sort((a, b) => (b.val ?? -1e6) - (a.val ?? -1e6));
const BY_ID = Object.fromEntries(POOL.map((p) => [p.id, p]));
const byName = Object.fromEntries(POOL.map((p) => [p.name, p]));
const posOf = (id) => (BY_ID[id] ? BY_ID[id].position : "?");

const SLOT_TEAMS = (() => {
  const others = [...league.divisions.tier2, ...league.divisions.tier1]
    .filter((n) => n !== league.your_team);
  const a = []; let oi = 0;
  for (let s = 1; s <= league.teams; s++) a.push(s === YOU ? league.your_team : others[oi++]);
  return a;
})();
const KEEPERS = {
  "Dumpsterfire Igles": "Jonathan Taylor", "Show Us Your TDs": "Josh Allen",
  "Margo's Blackmagicwomen": "Puka Nacua", "Nate's Jive Turkeys": "Derrick Henry",
  "Kay's Cuties": "Lamar Jackson", "Ern's Tightwads": "Jalen Hurts",
  "Russmans' Rappers": "Kyren Williams", "Nick's Bluemeanies": "Christian McCaffrey",
  "steeltown punishers": "Bijan Robinson", "Rich's Rednecks": "Justin Jefferson",
  "Jeff's Mojos": "Ja'Marr Chase", "Nick jr Nighthawks": "Jahmyr Gibbs",
};
const timing = { _kdstFloor: profiles.earliest_K || 7 };
SLOT_TEAMS.forEach((n, i) => {
  const mp = profiles.managers[n];
  if (mp) timing[i + 1] = { QB: mp.first_QB, K: mp.first_K, DST: mp.first_DST };
});

/* ---- build the board up to your pick 23 ---- */
const cells = core.generateOrder(league.teams, league.draft.rounds);
const rosters = {}; for (let s = 1; s <= 12; s++) rosters[s] = [];
const taken = new Set(); const keeperSlot = {};
SLOT_TEAMS.forEach((n, i) => {
  const p = byName[KEEPERS[n]];
  if (p) { keeperSlot[i + 1] = p.id; rosters[i + 1].push(p.id); taken.add(p.id); }
});
let open = cells.filter((c) => !(c.round === 1 && keeperSlot[c.slot]))
  .map((c) => ({ slot: c.slot, round: c.round, overall: c.overall }));

// play out everything before your pick 23 with the same opponent model
const rng = sim.makeRng(4242);
while (open.length && open[0].overall < 23) {
  const cell = open.shift();
  const c = {};
  for (const id of rosters[cell.slot]) { const q = posOf(id); c[q] = (c[q] || 0) + 1; }
  const tp = timing[cell.slot] || {};
  const cand = POOL.filter((p) => !taken.has(p.id)).slice(0, 40);
  const scored = cand.map((p) => {
    const have = c[p.position] || 0, need = league.roster.starters[p.position] || 0;
    const mult = have < need ? 1.0 : have === need ? 0.25 : 0.10;
    const want = tp[p.position];
    const early = (want && cell.round < want) ? 12 * (want - cell.round) : 0;
    return [p, (p.val ?? -1e6) * mult - early];
  }).sort((a, b) => b[1] - a[1]);
  const u = rng();
  const pick = scored[u < 0.6 ? 0 : u < 0.85 ? 1 : 2][0];
  taken.add(pick.id); rosters[cell.slot].push(pick.id);
}

const avail = POOL.filter((p) => !taken.has(p.id));
const t0 = Date.now();
const fc = rec.survivalForecast(open, rosters, avail, YOU, league, posOf, timing, 150);
const ms = Date.now() - t0;

ok(`forecast runs fast enough for the clock (${ms} ms)`, ms < 2500, `${ms} ms`);
ok("forecast identifies your next pick as 26", fc.nextPick === 26, String(fc.nextPick));
ok("forecast produced survival probabilities", fc.survival.size > 50, String(fc.survival.size));

const ranked = rec.rankByVona(avail, rosters[YOU], league, posOf, fc);
ok("ranking produced", ranked.length > 20, String(ranked.length));

console.log("\n  TOP 10 AT YOUR PICK 23 (next pick 26, 2 away):");
console.log("    " + "player".padEnd(24) + "pos  base  VONA  surv  score");
for (const r of ranked.slice(0, 10)) {
  console.log(`    ${r.player.name.padEnd(24)}${r.player.position.padEnd(5)}` +
    `${r.base.toFixed(0).padStart(4)}  ${r.vona.toFixed(1).padStart(4)}  ` +
    `${(r.survival * 100).toFixed(0).padStart(3)}%  ${r.score.toFixed(1).padStart(5)}`);
}

{
  const certain = ranked.filter((r) => r.survival > 0.97 && r.vona > 0);
  ok("players certain to survive get no urgency credit",
     certain.every((r) => Math.abs(r.score - r.base) < 0.5),
     certain.length ? `${certain[0].player.name} score ${certain[0].score} vs base ${certain[0].base}` : "none");
}

{
  const top = ranked.slice(0, 5).map((r) => r.score);
  const spread = top[0] - top[4];
  ok(`top-5 scores are separated (spread ${spread.toFixed(1)} pts)`, spread > 1.0, String(spread));
}
/* kickers and defenses must not surface this early */
{
  const kd = ranked.slice(0, 15).filter((r) => r.player.position === "K" || r.player.position === "DST");
  ok("no kicker or defense in the round-2 top 15", kd.length === 0,
     kd.map((r) => r.player.name).join(","));
}

  const emptyRosters = {}; for (let s = 1; s <= 12; s++) emptyRosters[s] = [];
  const allCells = cells.map((c) => ({ slot: c.slot, round: c.round, overall: c.overall }));
  const f0 = rec.survivalForecast(allCells, emptyRosters, POOL, YOU, league, posOf, timing, 60);
  const cmc = byName["Christian McCaffrey"];
  ok("forecast knows you are NOT on the clock at draft start", f0.onClock === false);
  ok("your upcoming pick is 11", f0.yourPick === 11, String(f0.yourPick));
  const avail = f0.availNow.get(cmc.id);
  ok(`the consensus #1 does NOT survive 10 picks (availNow ${(avail * 100).toFixed(0)}%)`,
     avail < 0.15, String(avail));
  ok("every pool player has an explicit probability, none defaulted",
     POOL.every((p) => f0.availNow.has(p.id) && f0.survival.has(p.id)));
  const r0 = rec.rankByVona(POOL, [], league, posOf, f0);
  ok("players who cannot reach your pick are not recommended",
     !r0.slice(0, 5).some((x) => x.player.name === "Christian McCaffrey"),
     r0.slice(0, 3).map((x) => `${x.player.name} ${(x.availNow * 100).toFixed(0)}%`).join(", "));
  console.log("\n  DRAFT-START PREVIEW (your pick 11, 10 picks away):");
  for (const x of r0.slice(0, 5)) {
    console.log(`    ${x.player.name.padEnd(24)}${x.player.position.padEnd(5)}` +
      `score ${x.score.toFixed(1).padStart(5)}   ${(x.availNow * 100).toFixed(0)}% likely there`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
