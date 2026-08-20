"use strict";

/* Headless auto-draft: every seat, including yours, drafted by the recommender.
 *
 *   node build/auto_draft.js                    one mock, pro preset
 *   MOCKS=5 node build/auto_draft.js            five mocks, different seeds
 *   PRESET=realistic node build/auto_draft.js   mirror measured manager timing
 *   SEASONS=2000 node build/auto_draft.js       title odds on the finished rosters
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
const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, "data/league/manager_profiles.json"), "utf8"));

const YOU = league.your_slot;
const MOCKS = +(process.env.MOCKS || 1);
const PRESET = process.env.PRESET || "pro";
const SEASONS = +(process.env.SEASONS || 0);

/* ---------------- pool, valued for this league --------------------------- */
const skill = bundle.players.map((p) => ({
  id: p.draftmark_id, name: p.name, position: p.position, team: p.team,
  bye: (bundle.teams[p.team] || {}).bye, td_model: p.td_model,
  yardage_model: p.yardage_model, availability: p.availability,
}));
const { values } = intel.computeValues(skill, league);
const tiers = intel.detectTiers(skill, values, league);
const dsts = bundle.dst.filter((d) => d.model).map((d) => ({
  id: "dst_" + d.team, name: d.team + " D/ST", position: "DST", team: d.team,
  bye: (bundle.teams[d.team] || {}).bye, mean: d.model.mean, sd: d.model.sd }));
const ks = bundle.kickers.filter((k) => k.model).map((k) => ({
  id: k.draftmark_id, name: k.name, position: "K", team: k.team,
  bye: (bundle.teams[k.team] || {}).bye, mean: k.model.mean, sd: k.model.sd }));

const REG = league.schedule.regular_season_weeks[1] - league.schedule.regular_season_weeks[0] + 1;
function withVor(list, replIdx) {
  const scored = list.map((p) => ({ ...p, es: p.mean * REG })).sort((a, b) => b.es - a.es);
  const repl = scored[Math.min(replIdx - 1, scored.length - 1)].es;
  return scored.map((p) => ({ ...p, val: p.es - repl }));
}
const POOL = [
  ...skill.map((p) => ({ ...p, val: values.get(p.id) ? values.get(p.id).vor : null,
                         tier: tiers.get(p.id) || null })),
  ...withVor(dsts, league.replacement_levels.DST || 12),
  ...withVor(ks, league.replacement_levels.K || 12),
].filter((p) => p.val != null).sort((a, b) => b.val - a.val);

const BY_ID = Object.fromEntries(POOL.map((p) => [p.id, p]));
const byName = {};
for (const p of POOL) byName[p.name] = p;
const posOf = (id) => (BY_ID[id] ? BY_ID[id].position : "?");
const byeOf = (id) => (BY_ID[id] ? BY_ID[id].bye : null);
const valOf = (id) => (BY_ID[id] ? BY_ID[id].val : 0);
const toSimEntry = (id) => {
  const p = BY_ID[id];
  if (!p) return null;
  if (p.position === "DST" || p.position === "K")
    return { id, kind: "dstk", position: p.position, team: p.team, bye: p.bye, mean: p.mean, sd: p.sd };
  return { id, kind: "skill", position: p.position, team: p.team, bye: p.bye,
           td_model: p.td_model, yardage_model: p.yardage_model, availability: p.availability };
};

/* ---------------- seats, keepers, timing --------------------------------- */
const SLOT_TEAMS = process.env.ORDER ? JSON.parse(process.env.ORDER) : (() => {
  const others = [...league.divisions.tier2, ...league.divisions.tier1]
    .filter((n) => n !== league.your_team);
  const arr = []; let oi = 0;
  for (let s = 1; s <= league.teams; s++) arr.push(s === YOU ? league.your_team : others[oi++]);
  return arr;
})();

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

const timing = { _kdstFloor: profiles.earliest_K || 7 };
const slotTiers = {};
const T1 = new Set(league.divisions.tier1);
SLOT_TEAMS.forEach((name, i) => {
  const slot = i + 1;
  slotTiers[slot] = T1.has(name) ? 1 : 2;
  const mp = profiles.managers[name];
  if (mp) timing[slot] = { QB: mp.first_QB, K: mp.first_K, DST: mp.first_DST };
});

const cells = core.generateOrder(league.teams, league.draft.rounds);

/* ---------------- one mock ------------------------------------------------ */
function runMock(seedBase) {
  const rosters = {}; for (let s = 1; s <= league.teams; s++) rosters[s] = [];
  const taken = new Set();
  const keeperBySlot = {};
  SLOT_TEAMS.forEach((name, i) => {
    const p = KEEPERS[name] ? byName[KEEPERS[name]] : null;
    if (p) { keeperBySlot[i + 1] = p.id; rosters[i + 1].push(p.id); taken.add(p.id); }
  });

  let openCells = cells.filter((c) => !(c.round === 1 && keeperBySlot[c.slot]))
    .map((c) => ({ slot: c.slot, round: c.round, overall: c.overall }));

  const log = [];
  const youAvail = {};              // your overall -> top available at that moment
  const t0 = Date.now();
  while (openCells.length) {
    const pool = POOL.filter((p) => !taken.has(p.id));
    if (openCells[0].slot === YOU) {
      const per = {};
      const keep = [];
      for (const p of pool) {                 // pool is value-sorted
        per[p.position] = (per[p.position] || 0) + 1;
        if (per[p.position] <= 6) keep.push(p);
      }
      youAvail[openCells[0].overall] = keep;
    }
    const res = auto.autoPick(
      { openCells, rosters, pool, cfg: league, posOf, timing, byeOf, valOf },
      { preset: PRESET, seed: seedBase + openCells[0].overall * 7919 });
    if (!res) break;
    taken.add(res.player.id);
    rosters[res.slot].push(res.player.id);
    log.push(res);
    openCells = openCells.slice(1);
  }
  return { rosters, log, youAvail, ms: Date.now() - t0, keeperBySlot };
}

/* ---------------- report -------------------------------------------------- */
function starterCheck(ids) {
  const c = {};
  for (const id of ids) { const q = posOf(id); c[q] = (c[q] || 0) + 1; }
  const miss = [];
  for (const [pos, n] of Object.entries(league.roster.starters)) {
    if ((c[pos] || 0) < n) miss.push(`${pos}${n > 1 ? " x" + n : ""}`);
  }
  return miss;
}

const AGG = { avail: {}, took: {}, odds: [] };
const QUIET = MOCKS > 3 && !process.env.VERBOSE;

for (let m = 0; m < MOCKS; m++) {
  const seed = 20260820 + m * 104729;
  const { rosters, log, youAvail, ms } = runMock(seed);

  for (const [ov, list] of Object.entries(youAvail)) {
    const bucket = AGG.avail[ov] = AGG.avail[ov] || {};
    for (const p of list) {
      const k = `${p.position}|${p.name}`;
      bucket[k] = (bucket[k] || 0) + 1;
    }
  }
  for (const r of log.filter((x) => x.slot === YOU)) {
    const b = AGG.took[r.overall] = AGG.took[r.overall] || {};
    const k = `${r.player.position}|${r.player.name}`;
    b[k] = (b[k] || 0) + 1;
  }

  if (QUIET) {
    process.stdout.write(`  mock ${m + 1}/${MOCKS} done\r`);
    if (SEASONS > 0) recordOdds(rosters, m);
    continue;
  }
  console.log("=".repeat(78));
  console.log(`MOCK ${m + 1}  ·  preset=${PRESET}  ·  ${(ms / 1000).toFixed(1)}s  ·  ${log.length} picks`);
  console.log("=".repeat(78));

  console.log("\nYOUR BOARD (slot " + YOU + ")");
  for (const r of log.filter((x) => x.slot === YOU)) {
    console.log(`  ${String(r.overall).padStart(3)} R${String(r.round).padStart(2)}  ` +
      `${r.player.position.padEnd(3)} ${r.player.name.padEnd(24)} ${r.why}`);
  }

  console.log("\nWHAT FELL PAST YOU (top value taken between your picks)");
  const yourOveralls = log.filter((x) => x.slot === YOU).map((x) => x.overall);
  for (let i = 0; i < yourOveralls.length - 1; i++) {
    const a = yourOveralls[i], b = yourOveralls[i + 1];
    const between = log.filter((x) => x.overall > a && x.overall < b)
      .sort((p, q) => (q.player.val ?? 0) - (p.player.val ?? 0)).slice(0, 3);
    if (between.length) {
      console.log(`  ${a} -> ${b}: ` + between.map((x) =>
        `${x.player.name} (${x.player.position})`).join(", "));
    }
  }

  console.log("\nROSTER INTEGRITY");
  let bad = 0;
  for (let s = 1; s <= league.teams; s++) {
    const miss = starterCheck(rosters[s]);
    const c = {};
    for (const id of rosters[s]) { const q = posOf(id); c[q] = (c[q] || 0) + 1; }
    const shape = ["QB", "RB", "WR", "TE", "K", "DST"].map((p) => `${p}${c[p] || 0}`).join(" ");
    if (miss.length) bad++;
    console.log(`  ${String(s).padStart(2)} ${SLOT_TEAMS[s - 1].padEnd(26)} ${shape}` +
      (miss.length ? `   INCOMPLETE: missing ${miss.join(", ")}` : ""));
  }
  console.log(bad ? `  ${bad} incomplete roster(s)` : "  all 12 lineups complete");

  if (SEASONS > 0) {
    const all = []; const simRosters = {};
    for (const [s, ids] of Object.entries(rosters)) {
      simRosters[s] = [];
      for (const id of ids) {
        const e = toSimEntry(id);
        if (!e) continue;
        simRosters[s].push(all.length); all.push(e);
      }
    }
    const prepared = sim.prepareSimPlayers(all, league);
    const res = sim.runChampionshipSim(simRosters, prepared, league, slotTiers,
                                       { seasons: SEASONS, seed: 4242 + m });
    console.log(`\nTITLE ODDS (${SEASONS.toLocaleString()} seasons)`);
    const rows = Object.entries(res.titles)
      .map(([s, p]) => [+s, p]).sort((a, b) => b[1] - a[1]);
    for (const [s, p] of rows) {
      console.log(`  ${(p * 100).toFixed(1).padStart(5)}%  ${SLOT_TEAMS[s - 1]}` +
        (s === YOU ? "   <-- YOU" : ""));
    }
  }
  console.log("");
}


function recordOdds(rosters, m) {
  const all = []; const simRosters = {};
  for (const [s, ids] of Object.entries(rosters)) {
    simRosters[s] = [];
    for (const id of ids) {
      const e = toSimEntry(id);
      if (!e) continue;
      simRosters[s].push(all.length); all.push(e);
    }
  }
  const prepared = sim.prepareSimPlayers(all, league);
  const res = sim.runChampionshipSim(simRosters, prepared, league, slotTiers,
                                     { seasons: SEASONS, seed: 4242 + m });
  AGG.odds.push(res.titles[YOU] || 0);
}

if (QUIET) {
  const roundOf = {};
  for (const c of cells) roundOf[c.overall] = c.round;
  console.log("\n" + "=".repeat(78));
  console.log(`WHAT REACHES SLOT ${YOU} — ${MOCKS} mocks, preset=${PRESET}`);
  console.log("=".repeat(78));
  console.log("  % is how often that player was still on the board at that pick.\n");

  const POS_ORDER = ["RB", "WR", "TE", "QB", "K", "DST"];
  for (const ov of Object.keys(AGG.avail).map(Number).sort((a, b) => a - b)) {
    const bucket = AGG.avail[ov];
    const round = roundOf[ov];
    const byPos = {};
    for (const [k, n] of Object.entries(bucket)) {
      const [pos, name] = k.split("|");
      (byPos[pos] = byPos[pos] || []).push([name, n / MOCKS]);
    }
    console.log(`  PICK ${ov} (round ${round})`);
    for (const pos of POS_ORDER) {
      /* kickers and defenses are noise until the rounds you would actually
       * spend a pick on one */
      if ((pos === "K" || pos === "DST") && round < 12) continue;
      const rows = (byPos[pos] || []).sort((a, b) => b[1] - a[1]).slice(0, 4);
      if (!rows.length) continue;
      console.log(`    ${pos.padEnd(4)} ` + rows.map(([n, f]) =>
        `${n} ${(f * 100).toFixed(0)}%`).join(" · "));
    }
    const took = Object.entries(AGG.took[ov] || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (took.length) console.log(`    took  ` +
      took.map(([k, n]) => `${k.split("|")[1]} (${n}/${MOCKS})`).join(" · "));
    console.log("");
  }

  if (AGG.odds.length) {
    const mean = AGG.odds.reduce((a, b) => a + b, 0) / AGG.odds.length;
    const lo = Math.min(...AGG.odds), hi = Math.max(...AGG.odds);
    console.log(`  YOUR TITLE ODDS across ${AGG.odds.length} auto-drafted rosters: ` +
      `${(mean * 100).toFixed(1)}% mean, ${(lo * 100).toFixed(1)}%–${(hi * 100).toFixed(1)}% range`);
    console.log(`  (a 12-team league averages 8.3%)`);
  }
}
