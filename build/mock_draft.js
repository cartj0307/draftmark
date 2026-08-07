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
const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, "data/league/manager_profiles.json"), "utf8"));

const YOU = league.your_slot;
const SEASONS_PER_CAND = +(process.env.SEASONS || 400);

/* ---------------- draft order & keepers (edit these to match reality) ---- */
const SLOT_TEAMS = process.env.ORDER ? JSON.parse(process.env.ORDER) : (() => {
  // your team sits at your_slot; the rest fill the remaining slots in order
  const others = [...league.divisions.tier2, ...league.divisions.tier1]
    .filter((n) => n !== league.your_team);
  const arr = []; let oi = 0;
  for (let s = 1; s <= league.teams; s++) {
    arr.push(s === YOU ? league.your_team : others[oi++]);
  }
  return arr;
})();

/* keepers renew annually; 2025's keepers plus the master-doc decision for you */
const KEEPERS = {
  "Dumpsterfire Igles": "Jonathan Taylor",
  "Show Us Your TDs": "Josh Allen",
  "Margo's Blackmagicwomen": "Puka Nacua",
  "Nate's Jive Turkeys": "Derrick Henry",
  "Kay's Cuties": "Lamar Jackson",
  "Ern's Tightwads": "Jalen Hurts",
  "Russmans' Rappers": "Kyren Williams",
  "Nick's Bluemeanies": "Christian McCaffrey",
  "steeltown punishers": "Bijan Robinson",
  "Rich's Rednecks": "Justin Jefferson",
  "Jeff's Mojos": "Ja'Marr Chase",
  "Nick jr Nighthawks": "Jahmyr Gibbs",
};

/* ---------------- the pool, valued for this league ----------------------- */
const skill = bundle.players.map((p) => ({
  id: p.draftmark_id, name: p.name, position: p.position, team: p.team,
  bye: (bundle.teams[p.team] || {}).bye, td_model: p.td_model,
  yardage_model: p.yardage_model, availability: p.availability,
}));
const { values } = intel.computeValues(skill, league);
const tiers = intel.detectTiers(skill, values, league);
const dsts = bundle.dst.filter((d) => d.model).map((d) => ({
  id: "dst_" + d.team, name: d.team + " D/ST", position: "DST", team: d.team,
  bye: (bundle.teams[d.team] || {}).bye, mean: d.model.mean, sd: d.model.sd, val: 0 }));
const ks = bundle.kickers.filter((k) => k.model).map((k) => ({
  id: k.draftmark_id, name: k.name, position: "K", team: k.team,
  bye: (bundle.teams[k.team] || {}).bye, mean: k.model.mean, sd: k.model.sd, val: 0 }));

// D/ST and K need VOR on the SAME scale as skill players, or they sort above
// every negative-VOR player and the draft takes them absurdly early.
const REG = league.schedule.regular_season_weeks[1] - league.schedule.regular_season_weeks[0] + 1;
function withVor(list, replIdx) {
  const scored = list.map((p) => ({ ...p, es: p.mean * REG }))
                     .sort((a, b) => b.es - a.es);
  const repl = scored[Math.min(replIdx - 1, scored.length - 1)].es;
  return scored.map((p) => ({ ...p, val: p.es - repl }));
}
const POOL = [
  ...skill.map((p) => ({ ...p, val: values.get(p.id) ? values.get(p.id).vor : null,
                         es: values.get(p.id) ? values.get(p.id).es : null,
                         tier: tiers.get(p.id) || null })),
  ...withVor(dsts, league.replacement_levels.DST || 12),
  ...withVor(ks, league.replacement_levels.K || 12),
].sort((a, b) => (b.val ?? -1e6) - (a.val ?? -1e6));
const BY_ID = Object.fromEntries(POOL.map((p) => [p.id, p]));
const byName = {};
for (const p of POOL) byName[p.name] = p;
const posOf = (id) => (BY_ID[id] ? BY_ID[id].position : "?");
const toSimEntry = (id) => {
  const p = BY_ID[id];
  if (!p) return null;
  if (p.position === "DST" || p.position === "K")
    return { id, kind: "dstk", position: p.position, team: p.team, bye: p.bye, mean: p.mean, sd: p.sd };
  return { id, kind: "skill", position: p.position, team: p.team, bye: p.bye,
           td_model: p.td_model, yardage_model: p.yardage_model, availability: p.availability };
};

/* ---------------- timing map: slot -> measured tendencies ---------------- */
const timing = { _kdstFloor: profiles.earliest_K || 7 };
const slotTiers = {};
const T1 = new Set(league.divisions.tier1);
SLOT_TEAMS.forEach((name, i) => {
  const slot = i + 1;
  slotTiers[slot] = T1.has(name) ? 1 : 2;
  const mp = profiles.managers[name];
  if (mp) timing[slot] = { QB: mp.first_QB, K: mp.first_K, DST: mp.first_DST };
});

/* ---------------- build the board ---------------------------------------- */
const cells = core.generateOrder(league.teams, league.draft.rounds);
const rosters = {}; for (let s = 1; s <= 12; s++) rosters[s] = [];
const taken = new Set();
const keeperBySlot = {};
SLOT_TEAMS.forEach((name, i) => {
  const kn = KEEPERS[name];
  const p = kn ? byName[kn] : null;
  if (p) { keeperBySlot[i + 1] = p.id; rosters[i + 1].push(p.id); taken.add(p.id); }
});

console.log("=".repeat(78));
console.log("DRAFT ORDER & KEEPERS");
console.log("=".repeat(78));
SLOT_TEAMS.forEach((n, i) => {
  const k = KEEPERS[n];
  console.log(`  ${String(i + 1).padStart(2)}. ${n.padEnd(26)}${i + 1 === YOU ? "  <-- YOU" : "        "}  keeper: ${k || "(none)"}`);
});

/* remaining cells after keepers consume round 1 */
const openCells = cells.filter((c) => !(c.round === 1 && keeperBySlot[c.slot]))
  .map((c) => ({ slot: c.slot, round: c.round, overall: c.overall }));

/* ---------------- run the draft ------------------------------------------ */
const rng = sim.makeRng(20260722);
const myPicks = [];
let forcedRB = true;

function legalFor(slot, p, round) {
  const c = {};
  for (const id of rosters[slot]) { const q = posOf(id); c[q] = (c[q] || 0) + 1; }
  if ((c[p.position] || 0) >= (league.roster.position_max[p.position] ?? 99)) return false;
  if ((p.position === "K" || p.position === "DST") && round < timing._kdstFloor) return false;
  // your own lineup-completion funnel
  if (slot === YOU) {
    const need = new Set(); let empty = 0;
    for (const [pos, n] of Object.entries(league.roster.starters)) {
      const have = Math.min(c[pos] || 0, n);
      if (have < n) { need.add(pos); empty += n - have; }
    }
    const remaining = openCells.filter((x) => x.slot === YOU && !x._done).length;
    if (empty > 0 && remaining <= empty && !need.has(p.position)) return false;
  }
  return true;
}

console.log("\n" + "=".repeat(78));
console.log("RUNNING THE DRAFT — opponents use measured tendencies, you use the recommender");
console.log("=".repeat(78));

const t0 = Date.now();
for (const cell of openCells) {
  const slot = cell.slot, round = cell.round;
  const avail = POOL.filter((p) => !taken.has(p.id) && legalFor(slot, p, round));
  if (!avail.length) { cell._done = true; continue; }

  let pick = null, why = "";
  if (slot === YOU) {
    if (forcedRB) {
      pick = avail.find((p) => p.position === "RB");
      why = "FORCED: best available RB (your instruction)";
      forcedRB = false;
    } else {
      // full recommender: candidates -> CRN season sims -> argmax title odds
      const remainingCells = openCells.filter((x) => !x._done);
      const ctx = { openCells: remainingCells, startRosters: rosters, pool: avail,
                    yourSlot: YOU, cfg: league, posOf, toSimEntry, slotTiers, timing };
      const cands = rec.selectCandidates(remainingCells, rosters, avail, YOU,
                                         league, posOf, [], 5, timing);
      if (cands.length) {
        const acc = rec.initAccumulator(cands);
        // several small batches, not two large ones: the paired-delta noise
        // estimate needs multiple independent batches to work
        const NB = 6;
        for (let b = 0; b < NB; b++) rec.evaluateBatch(ctx, acc, Math.round(SEASONS_PER_CAND / NB), b);
        const v = rec.verdict(acc, ctx);
        if (v && v.decisive) {
          pick = BY_ID[acc.candidates[0].id];
          why = `sim: +${v.edgePct.toFixed(1)}% title odds over ${v.runnerName} — ${v.because}`;
        } else {
          // inside the noise floor: defer to the value board rather than
          // chase Monte Carlo noise (master doc VII.3)
          // MARGINAL value, not raw VOR: you start one QB, so a second one is
          // a bench asset worth a fraction of its standalone value.
          const cnt = {};
          for (const id of rosters[YOU]) { const q = posOf(id); cnt[q] = (cnt[q] || 0) + 1; }
          const urg = rec.positionUrgency(avail, 3);
          const marginal = (pl) => rec.marginalValue(pl, cnt, league.roster.starters, urg);
          const best = acc.candidates.map((c) => BY_ID[c.id])
            .sort((a, b) => marginal(b) - marginal(a))[0];
          pick = best;
          why = `sim within noise (±${v ? v.noisePct.toFixed(2) : "?"}%) — value board: ` +
                `VOR ${best.val >= 0 ? "+" : ""}${(best.val ?? 0).toFixed(0)}`;
        }
      } else { pick = avail[0]; why = "best available"; }
    }
    myPicks.push({ overall: cell.overall, round, player: pick, why });
    console.log(`  ${String(cell.overall).padStart(3)} (R${String(round).padStart(2)})  YOU -> ${pick.position} ${pick.name}`);
    console.log(`            ${why}`);
  } else {
    // opponent: greedy value + roster need, penalised for drafting a position
    // earlier than this manager historically does
    const c = {};
    for (const id of rosters[slot]) { const q = posOf(id); c[q] = (c[q] || 0) + 1; }
    const need = new Set();
    for (const [pos, n] of Object.entries(league.roster.starters))
      if ((c[pos] || 0) < n) need.add(pos);
    const tp = timing[slot] || {};
    const urgO = rec.positionUrgency(avail, 3);
    const scored = avail.slice(0, 40).map((p) => {
      const want = tp[p.position];
      const early = (want && round < want) ? 12 * (want - round) : 0;
      return [p, rec.marginalValue(p, c, league.roster.starters, urgO) - early];
    }).sort((a, b) => b[1] - a[1]);
    const u = rng();
    const k = u < 0.6 ? 0 : u < 0.85 ? 1 : 2;
    pick = scored[Math.min(k, scored.length - 1)][0];
  }
  taken.add(pick.id);
  rosters[slot].push(pick.id);
  cell._done = true;
}
console.log(`\n  [draft simulated in ${((Date.now() - t0) / 1000).toFixed(1)}s]`);

/* ---------------- your roster --------------------------------------------- */
console.log("\n" + "=".repeat(78));
console.log("YOUR TEAM — Dumpsterfire Igles");
console.log("=".repeat(78));
const mine = rosters[YOU].map((id) => BY_ID[id]);
const byPos = {};
for (const p of mine) (byPos[p.position] = byPos[p.position] || []).push(p);
for (const pos of ["QB", "RB", "WR", "TE", "DST", "K"]) {
  const list = byPos[pos] || [];
  const start = league.roster.starters[pos] || 0;
  list.forEach((p, i) => {
    const tag = i < start ? "START " : "bench ";
    const v = values.get(p.id);
    console.log(`  ${tag} ${pos.padEnd(4)} ${p.name.padEnd(24)} ${p.team || ""}`.padEnd(50) +
      (v ? `E ${v.es.toFixed(0).padStart(3)}  VOR ${v.vor >= 0 ? "+" : ""}${v.vor.toFixed(0)}` : ""));
  });
}

/* ---------------- season simulation --------------------------------------- */
console.log("\n" + "=".repeat(78));
console.log("SEASON SIMULATION — 4,000 seasons on these twelve rosters");
console.log("=".repeat(78));
const all = []; const simRosters = {};
for (let s = 1; s <= 12; s++) {
  simRosters[s] = [];
  for (const id of rosters[s]) {
    const e = toSimEntry(id);
    if (!e) continue;
    simRosters[s].push(all.length); all.push(e);
  }
}
const prepared = sim.prepareSimPlayers(all, league);
const t1 = Date.now();
const res = sim.runChampionshipSim(simRosters, prepared, league, slotTiers,
                                   { seasons: 4000, seed: 7777 });
const rows = [];
for (let s = 1; s <= 12; s++) rows.push([s, SLOT_TEAMS[s - 1], res.titles[s], res.playoffs[s]]);
rows.sort((a, b) => b[2] - a[2]);
console.log(`  ${"".padEnd(4)}${"team".padEnd(28)}${"title".padStart(8)}${"playoffs".padStart(11)}`);
rows.forEach(([s, name, t, po], i) => {
  const mark = s === YOU ? "  <-- YOU" : "";
  console.log(`  ${String(i + 1).padStart(2)}. ${name.padEnd(28)}${(t * 100).toFixed(1).padStart(6)}%${(po * 100).toFixed(1).padStart(10)}%${mark}`);
});
const yourRank = rows.findIndex((r) => r[0] === YOU) + 1;
console.log(`\n  You finish ${yourRank}${["st","nd","rd"][yourRank-1]||"th"} of 12 in championship probability ` +
            `(${(res.titles[YOU] * 100).toFixed(1)}%, league average 8.3%)`);
console.log(`  [${((Date.now() - t1) / 1000).toFixed(1)}s]`);
