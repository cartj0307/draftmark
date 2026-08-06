"use strict";
/**
 * Who is actually likely to be there when you pick?
 *
 * One mock draft answers "who was available in this sample". That is not the
 * question. Running many drafts with different randomness answers "how often
 * does this player survive to my pick" — which is what you plan around, and
 * which no hand-run mock can give you because you cannot re-roll your own bias.
 *
 * Opponents pick from the value board nudged by their MEASURED tendencies.
 * Your picks follow marginal value so the board keeps moving realistically.
 */

const fs = require("fs");
const path = require("path");
const dist = require("../src/distributions.js");
const intel = require("../src/intel.js");
const sim = require("../src/sim.js");
const core = require("../src/draft_core.js");
intel.useGammaSurvival(dist.gammaSurvival);

const ROOT = path.join(__dirname, "..");
const league = JSON.parse(fs.readFileSync(path.join(ROOT, "config/league.json"), "utf8"));
const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, "data/bundle.json"), "utf8"));
const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, "data/league/manager_profiles.json"), "utf8"));
const YOU = league.your_slot;
const RUNS = +(process.env.RUNS || 200);

const skill = bundle.players.map((p) => ({
  id: p.draftmark_id, name: p.name, position: p.position, team: p.team,
  td_model: p.td_model, yardage_model: p.yardage_model, availability: p.availability }));
const { values } = intel.computeValues(skill, league);
const REG = league.schedule.regular_season_weeks[1] - league.schedule.regular_season_weeks[0] + 1;
function withVor(list, replIdx) {
  const s = list.map((p) => ({ ...p, es: p.mean * REG })).sort((a, b) => b.es - a.es);
  const repl = s[Math.min(replIdx - 1, s.length - 1)].es;
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
const timing = {}; const KDST_FLOOR = profiles.earliest_K || 7;
SLOT_TEAMS.forEach((n, i) => {
  const mp = profiles.managers[n];
  if (mp) timing[i + 1] = { QB: mp.first_QB, K: mp.first_K, DST: mp.first_DST };
});

const cells = core.generateOrder(league.teams, league.draft.rounds);
const MY_PICKS = league.draft.your_overall_picks;
const TRACK = MY_PICKS.slice(0, 6);   // 23, 26, 47, 50, 71, 74

/* availableAt[overall][playerId] = times survived */
const surv = {}; for (const o of TRACK) surv[o] = {};

for (let run = 0; run < RUNS; run++) {
  const rng = sim.makeRng(1000 + run * 7919);
  const rosters = {}; for (let s = 1; s <= 12; s++) rosters[s] = [];
  const taken = new Set(); const keeperSlot = {};
  SLOT_TEAMS.forEach((n, i) => {
    const p = byName[KEEPERS[n]];
    if (p) { keeperSlot[i + 1] = p.id; rosters[i + 1].push(p.id); taken.add(p.id); }
  });
  const open = cells.filter((c) => !(c.round === 1 && keeperSlot[c.slot]));

  for (const cell of open) {
    const slot = cell.slot, round = cell.round;
    const cnt = {};
    for (const id of rosters[slot]) { const q = posOf(id); cnt[q] = (cnt[q] || 0) + 1; }
    const need = new Set();
    for (const [pos, n] of Object.entries(league.roster.starters))
      if ((cnt[pos] || 0) < n) need.add(pos);
    const remaining = open.filter((x) => x.slot === slot && x.overall >= cell.overall).length;
    let emptySeats = 0;
    for (const [pos, n] of Object.entries(league.roster.starters))
      emptySeats += Math.max(0, n - Math.min(cnt[pos] || 0, n));
    const funnel = emptySeats > 0 && remaining <= emptySeats;

    const avail = [];
    for (const p of POOL) {
      if (taken.has(p.id)) continue;
      if ((cnt[p.position] || 0) >= (league.roster.position_max[p.position] ?? 99)) continue;
      if ((p.position === "K" || p.position === "DST") && round < KDST_FLOOR) continue;
      if (funnel && !need.has(p.position)) continue;
      avail.push(p);
      if (avail.length >= 60) break;
    }
    if (!avail.length) continue;

    if (slot === YOU && surv[cell.overall]) {
      for (const p of avail.slice(0, 30)) {
        surv[cell.overall][p.id] = (surv[cell.overall][p.id] || 0) + 1;
      }
    }

    const tp = timing[slot] || {};
    const scored = avail.map((p) => {
      const have = cnt[p.position] || 0;
      const st = league.roster.starters[p.position] || 0;
      const mult = have < st ? 1.0 : have === st ? 0.25 : 0.10;
      const want = tp[p.position];
      const early = (want && round < want && slot !== YOU) ? 12 * (want - round) : 0;
      return [p, (p.val ?? -1e6) * mult + (have < st ? 8 : 0) - early];
    }).sort((a, b) => b[1] - a[1]);
    const u = rng();
    const k = slot === YOU ? 0 : (u < 0.6 ? 0 : u < 0.85 ? 1 : 2);
    const pick = scored[Math.min(k, scored.length - 1)][0];
    taken.add(pick.id); rosters[slot].push(pick.id);
  }
}

console.log("=".repeat(76));
console.log(`WHO SURVIVES TO YOUR PICKS — ${RUNS} simulated drafts`);
console.log("=".repeat(76));
console.log("Opponents use their measured QB/K/DST timing; everything else is the");
console.log("value board plus roster need. Percentages = how often that player was");
console.log("still on the board when you were on the clock.\n");

for (const o of TRACK) {
  const rnd = cells.find((c) => c.overall === o).round;
  const rows = Object.entries(surv[o])
    .map(([id, n]) => [BY_ID[id], n / RUNS])
    .filter(([p]) => p)
    .sort((a, b) => (b[0].val ?? -1e6) - (a[0].val ?? -1e6))
    .slice(0, 12);
  console.log(`── PICK ${o} (round ${rnd}) ${"─".repeat(46)}`);
  for (const [p, prob] of rows) {
    const bar = "█".repeat(Math.round(prob * 20)).padEnd(20, "·");
    console.log(`   ${p.position.padEnd(4)} ${p.name.padEnd(24)} VOR ${(p.val ?? 0) >= 0 ? "+" : ""}${(p.val ?? 0).toFixed(0).padStart(3)}  ${bar} ${(prob * 100).toFixed(0)}%`);
  }
  console.log("");
}
