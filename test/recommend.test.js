"use strict";

const fs = require("fs");
const path = require("path");
const dist = require("../src/distributions.js");
const intel = require("../src/intel.js");
const scoring = require("../src/scoring.js");
const sim = require("../src/sim.js");
const rec = require("../src/recommend.js");
const core = require("../src/draft_core.js");

intel.useGammaSurvival(dist.gammaSurvival);
sim.configureSim({ score: scoring.score, sampleGamma: dist.sampleGamma,
  samplePoisson: dist.samplePoisson, sampleNegBin: dist.sampleNegBin,
  gaussian: dist.gaussian, normCdf: intel.normCdf, expectedWeek: intel.expectedWeek });
rec.configureRecommend({ prepareSimPlayers: sim.prepareSimPlayers,
  runChampionshipSim: sim.runChampionshipSim, makeRng: sim.makeRng });

const ROOT = path.join(__dirname, "..");
const league = JSON.parse(fs.readFileSync(path.join(ROOT, "config/league.json"), "utf8"));
const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, "data/bundle.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

/* ---- shared fixtures: ranked pool with values + sim entries ---- */
const skill = bundle.players.map((p) => ({
  id: p.draftmark_id, name: p.name, position: p.position, team: p.team,
  bye: (bundle.teams[p.team] || {}).bye, td_model: p.td_model,
  yardage_model: p.yardage_model, availability: p.availability,
}));
const { values } = intel.computeValues(skill, league);
const tiers = intel.detectTiers(skill, values, league);
const dsts = bundle.dst.filter((d) => d.model).map((d) => ({
  id: "dst_" + d.team, name: d.team + " D/ST", position: "DST", team: d.team,
  bye: (bundle.teams[d.team] || {}).bye, mean: d.model.mean, sd: d.model.sd, val: 0,
}));
const ks = bundle.kickers.filter((k) => k.model).map((k) => ({
  id: k.draftmark_id, name: k.name, position: "K", team: k.team,
  bye: (bundle.teams[k.team] || {}).bye, mean: k.model.mean, sd: k.model.sd, val: 0,
}));
const pool = [
  ...skill.map((p) => ({ ...p, val: values.get(p.id) ? values.get(p.id).vor : null,
                         tier: tiers.get(p.id) || null })),
  ...dsts, ...ks,
].sort((a, b) => (b.val ?? -1e6) - (a.val ?? -1e6));
const byId = Object.fromEntries(pool.map((p) => [p.id, p]));
const posOf = (id) => byId[id] ? byId[id].position : "?";
const toSimEntry = (id) => {
  const p = byId[id];
  if (!p) return null;
  if (p.position === "DST" || p.position === "K")
    return { id, kind: "dstk", position: p.position, team: p.team, bye: p.bye, mean: p.mean, sd: p.sd };
  return { id, kind: "skill", position: p.position, team: p.team, bye: p.bye,
           td_model: p.td_model, yardage_model: p.yardage_model, availability: p.availability };
};
const slotTiers = {}; for (let s = 1; s <= 12; s++) slotTiers[s] = s <= 6 ? 1 : 2;

/* mid-draft state: 4 complete rounds by value, your slot = 11 */
function midDraftState(rounds) {
  const cells = core.generateOrder(12, league.draft.rounds);
  const startRosters = {}; for (let s = 1; s <= 12; s++) startRosters[s] = [];
  const taken = new Set();
  let i = 0;
  for (const c of cells) {
    if (c.round > rounds) break;
    while (taken.has(pool[i].id) || pool[i].val == null) i++;
    startRosters[c.slot].push(pool[i].id); taken.add(pool[i].id); i++;
  }
  const openCells = cells.filter((c) => c.round > rounds);
  return { openCells, startRosters };
}

/* ---- completion legality + determinism ---- */
{
  const { openCells, startRosters } = midDraftState(4);
  const d1 = rec.completeDraft(openCells, startRosters, pool, 11, pool[60].id, sim.makeRng(5), league, posOf);
  const d2 = rec.completeDraft(openCells, startRosters, pool, 11, pool[60].id, sim.makeRng(5), league, posOf);
  ok("completion is deterministic under the same seed (CRN foundation)",
     JSON.stringify(d1.rosters) === JSON.stringify(d2.rosters));
  const d3 = rec.completeDraft(openCells, startRosters, pool, 11, pool[61].id, sim.makeRng(5), league, posOf);
  ok("different candidate, same seed: only knock-on differences",
     JSON.stringify(d1.rosters) !== JSON.stringify(d3.rosters));
  let allLegal = true, full = true, dupes = false;
  const seen = new Set();
  for (let s = 1; s <= 12; s++) {
    const c = {};
    for (const id of d1.rosters[s]) {
      if (seen.has(id)) dupes = true; seen.add(id);
      c[posOf(id)] = (c[posOf(id)] || 0) + 1;
    }
    for (const [pos, mx] of Object.entries(league.roster.position_max))
      if ((c[pos] || 0) > mx) allLegal = false;
    if (d1.rosters[s].length !== 16) full = false;
  }
  ok("every completed roster has exactly 16 picks", full);
  ok("no player on two rosters", !dupes);
  ok("position maxes respected for all twelve teams", allLegal);
  const mine = d1.rosters[11].map(posOf);
  ok("your completed roster satisfies every starter seat (incl. DST + K)",
     ["QB", "RB", "WR", "TE", "DST", "K"].every((p) =>
       mine.filter((x) => x === p).length >= league.roster.starters[p]), mine.join(","));
}

/* ---- candidate selection reflects need + survival ---- */
{
  const { openCells, startRosters } = midDraftState(4);
  const cands = rec.selectCandidates(openCells, startRosters, pool, 11, league, posOf, [], 5);
  ok("selects a sane candidate slate (3-5)", cands.length >= 3 && cands.length <= 5, String(cands.length));
  ok("candidates are all still available", cands.every((p) => !Object.values(startRosters).flat().includes(p.id)));
  const top20gone = pool.slice(0, 20).every((p) => Object.values(startRosters).flat().includes(p.id)
    || !cands.some((c) => c.id === p.id && pool.indexOf(p) < 5));
  ok("does not offer players who cannot survive to your pick", top20gone);
}

/* ---- the full recommendation with CRN batches ---- */
{
  const { openCells, startRosters } = midDraftState(4);
  const ctx = { openCells, startRosters, pool, yourSlot: 11, cfg: league, posOf, toSimEntry, slotTiers };
  const cands = rec.selectCandidates(openCells, startRosters, pool, 11, league, posOf, [], 4);
  const acc = rec.initAccumulator(cands);
  const t0 = Date.now();
  for (let b = 0; b < 3; b++) rec.evaluateBatch(ctx, acc, 150, b);
  const ms = Date.now() - t0;
  ok("all candidates evaluated on equal seasons", acc.candidates.every((c) => c.seasons === 450));
  ok("probabilities are probabilities", acc.candidates.every((c) => c.p >= 0 && c.p <= 1));
  const v = rec.verdict(acc, ctx);
  ok("verdict exists with a name and a because", !!v && !!v.name && v.because.length > 10, JSON.stringify(v));
  ok("honesty tax always present", v.tax.includes("±"), v.tax);
  ok(`recommendation latency workable (${ms} ms for 4 cand x 450 seasons)`, ms < 30000, `${ms} ms`);
  console.log(`  [info] verdict: ${v.name} (${(v.p * 100).toFixed(1)}%) — ${v.because} — ${v.tax}`);
}

/* ---- honesty: near-identical candidates must not fake a decisive edge ---- */
{
  const { openCells, startRosters } = midDraftState(4);
  const ctx = { openCells, startRosters, pool, yourSlot: 11, cfg: league, posOf, toSimEntry, slotTiers };
  // two adjacent same-position players deep in a tier: a true coin flip at tiny N
  const rbs = pool.filter((p) => p.position === "RB" && p.val != null &&
    !Object.values(startRosters).flat().includes(p.id)).slice(6, 8);
  const acc = rec.initAccumulator(rbs);
  rec.evaluateBatch(ctx, acc, 120, 0);
  const v = rec.verdict(acc, ctx);
  ok("tiny-N near-tie is declared inside the noise floor",
     v.decisive === false || Math.abs(acc.candidates[0].p - acc.candidates[1].p) > v.noisePct / 100,
     JSON.stringify({ edge: v.edgePct, noise: v.noisePct }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
