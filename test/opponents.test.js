"use strict";
const fs = require("fs");
const path = require("path");
const dist = require("../src/distributions.js");
const intel = require("../src/intel.js");
const sim = require("../src/sim.js");
const rec = require("../src/recommend.js");
const core = require("../src/draft_core.js");

intel.useGammaSurvival(dist.gammaSurvival);
rec.configureRecommend({ prepareSimPlayers: sim.prepareSimPlayers,
  runChampionshipSim: sim.runChampionshipSim, makeRng: sim.makeRng });

const ROOT = path.join(__dirname, "..");
const league = JSON.parse(fs.readFileSync(path.join(ROOT, "config/league.json"), "utf8"));
const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, "data/bundle.json"), "utf8"));
const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, "data/league/manager_profiles.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++; else { fail++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

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
const posOf = (id) => (BY_ID[id] ? BY_ID[id].position : "?");
const cells = core.generateOrder(league.teams, league.draft.rounds)
  .map((c) => ({ slot: c.slot, round: c.round, overall: c.overall }));
cells.push({ slot: 99, round: 17, overall: 999 });
const rosters = {}; for (let s = 1; s <= 12; s++) rosters[s] = [];
const timing = { _kdstFloor: profiles.earliest_K || 7 };

const trace = [];
rec.survivalForecast(cells, rosters, POOL, 99, league, posOf, timing, 25, trace);
ok("trace captured the whole draft", trace.length > 3000, String(trace.length));

const REAL = { 1: 1.00, 2: 1.00, 3: 1.00, 4: 0.97, 5: 0.94, 6: 0.76 };
const byRound = {};
for (const t of trace) {
  if (!t.hadSeat) continue;
  (byRound[t.round] = byRound[t.round] || []).push(t.filledSeat ? 1 : 0);
}

let sse = 0, k = 0;
console.log("\n  round   simulated   real league");
for (let r = 1; r <= 6; r++) {
  const a = byRound[r] || [];
  if (!a.length) continue;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  sse += (m - REAL[r]) ** 2; k++;
  console.log(`    ${r}       ${(m * 100).toFixed(0).padStart(4)}%        ${(REAL[r] * 100).toFixed(0)}%`);
  ok(`round ${r} starter-first rate within 12 pts of reality`,
     Math.abs(m - REAL[r]) < 0.12, `sim ${m.toFixed(2)} vs real ${REAL[r]}`);
}
const rms = Math.sqrt(sse / k);
console.log(`\n  RMS error vs the real league: ${(rms * 100).toFixed(1)} pct pts`);
ok(`opponent model reproduces the league within 8 pct pts RMS`, rms < 0.08, rms.toFixed(3));

{
  const early = trace.filter((t) => t.round <= 4 && t.hadSeat);
  const stacked = early.filter((t) => !t.filledSeat).length;
  ok(`opponents rarely take depth in rounds 1-4 (${stacked}/${early.length})`,
     stacked / early.length < 0.06, `${(stacked / early.length * 100).toFixed(1)}%`);
}
{
  const tooEarly = trace.filter((t) => (t.pos === "K" || t.pos === "DST") && t.round < 7);
  ok("no simulated K or D/ST before round 7", tooEarly.length === 0, String(tooEarly.length));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
