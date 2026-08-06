"use strict";

const fs = require("fs");
const path = require("path");
const dist = require("../src/distributions.js");
const intel = require("../src/intel.js");
intel.useGammaSurvival(dist.gammaSurvival);

const ROOT = path.join(__dirname, "..");
const league = JSON.parse(fs.readFileSync(path.join(ROOT, "config/league.json"), "utf8"));
const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, "data/bundle.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const players = bundle.players.map((p) => ({
  id: p.draftmark_id, name: p.name, position: p.position, team: p.team,
  td_model: p.td_model, yardage_model: p.yardage_model, availability: p.availability,
  adp: p.priors.adp, adp_sd: p.priors.adp_sd,
}));
const byName = Object.fromEntries(players.map((p) => [p.name, p]));

// ---- survival-sum sanity against Monte Carlo (through the real engine) ----
{
  const { score } = require("../src/scoring.js");
  const jt = byName["Jonathan Taylor"];
  const lam = jt.td_model.lambda_base;
  const ew = intel.expectedWeek(jt, lam, league.scoring);
  // MC: sample stat lines, score through scoring.js
  const rng = (() => { let s = 42 >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; }; })();
  const N = 60000;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const n = dist.sampleNegBin(lam, jt.td_model.dispersion, rng);
    const ry = jt.yardage_model.rush ? dist.sampleGamma(jt.yardage_model.rush.shape, jt.yardage_model.rush.scale, rng) : 0;
    const cy = jt.yardage_model.rec ? dist.sampleGamma(jt.yardage_model.rec.shape, jt.yardage_model.rec.scale, rng) : 0;
    // split TDs between rush/rec doesn't matter: both pay 6
    sum += score({ rushYds: Math.round(ry), recYds: Math.round(cy), rushTD: n }, league);
  }
  const mc = sum / N;
  ok(`survival-sum matches MC through scoring.js (analytic ${ew.toFixed(2)} vs MC ${mc.toFixed(2)})`,
     Math.abs(ew - mc) < 0.15, `${ew} vs ${mc}`);
}

// ---- values ----
const { values, replacement } = intel.computeValues(players, league);
ok("every modeled player has E[F_season]", values.size === players.length);
const jtv = values.get(byName["Jonathan Taylor"].id);
ok("Taylor E[F_season] in a sane band (100-220)", jtv.es > 100 && jtv.es < 220, jtv.es.toFixed(1));
ok("replacement levels exist for QB/RB/WR/TE",
   ["QB", "RB", "WR", "TE"].every((p) => replacement[p] > 0));

// V.7 spot-check: a goal-line RB beats a higher-target possession WR in VOR terms
{
  const rbs = players.filter((p) => p.position === "RB").sort((a, b) => values.get(b.id).vor - values.get(a.id).vor);
  ok("top VOR RB clears +40 over replacement", values.get(rbs[0].id).vor > 40,
     `${rbs[0].name} ${values.get(rbs[0].id).vor.toFixed(1)}`);
  const wrs = players.filter((p) => p.position === "WR").sort((a, b) => values.get(b.id).vor - values.get(a.id).vor);
  // TD-lottery scoring compresses WR VOR relative to RB (V.2)
  ok("RB1 VOR exceeds WR1 VOR (format stretches RB, compresses WR)",
     values.get(rbs[0].id).vor > values.get(wrs[0].id).vor,
     `RB1 ${values.get(rbs[0].id).vor.toFixed(1)} vs WR1 ${values.get(wrs[0].id).vor.toFixed(1)}`);
}

// ---- tiers ----
const tiers = intel.detectTiers(players, values, league);
{
  const rbs = players.filter((p) => p.position === "RB")
    .sort((a, b) => values.get(b.id).vor - values.get(a.id).vor);
  const t = rbs.slice(0, 30).map((p) => tiers.get(p.id));
  ok("tiers are monotone non-decreasing down the board",
     t.every((x, i) => i === 0 || x >= t[i - 1]), t.join(","));
  ok("top 30 RBs split into 2-7 tiers", new Set(t).size >= 2 && new Set(t).size <= 7, String(new Set(t).size));
}

// ---- ADP survival: graceful degradation + math when present ----
ok("survival is null without ADP (pending ESPN ingest)",
   intel.survivalProb(byName["Jonathan Taylor"], 23) === null);
{
  const fake = { adp: 20, adp_sd: null };
  const s10 = intel.survivalProb(fake, 10), s20 = intel.survivalProb(fake, 20), s35 = intel.survivalProb(fake, 35);
  ok("survival monotone decreasing in pick number", s10 > s20 && s20 > s35, `${s10} ${s20} ${s35}`);
  ok("survival ~50% at own ADP", Math.abs(s20 - 0.5) < 0.01, String(s20));
}

// ---- VONA: with synthetic ADP, the cliff position surfaces ----
{
  const mini = [
    { id: "a", name: "RB A", position: "RB", adp: 5, adp_sd: 3, td_model: {}, },
    { id: "b", name: "RB B", position: "RB", adp: 40, adp_sd: 8, td_model: {}, },
    { id: "c", name: "WR C", position: "WR", adp: 30, adp_sd: 8, td_model: {}, },
    { id: "d", name: "WR D", position: "WR", adp: 33, adp_sd: 8, td_model: {}, },
  ];
  const vals = new Map([["a", { es: 150, vor: 60 }], ["b", { es: 100, vor: 10 }],
                        ["c", { es: 120, vor: 30 }], ["d", { es: 118, vor: 28 }]]);
  const vona = intel.vonaByPosition(mini, vals, 24);
  ok("RB cliff > WR cliff when RB2 is far and WRs are deep",
     vona.RB.vona > vona.WR.vona, JSON.stringify(vona));
  ok("VONA null without nextPick", intel.vonaByPosition(mini, vals, null).RB.vona === null);
}

// ---- playoff tilt exists and is small (a tiebreaker, not a driver) ----
{
  const t = intel.playoffTilt(byName["Jonathan Taylor"], league);
  ok("playoff tilt computes and is modest (|t| < 25%)", t !== null && Math.abs(t) < 0.25, String(t));
}

// ---- the QB fix: passing points flow through ----
{
  const qbs = players.filter((p) => p.position === "QB")
    .sort((a, b) => values.get(b.id).es - values.get(a.id).es);
  const top = qbs[0];
  ok("top QB carries pass_td_pg in the bundle", top.td_model.pass_td_pg > 0.8, `${top.name} ${top.td_model.pass_td_pg}`);
  ok("top QB E[F_season] beats top RB replacement comfortably",
     values.get(top.id).es > replacement.RB + 40, `${top.name} ${values.get(top.id).es.toFixed(1)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
