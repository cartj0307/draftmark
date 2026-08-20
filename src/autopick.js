"use strict";

/* Auto-draft: runs the F9 decision process for whichever team is on the clock.
 *
 * The opponent model inside recommend.js is deliberately cheap — it exists to
 * forecast what falls to you, not to build good rosters, so it is greedy value
 * plus a timing penalty. That is the wrong engine for a mock draft: the teams
 * it produces are worse than the league's real managers, which flatters your
 * roster in the season sim.
 *
 * This module instead points the full recommender at the on-clock slot:
 * simulate that team's next turn, price every player against what they could
 * still get then, filter to picks that are actually legal and coherent for
 * that roster, and sample from the top with a temperature dial so repeated
 * mocks differ without anyone taking a bad player.
 */

let A = null; // { survivalForecast, rankByVona, makeRng }

function configureAutopick(deps) { A = deps; }

/* temp is in value points: a player this far below the leader is chosen about
 * 37% as often. runs is how many futures the forecast simulates per pick. */
const PRESETS = {
  /* floors: the earliest round this preset will let a team take a K or D/ST.
   * "pro" ignores the measured league habit of reaching in round 7 — four
   * points of projected edge at kicker is not worth a bench body. */
  pro:       { temp: 0.75, runs: 60, topK: 4, respectTiming: false, kFloor: 14, dFloor: 13 },
  realistic: { temp: 2.50, runs: 45, topK: 6, respectTiming: true,  kFloor: 0,  dFloor: 0  },
  chaos:     { temp: 7.00, runs: 30, topK: 8, respectTiming: true,  kFloor: 0,  dFloor: 0  },
};


function countsFor(ids, posOf) {
  const c = {};
  for (const id of ids) { const q = posOf(id); c[q] = (c[q] || 0) + 1; }
  return c;
}

function seatState(counts, starters) {
  const need = new Set();
  let empty = 0;
  for (const [pos, n] of Object.entries(starters)) {
    const have = Math.min(counts[pos] || 0, n);
    if (have < n) { need.add(pos); empty += n - have; }
  }
  return { need, empty };
}

/* Legality for one slot at one moment. Everything here is a hard gate — the
 * scoring model never gets to trade any of it away. */
function makeLegal(slot, openCells, rosters, cfg, posOf, timing, opts) {
  const counts = countsFor(rosters[slot] || [], posOf);
  const starters = cfg.roster.starters;
  const mx = cfg.roster.position_max;
  const seats = seatState(counts, starters);
  const remaining = openCells.filter((c) => String(c.slot) === String(slot)).length;

  /* every team leaves the draft with a full starting lineup, not just you */
  const funnel = seats.empty > 0 && remaining <= seats.empty ? seats.need : null;

  const tp = (opts.respectTiming && timing && timing[slot]) || {};
  const globalFloor = (timing && timing._kdstFloor) || 1;
  const kFloor = Math.max(globalFloor, tp.K || 0, opts.kFloor || 0);
  const dFloor = Math.max(globalFloor, tp.DST || 0, opts.dFloor || 0);

  return function legal(p, round) {
    const have = counts[p.position] || 0;
    if (have >= (mx[p.position] ?? 99)) return false;
    /* nobody rosters a second kicker or a second defense in a 16-round draft,
     * whatever position_max technically allows */
    if (opts.singleKDST !== false && (p.position === "K" || p.position === "DST") && have >= 1) return false;
    if (p.position === "K" && round < kFloor) return false;
    if (p.position === "DST" && round < dFloor) return false;
    if (funnel && !funnel.has(p.position)) return false;
    return true;
  };
}

/* Valuation lives in recommend.js so the auto-drafter and the F9 surface can
 * never drift apart: whatever the board tells you is the right pick is the
 * same calculation every other team is running against you. */

/* A starting lineup with three players on the same bye loses that week outright.
 * Small, and only ever applied to seats that are actually starting seats. */
function byePenalty(p, rosterIds, byeOf, posOf, starters, weight) {
  if (!weight || !p.bye) return 0;
  let sameBye = 0;
  const seen = {};
  for (const id of rosterIds) {
    const q = posOf(id);
    const cap = starters[q] || 0;
    seen[q] = (seen[q] || 0) + 1;
    if (seen[q] > cap) continue;          // bench player, bye is free
    if (byeOf(id) === p.bye) sameBye++;
  }
  return sameBye >= 2 ? weight * (sameBye - 1) : 0;
}

function softmaxPick(cands, temp, rng) {
  if (!cands.length) return null;
  if (!temp || temp <= 0) return cands[0];
  const top = cands[0].adj;
  const w = cands.map((c) => Math.exp((c.adj - top) / temp));
  const total = w.reduce((a, b) => a + b, 0);
  let u = rng() * total;
  for (let i = 0; i < cands.length; i++) {
    u -= w[i];
    if (u <= 0) return cands[i];
  }
  return cands[cands.length - 1];
}

/**
 * Pick for the team currently on the clock.
 *
 * ctx: { openCells, rosters, pool, cfg, posOf, timing, byeOf }
 *   openCells — unfilled cells in board order, the first one being the pick
 *               being made; each { slot, round, overall }
 *   rosters   — slot -> array of playerId
 *   pool      — available players, value-sorted, each { id, name, position,
 *               team, bye, val, tier }
 * opts: { preset, temp, runs, topK, respectTiming, singleKDST, byeWeight, seed }
 */
function autoPick(ctx, opts = {}) {
  const { openCells, rosters, pool, cfg, posOf, timing } = ctx;
  if (!openCells.length || !pool.length) return null;

  const base = PRESETS[opts.preset || "pro"] || PRESETS.pro;
  const o = { ...base, ...opts };
  const cell = openCells[0];
  const slot = cell.slot;
  const round = cell.round || 1;
  const rng = A.makeRng(o.seed != null ? o.seed : (cell.overall * 7919 + 13));

  const legal = makeLegal(slot, openCells, rosters, cfg, posOf, timing, o);

  /* The forecast runs on the FULL pool. Filtering it to this team's legal
   * picks would change what every other team is modelled as taking, which is
   * exactly the thing the forecast is supposed to measure. */
  const fc = A.survivalForecast(openCells, rosters, pool, slot, cfg, posOf,
                                timing, o.runs);

  const valOf = (id) => (ctx.valOf ? ctx.valOf(id) : 0);
  const starters = cfg.roster.starters;
  const mine = rosters[slot] || [];
  const posVals = A.valsByPos(mine, valOf, posOf);
  const byeOf = ctx.byeOf || (() => null);
  const oppWeight = o.oppWeight ?? 1.0;

  const waiver = ctx.waiver || {};
  const floors = A.seatFloors(pool, rosters, cfg, posOf, waiver);
  const gain = (pos, val) =>
    A.marginalGain(pos, val, posVals[pos] || [], cfg, floors[pos] ?? 0, waiver[pos] ?? 0);

  /* Opportunity cost in the same units: what this pick is worth now, less
   * what the best player at his position is worth if you wait one turn. */
  const scored = [];
  for (const p of pool) {
    if (p.val == null) continue;
    if (!legal(p, round)) continue;
    const g = gain(p.position, p.val);
    const nextAt = fc.nextBest[p.position];
    const wait = nextAt == null ? g : gain(p.position, nextAt);
    const surv = fc.survival.has(p.id) ? fc.survival.get(p.id) : 0;
    const vona = Math.max(0, g - wait);
    const pen = byePenalty(p, mine, byeOf, posOf, starters, o.byeWeight ?? 3);
    scored.push({ player: p, base: g, vona, survival: surv,
                  byePenalty: pen,
                  score: g + oppWeight * vona * (1 - surv),
                  adj: g + oppWeight * vona * (1 - surv) - pen });
    if (scored.length >= 60) break;      // pool is value-sorted; 60 legal is plenty
  }
  scored.sort((a, b) => b.adj - a.adj);
  const cands = scored.slice(0, o.topK || 4);

  if (!cands.length) {
    /* nothing legal survived — take the best legal player by raw value so the
     * draft can never deadlock */
    const fallback = pool.find((p) => legal(p, round));
    if (!fallback) return null;
    return { slot, round, overall: cell.overall, player: fallback,
             why: "no ranked candidate legal — best legal value", forecast: fc };
  }

  const chosen = softmaxPick(cands, o.temp, rng);
  return {
    slot, round, overall: cell.overall,
    player: chosen.player,
    score: chosen.score,
    vona: chosen.vona,
    survival: chosen.survival,
    rank: cands.indexOf(chosen),
    candidates: cands,
    why: describe(chosen, cands, rosters[slot] || [], cfg, posOf, fc),
    forecast: fc,
  };
}

function describe(w, cands, rosterIds, cfg, posOf, fc) {
  const counts = countsFor(rosterIds, posOf);
  const starters = cfg.roster.starters;
  const pos = w.player.position;
  const bits = [];
  if ((counts[pos] || 0) < (starters[pos] || 0)) bits.push(`fills ${pos} starter`);
  if (w.vona >= 2) bits.push(`VONA +${w.vona.toFixed(1)}`);
  if (fc.nextPick != null && w.survival < 0.5) {
    bits.push(`${((1 - w.survival) * 100).toFixed(0)}% gone by ${fc.nextPick}`);
  }
  if (w.rank > 0 || cands.indexOf(w) > 0) bits.push("off-chalk");
  if (!bits.length) bits.push(`best value left (${(w.player.val ?? 0).toFixed(0)} VOR)`);
  return bits.join(" · ");
}

/**
 * Auto-pick repeatedly. `commit` applies one result and must advance the board;
 * `nextCtx` rebuilds context from the new board state. Stops when `stopAt`
 * returns true, when the draft completes, or after `limit` picks.
 */
function autoRun(nextCtx, commit, stopAt, opts = {}) {
  const limit = opts.limit || 200;
  const made = [];
  for (let i = 0; i < limit; i++) {
    const ctx = nextCtx();
    if (!ctx || !ctx.openCells.length) break;
    if (stopAt && stopAt(ctx)) break;
    const res = autoPick(ctx, opts);
    if (!res) break;
    commit(res);
    made.push(res);
  }
  return made;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { configureAutopick, autoPick, autoRun, PRESETS,
                     makeLegal, softmaxPick, byePenalty, seatState };
}
