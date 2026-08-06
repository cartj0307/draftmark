"use strict";

const fs = require("fs");
const path = require("path");
const dist = require("../src/distributions.js");
const intel = require("../src/intel.js");
const scoring = require("../src/scoring.js");
const sim = require("../src/sim.js");

intel.useGammaSurvival(dist.gammaSurvival);
sim.configureSim({
  score: scoring.score, sampleGamma: dist.sampleGamma, samplePoisson: dist.samplePoisson,
  sampleNegBin: dist.sampleNegBin, gaussian: dist.gaussian, normCdf: intel.normCdf,
  expectedWeek: intel.expectedWeek,
});

const ROOT = path.join(__dirname, "..");
const league = JSON.parse(fs.readFileSync(path.join(ROOT, "config/league.json"), "utf8"));
const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, "data/bundle.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const skill = bundle.players.map((p) => ({
  id: p.draftmark_id, kind: "skill", position: p.position, team: p.team,
  bye: (bundle.teams[p.team] || {}).bye, td_model: p.td_model,
  yardage_model: p.yardage_model, availability: p.availability, name: p.name,
}));
const byName = Object.fromEntries(skill.map((p) => [p.name, p]));
const dsts = bundle.dst.filter((d) => d.model).map((d) => ({
  id: "dst_" + d.team, kind: "dstk", position: "DST", team: d.team,
  bye: (bundle.teams[d.team] || {}).bye, mean: d.model.mean, sd: d.model.sd,
}));
const ks = bundle.kickers.filter((k) => k.model).map((k) => ({
  id: k.draftmark_id, kind: "dstk", position: "K", team: k.team,
  bye: (bundle.teams[k.team] || {}).bye, mean: k.model.mean, sd: k.model.sd,
}));

// ---- VI.8 check 1: single-week sampled mean matches the Phase 3 closed form ----
{
  const jt = byName["Jonathan Taylor"];
  const prepared = sim.prepareSimPlayers([jt], league);
  const rng = sim.makeRng(7);
  const week = 2; // not IND's bye
  const mods = { talent: new Float32Array([1]), miss: new Int32Array([0]) };
  let sum = 0; const N = 50000;
  for (let i = 0; i < N; i++) sum += sim.drawWeek(prepared.players, week, mods, rng, league)[0];
  const mc = sum / N;
  const closed = intel.expectedWeek(jt, jt.td_model.lambda_weekly[week - 1], league.scoring);
  ok(`weekly sampled mean matches closed form (MC ${mc.toFixed(2)} vs ${closed.toFixed(2)})`,
     Math.abs(mc - closed) < 0.2, `${mc} vs ${closed}`);
}

// ---- lineup legality: no flex, byes/holes respected ----
{
  const roster = [byName["Jonathan Taylor"], byName["Jahmyr Gibbs"], byName["Bijan Robinson"],
                  byName["Puka Nacua"], byName["Nico Collins"], byName["Trey McBride"],
                  byName["Matthew Stafford"], dsts[0], ks[0]];
  const prepared = sim.prepareSimPlayers(roster, league);
  const idx = roster.map((_, i) => i);
  const realized = new Int16Array(roster.length).fill(10);
  realized[2] = -32768;               // Bijan out
  const r = sim.lineupScore(idx, prepared.players, realized, prepared.ew, 2, league.roster.starters);
  // 1QB+2RB+2WR+1TE+1DST+1K = 8 starters, all worth 10 except Bijan excluded -> exactly 8 x 10
  ok("no-flex lineup seats exactly 8 and skips the out player", r.total === 80, String(r.total));
  ok("QB points tracked for the tiebreak", r.qbPts === 10, String(r.qbPts));
  const realized2 = new Int16Array(roster.length).fill(10);
  realized2[0] = realized2[1] = realized2[2] = -32768;  // all three RBs out
  const r2 = sim.lineupScore(idx, prepared.players, realized2, prepared.ew, 2, league.roster.starters);
  ok("holes score zero, never filled by other positions (no flex)", r2.total === 60, String(r2.total));
}

// ---- correlation signs (VI.8): realized corr over many draws ----
{
  // 2026 same-team fixtures: Goff+ARSB (DET pass game), Taylor+Giddens (IND backfield,
  // the doc's own handcuff pair — Montgomery left DET in 2026 free agency)
  const det = byName["Jared Goff"] ? [byName["Jared Goff"], byName["Amon-Ra St. Brown"],
               byName["Jonathan Taylor"], byName["DJ Giddens"]] : null;
  ok("correlation fixture players exist", !!det && det.every(Boolean));
  const prepared = sim.prepareSimPlayers(det, league);
  const rng = sim.makeRng(11);
  const mods = { talent: new Float32Array([1, 1, 1, 1]), miss: new Int32Array(4) };
  const N = 30000, X = [[], [], [], []];
  for (let i = 0; i < N; i++) {
    const r = sim.drawWeek(prepared.players, 2, mods, rng, league);
    for (let j = 0; j < 4; j++) X[j].push(r[j]);
  }
  function corr(a, b) {
    const n = a.length, ma = a.reduce((x, y) => x + y) / n, mb = b.reduce((x, y) => x + y) / n;
    let sab = 0, sa = 0, sb = 0;
    for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; sa += da * da; sb += db * db; }
    return sab / Math.sqrt(sa * sb);
  }
  const qbWr = corr(X[0], X[1]), rbRb = corr(X[2], X[3]);
  ok(`QB<->WR same team positive (${qbWr.toFixed(3)})`, qbWr > 0.05, String(qbWr));
  ok(`RB<->RB same team negative (${rbRb.toFixed(3)})`, rbRb < -0.05, String(rbRb));
}

// ---- full championship sim on 12 drafted rosters ----
function autodraft() {
  const { values } = intel.computeValues(skill, league);
  const ranked = skill.filter((p) => values.has(p.id)).sort((a, b) => values.get(b.id).vor - values.get(a.id).vor);
  const rosters = {}; const slotTier = {};
  for (let s = 1; s <= 12; s++) { rosters[s] = []; slotTier[s] = s <= 6 ? 1 : 2; }
  const all = [];
  const need = { QB: 2, RB: 4, WR: 4, TE: 2 };
  // simple snake autodraft of 12 skill players... keep 12+dst+k = 14 per team
  let queue = [...ranked];
  const counts = {};
  for (let round = 0; round < 12; round++) {
    for (let k = 0; k < 12; k++) {
      const s = (round % 2 === 0) ? k + 1 : 12 - k;
      counts[s] = counts[s] || { QB: 0, RB: 0, WR: 0, TE: 0 };
      const pi = queue.findIndex((p) => counts[s][p.position] < need[p.position]);
      const p = queue.splice(pi === -1 ? 0 : pi, 1)[0];
      counts[s][p.position]++;
      rosters[s].push(all.length); all.push(p);
    }
  }
  for (let s = 1; s <= 12; s++) {
    rosters[s].push(all.length); all.push(dsts[(s - 1) % dsts.length]);
    rosters[s].push(all.length); all.push(ks[(s - 1) % ks.length]);
  }
  return { rosters, all, slotTier };
}

{
  const { rosters, all, slotTier } = autodraft();
  const prepared = sim.prepareSimPlayers(all, league);
  const t0 = Date.now();
  const res = sim.runChampionshipSim(rosters, prepared, league, slotTier, { seasons: 3000, seed: 99 });
  const ms = Date.now() - t0;
  const total = Object.values(res.titles).reduce((a, b) => a + b, 0);
  ok(`championship probabilities sum to 1.0 (${total.toFixed(4)})`, Math.abs(total - 1) < 1e-9);
  const poTotal = Object.values(res.playoffs).reduce((a, b) => a + b, 0);
  ok(`playoff berths sum to 6 (${poTotal.toFixed(2)})`, Math.abs(poTotal - 6) < 1e-9);
  const spread = Math.max(...Object.values(res.titles)) - Math.min(...Object.values(res.titles));
  ok("better rosters win more (title spread > 5%)", spread > 0.05, String(spread));
  ok(`3000 seasons complete fast enough for a worker (${ms} ms)`, ms < 20000, `${ms} ms`);
  console.log(`  [info] 3000 seasons in ${ms} ms; title range ${(Math.min(...Object.values(res.titles)) * 100).toFixed(1)}%–${(Math.max(...Object.values(res.titles)) * 100).toFixed(1)}%`);
}

// ---- symmetric matchup ~ coin flip ----
{
  const jt = byName["Jonathan Taylor"];
  const prepared = sim.prepareSimPlayers([jt, jt], league);   // identical twins
  const rng = sim.makeRng(5);
  const mods = { talent: new Float32Array([1, 1]), miss: new Int32Array(2) };
  let aWins = 0; const N = 20000;
  for (let i = 0; i < N; i++) {
    const r = sim.drawWeek(prepared.players, 2, mods, rng, league);
    if (r[0] > r[1]) aWins++; else if (r[0] === r[1]) aWins += 0.5;
  }
  const wp = aWins / N;
  ok(`symmetric matchup is a coin flip (${(wp * 100).toFixed(1)}%)`, Math.abs(wp - 0.5) < 0.02, String(wp));
}

// ---- the stacking experiment (VI.6): variance direction is deterministic ----
{
  const qb = byName["Jared Goff"], wrS = byName["Amon-Ra St. Brown"], wrO = byName["Nico Collins"];
  const stacked = sim.prepareSimPlayers([qb, wrS], league);
  const unstacked = sim.prepareSimPlayers([qb, wrO], league);
  const rng1 = sim.makeRng(21), rng2 = sim.makeRng(21);
  const mods2 = { talent: new Float32Array([1, 1]), miss: new Int32Array(2) };
  const N = 40000;
  function varOfSum(prep, rng) {
    let s = 0, s2 = 0;
    for (let i = 0; i < N; i++) {
      const r = sim.drawWeek(prep.players, 2, mods2, rng, league);
      const t = r[0] + r[1];
      s += t; s2 += t * t;
    }
    return { mean: s / N, v: s2 / N - (s / N) ** 2 };
  }
  const a = varOfSum(stacked, rng1), b = varOfSum(unstacked, rng2);
  ok(`stacking raises weekly variance (stacked ${a.v.toFixed(1)} vs unstacked ${b.v.toFixed(1)})`,
     a.v > b.v, `${a.v} vs ${b.v}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
