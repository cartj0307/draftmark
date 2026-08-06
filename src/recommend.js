/**
 * Draftmark recommender — Phase 5 (Part VII).
 *
 * The question the whole tool exists to answer: "who do I take, right now,
 * to maximize the probability of winning the championship?"
 *
 * Method: for each plausible candidate, assume you take him, complete the
 * remaining draft for all twelve teams (greedy value + roster need, seeded
 * jitter for opponents, your own future picks respecting the lineup-completion
 * funnel), then run the championship simulator. COMMON RANDOM NUMBERS: every
 * candidate is evaluated on the identical stream of simulated seasons — same
 * opponent drafts, same injuries, same weekly outcomes — so the difference in
 * title probability is the pick's signal, not Monte Carlo noise.
 *
 * The answer comes with its own uncertainty attached (the honesty tax): when
 * the edge between the top two is inside the noise floor, the verdict says
 * "either is fine" instead of manufacturing false precision.
 *
 * Pure module. Deps injected via configureRecommend (sim + value functions).
 */

"use strict";

let R = null; // { prepareSimPlayers, runChampionshipSim, makeRng }

/* MEASURED from three years of this league's drafts (build/analyze_policy.py):
 * when a manager has an empty QB/RB/WR/TE starter seat, the fraction of picks
 * that fill one — 171 of 182 in rounds 1-6. This is a genuine choice, not
 * roster math: taking a third back in round 4 is legal and they essentially
 * never do it. A soft value multiplier let the simulated opponents stack far
 * more than the real ones do, which distorted every survival estimate. */
const STARTER_FIRST_BY_ROUND = { 1: 1.00, 2: 1.00, 3: 1.00, 4: 0.95, 5: 0.70, 6: 0.50, 7: 0.20 };
/* NOTE: these are ENFORCEMENT probabilities, deliberately below the observed
 * fill rates (1.00/1.00/1.00/0.97/0.94/0.76/0.36). When the rule does not fire
 * the value scoring still favours filling a seat, so enforcing at the observed
 * rate overshoots. Calibrated so the SIMULATED rate matches the real one —
 * validated in test/opponents.test.js. */

/** Empty starter seats at the skill positions (K/DST are governed separately
 *  by the round floor, so they are excluded here). */
function openSkillSeats(counts, starters) {
  const open = new Set();
  for (const [pos, n] of Object.entries(starters)) {
    if (pos === "K" || pos === "DST") continue;
    if ((counts[pos] || 0) < n) open.add(pos);
  }
  return open;
}
function configureRecommend(deps) { R = deps; }

/* ------------------------------------------------------------ helpers ---- */

function countsBySlot(rosters, posOf) {
  const out = {};
  for (const [slot, ids] of Object.entries(rosters)) {
    const c = {};
    for (const id of ids) { const p = posOf(id); c[p] = (c[p] || 0) + 1; }
    out[slot] = c;
  }
  return out;
}

/** Urgency per position = what it COSTS to wait, measured from the board.
 *
 *  A flat "you still need a starter" bonus is wrong: it made the recommender
 *  take a kicker in round 7, because filling the seat looked worth a fixed
 *  amount. But kickers and defenses are flat — the 1st and 6th best are
 *  nearly identical, so waiting costs ~0. Running backs fall off a cliff, so
 *  waiting is expensive. Urgency is that gradient: best available now minus
 *  what is realistically left at your next turn.
 */
function positionUrgency(pool, lookahead) {
  const k = Math.max(1, Math.min(lookahead || 3, 12));
  const byPos = {};
  for (const p of pool) {
    if (p.val == null) continue;
    (byPos[p.position] = byPos[p.position] || []).push(p.val);
  }
  const out = { _next: {} };
  for (const [pos, vals] of Object.entries(byPos)) {
    vals.sort((a, b) => b - a);
    out[pos] = Math.max(0, vals[0] - vals[Math.min(k, vals.length - 1)]);
    // what you would still get at this position at your next turn
    out._next[pos] = vals[Math.min(k, vals.length - 1)];
  }
  return out;
}

/** Value of a player GIVEN the roster — scored as VONA, not raw VOR.
 *
 *  You will fill every starter seat eventually, so a seat being open is not
 *  itself worth anything. What is worth something is how much BETTER this
 *  player is than the one you would still get at that position at your next
 *  turn. For defenses and kickers that gap is ~0 (they are interchangeable),
 *  which is why raw VOR kept recommending a defense in round 7. For a running
 *  back sitting on a tier cliff the gap is large. This is the master doc's
 *  VONA (Part V.4) applied per player.
 */
function marginalValue(p, counts, starters, urgency) {
  const have = counts[p.position] || 0;
  const need = starters[p.position] || 0;
  const mult = have < need ? 1.0 : have === need ? 0.25 : 0.10;
  const nextBest = (urgency && urgency._next) ? (urgency._next[p.position] ?? p.val) : null;
  const vona = (nextBest == null || p.val == null) ? (p.val ?? -1e6) : (p.val - nextBest);
  return vona * mult;
}

function emptyStarterSeats(counts, starters) {
  let n = 0; const need = new Set();
  for (const [pos, k] of Object.entries(starters)) {
    const have = Math.min(counts[pos] || 0, k);
    if (have < k) { need.add(pos); n += k - have; }
  }
  return { n, need };
}

/* --------------------------------------------------- draft completion ---- */
/**
 * Complete the remaining draft. openCells: [{slot}] in pick order. pool:
 * ranked array of {id, position, val} best-first. yourSlot's first open cell
 * receives candidateId (if given). Opponents: greedy from the top 3 legal
 * with seeded jitter. Your picks: pure greedy value + need bonus, honoring
 * the lineup-completion funnel and position maxes.
 * Returns { rosters: {slot:[ids]}, taken:Set }.
 */
function completeDraft(openCells, startRosters, pool, yourSlot, candidateId, rng, cfg, posOf, timing) {
  const rosters = {};
  for (const [s, ids] of Object.entries(startRosters)) rosters[s] = [...ids];
  const taken = new Set();
  for (const ids of Object.values(rosters)) for (const id of ids) taken.add(id);
  const counts = countsBySlot(rosters, posOf);
  const mx = cfg.roster.position_max, starters = cfg.roster.starters;
  let yourFirst = true;
  const remainingBySlot = {};
  for (const c of openCells) remainingBySlot[c.slot] = (remainingBySlot[c.slot] || 0) + 1;

  const EARLY_PENALTY = 12;   // value points charged per round drafted "too early"
  const KDST_FLOOR = (timing && timing._kdstFloor) || 7;

  for (const cell of openCells) {
    const slot = cell.slot;
    const round = cell.round || 1;
    const c = counts[slot] = counts[slot] || {};
    const isYou = String(slot) === String(yourSlot);

    // legality for this slot
    const est = emptyStarterSeats(c, starters);
    const funnel = isYou && est.n > 0 && remainingBySlot[slot] <= est.n ? est.need : null;
    // Measured league behaviour (see build/analyze_tendencies.py): nobody in
    // this league has ever taken a K or D/ST before round 7. Without this the
    // greedy opponents grab them mid-draft and the pool that reaches your pick
    // is wrong.
    const legal = (p) => (c[p.position] || 0) < (mx[p.position] ?? 99) &&
                         (!funnel || funnel.has(p.position)) &&
                         !((p.position === "K" || p.position === "DST") && round < KDST_FLOOR);

    // Per-manager positional timing, applied to OPPONENTS only. Your own
    // future picks stay pure value+need — profiling yourself would just make
    // the recommendation self-fulfilling.
    const tprof = (!isYou && timing) ? timing[slot] : null;
    const earliness = (p) => {
      if (!tprof) return 0;
      const want = tprof[p.position];
      return (want && round < want) ? EARLY_PENALTY * (want - round) : 0;
    };

    const urg = positionUrgency(pool.filter((p) => !taken.has(p.id)),
                                Math.max(2, Math.round(openCells.length / 12)));
    let pickId = null;
    if (isYou && yourFirst && candidateId != null) {
      pickId = candidateId; yourFirst = false;
    } else {
      // rank with a need bonus (empty starter seat is worth reaching for)
      const seats = openSkillSeats(c, starters);
      const strict = STARTER_FIRST_BY_ROUND[round] || 0;
      const enforce = !isYou && seats.size > 0 && strict > 0 && rng() < strict;
      const scored = [];
      for (const p of pool) {
        if (taken.has(p.id) || !legal(p)) continue;
        if (enforce && !seats.has(p.position)) continue;
        scored.push([p, marginalValue(p, c, starters, urg) - earliness(p)]);
        if (scored.length >= 8) break;   // pool is ranked; 8 legal is plenty
      }
      if (!scored.length && enforce) {
        for (const p of pool) {
          if (taken.has(p.id) || !legal(p)) continue;
          scored.push([p, marginalValue(p, c, starters, urg) - earliness(p)]);
          if (scored.length >= 8) break;
        }
      }
      if (!scored.length) continue;      // nothing legal (shouldn't happen)
      scored.sort((a, b) => b[1] - a[1]);
      if (isYou) pickId = scored[0][0].id;
      else {
        // opponents: top-3 weighted jitter (0.6 / 0.25 / 0.15)
        const u = rng();
        const k = u < 0.6 ? 0 : u < 0.85 ? 1 : 2;
        pickId = scored[Math.min(k, scored.length - 1)][0].id;
      }
      if (isYou) yourFirst = false;
    }
    taken.add(pickId);
    rosters[slot].push(pickId);
    c[posOf(pickId)] = (c[posOf(pickId)] || 0) + 1;
    remainingBySlot[slot]--;
  }
  return { rosters, taken };
}

/* ------------------------------------------------- candidate selection ---- */
/**
 * Who is worth simulating? Run one deterministic completion up to your next
 * cell to see who plausibly survives, then take: the top survivors by value,
 * the best survivor at each position where you still need a starter, and any
 * flagged targets that survive. Deduped, legal, capped.
 */
function selectCandidates(openCells, startRosters, pool, yourSlot, cfg, posOf, flaggedIds, cap, timing) {
  cap = cap || 5;
  // survivors: greedy-jitter opponents with a fixed probe seed
  const yourIdx = openCells.findIndex((c) => String(c.slot) === String(yourSlot));
  if (yourIdx === -1) return [];
  const probe = completeDraft(openCells.slice(0, yourIdx), startRosters, pool, -1, null,
                              R.makeRng(777), cfg, posOf, timing);
  const gone = probe.taken;
  const c = countsBySlot(probe.rosters, posOf)[yourSlot] || {};
  const mx = cfg.roster.position_max, starters = cfg.roster.starters;
  const est = emptyStarterSeats(c, starters);
  const remaining = openCells.filter((x) => String(x.slot) === String(yourSlot)).length;
  const funnel = est.n > 0 && remaining <= est.n ? est.need : null;
  const legal = (p) => (c[p.position] || 0) < (mx[p.position] ?? 99) &&
                       (!funnel || funnel.has(p.position));
  const yourRound = openCells[yourIdx] ? (openCells[yourIdx].round || 99) : 99;
  const urgSel = positionUrgency(pool.filter((p) => !gone.has(p.id)), 3);
  const floor = (timing && timing._kdstFloor) || 0;
  const survivors = pool
    .filter((p) => !gone.has(p.id) && legal(p))
    .filter((p) => !((p.position === "K" || p.position === "DST") && yourRound < floor))
    .sort((a, b) => marginalValue(b, c, starters, urgSel) - marginalValue(a, c, starters, urgSel));

  const picks = [];
  const add = (p) => { if (p && !picks.some((x) => x.id === p.id)) picks.push(p); };
  for (const p of survivors.slice(0, 3)) add(p);              // best value standing
  for (const pos of est.need) add(survivors.find((p) => p.position === pos)); // need fillers
  for (const id of flaggedIds || []) add(survivors.find((p) => p.id === id)); // your targets
  return picks.slice(0, cap);
}

/* ----------------------------------------------------- the recommender ---- */
/**
 * evaluateCandidates: one CRN batch of seasons per candidate. State carried in
 * `acc` so the caller can stream batches and stop adaptively.
 * toSimEntry(id) -> sim player input. Returns updated acc.
 */
function evaluateBatch(ctx, acc, batchSeasons, batchIndex) {
  const { openCells, startRosters, pool, yourSlot, cfg, posOf, toSimEntry, slotTiers } = ctx;
  for (const cand of acc.candidates) {
    // identical draft-completion seed and season seed across candidates: CRN
    const draft = completeDraft(openCells, startRosters, pool, yourSlot, cand.id,
                                R.makeRng(31000 + batchIndex), cfg, posOf, ctx.timing);
    const all = []; const rosters = {};
    for (const [s, ids] of Object.entries(draft.rosters)) {
      rosters[s] = [];
      for (const id of ids) {
        const e = toSimEntry(id);
        if (!e) continue;
        rosters[s].push(all.length); all.push(e);
      }
    }
    const prepared = R.prepareSimPlayers(all, cfg);
    const res = R.runChampionshipSim(rosters, prepared, cfg, slotTiers,
                                     { seasons: batchSeasons, seed: 91000 + batchIndex });
    const batchP = res.titles[yourSlot] || 0;
    cand.titleSum += batchP * batchSeasons;
    cand.seasons += batchSeasons;
    cand.p = cand.titleSum / cand.seasons;
    cand.band = 1.96 * Math.sqrt(Math.max(cand.p * (1 - cand.p), 1e-6) / cand.seasons);
    (cand.batchP = cand.batchP || []).push(batchP);
  }
  acc.candidates.sort((a, b) => b.p - a.p);
  acc.batches = (acc.batches || 0) + 1;
  return acc;
}

function initAccumulator(candidates) {
  return { candidates: candidates.map((p) => ({ id: p.id, name: p.name, position: p.position,
                                                val: p.val, tier: p.tier, team: p.team,
                                                titleSum: 0, seasons: 0, p: 0, band: 1 })) };
}

/** The because: one honest line comparing winner to runner-up. */
function explain(winner, runner, ctx) {
  const { pool, startRosters, yourSlot, cfg, posOf } = ctx;
  const c = countsBySlot(startRosters, posOf)[yourSlot] || {};
  const est = emptyStarterSeats(c, cfg.roster.starters);
  if (est.need.has(winner.position) && runner && !est.need.has(runner.position)) {
    return `fills your empty ${winner.position} starter seat while value is still on the board`;
  }
  const sameTier = pool.filter((p) => p.position === winner.position && p.tier === winner.tier);
  if (winner.tier != null && sameTier.length <= 2) {
    return `last of the ${winner.position} tier ${winner.tier} — the cliff is right behind him`;
  }
  const myTeams = new Set((startRosters[yourSlot] || []).map((id) => {
    const p = pool.find((x) => x.id === id); return p ? p.team : null;
  }).filter(Boolean));
  if (winner.team && myTeams.has(winner.team)) {
    return `stacks with your ${winner.team} pieces — correlated weekly upside the sim rewards`;
  }
  if (runner && winner.val != null && runner.val != null && winner.val - runner.val > 5) {
    return `simply the most value left (+${(winner.val - runner.val).toFixed(0)} over the alternative)`;
  }
  return `highest championship equity across the simulated seasons`;
}

/** The verdict object the surface renders. */
/** Standard error of the PAIRED difference between the top two candidates.
 *  Each batch runs every candidate on identical simulated seasons (CRN), so
 *  the per-batch deltas are iid draws of the quantity we care about. Treating
 *  the two absolute probabilities as independent — the old behaviour —
 *  overstated the noise several-fold and made every verdict a "coin flip". */
function pairedNoise(w, r) {
  if (!r) return w.band;
  const a = w.batchP || [], b = r.batchP || [];
  const n = Math.min(a.length, b.length);
  if (n < 3) return Math.sqrt(w.band * w.band + r.band * r.band);
  const d = [];
  for (let i = 0; i < n; i++) d.push(a[i] - b[i]);
  const m = d.reduce((x, y) => x + y, 0) / n;
  const v = d.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1);
  return 1.96 * Math.sqrt(v / n);
}

function verdict(acc, ctx) {
  const [w, r] = acc.candidates;
  if (!w) return null;
  const edge = r ? (w.p - r.p) : w.p;
  const noise = pairedNoise(w, r);
  const decisive = !r || edge > noise;
  return {
    name: w.name, position: w.position, p: w.p, band: w.band,
    edgePct: edge * 100, noisePct: noise * 100, decisive,
    runnerName: r ? r.name : null,
    because: explain(w, r, ctx),
    tax: decisive
      ? `±${(w.band * 100).toFixed(1)}% at ${w.seasons.toLocaleString()} seasons per candidate`
      : `edge ${(edge * 100).toFixed(1)}% is inside the ±${(noise * 100).toFixed(1)}% noise floor — either is fine`,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { configureRecommend, completeDraft, selectCandidates, pairedNoise, marginalValue, positionUrgency,
                     initAccumulator, evaluateBatch, verdict, explain };
}

/* ======================================================================
 * VONA engine — the primary recommendation driver (master doc Part V.4).
 *
 * The season simulator answers "which pick maximizes title probability", but
 * the honest answer is usually "these are within noise of each other", which
 * is useless on the clock. The question that actually separates picks is the
 * one every value-based-drafting method asks: how much better is this player
 * than the one I will STILL be able to get at this position at my next turn?
 *
 * Standard implementations forecast that from league-average ADP. This one
 * forecasts it by simulating the draft forward using each manager's MEASURED
 * tendencies — a strictly better input for one specific league.
 * ====================================================================== */

/**
 * Simulate the draft forward from now to your next pick, many times, and
 * report what survives.
 *
 * Returns {
 *   nextPick,                       // your next overall pick (null if none)
 *   survival: Map(id -> prob),      // P(still on the board at your next pick)
 *   nextBest: {pos -> value},       // E[best value at that position then]
 *   runs
 * }
 */
/**
 * Simulate the draft forward and report what is likely to be available.
 *
 * TWO distinct quantities — conflating them caused a real inversion:
 *   availNow — P(player is still there when you are next on the clock).
 *              1.0 for everyone if you are on the clock right now.
 *   survival — P(player is still there at the pick AFTER that). This is what
 *              opportunity cost is measured against.
 *
 * CRITICAL: every pool player gets an EXPLICIT probability, including zero.
 * The previous version only recorded players who survived at least once and
 * defaulted everyone else to 1.0 — so a player taken in all 150 futures
 * reported "100% likely to survive", the exact opposite of the truth.
 */
function survivalForecast(openCells, startRosters, pool, yourSlot, cfg, posOf, timing, runs, trace) {
  runs = runs || 150;
  const empty = { nextPick: null, yourPick: null, onClock: true,
                  availNow: new Map(), survival: new Map(), nextBest: {}, runs: 0 };
  const here = openCells.findIndex((c) => String(c.slot) === String(yourSlot));
  if (here === -1) return empty;
  const nextIdx = openCells.findIndex((c, i) => i > here && String(c.slot) === String(yourSlot));

  const preSpan = openCells.slice(0, here);                    // picks before your turn
  const between = nextIdx === -1 ? [] : openCells.slice(here + 1, nextIdx);
  const starters = cfg.roster.starters, mx = cfg.roster.position_max;
  const floor = (timing && timing._kdstFloor) || 0;

  const baseTaken = new Set();
  for (const ids of Object.values(startRosters)) for (const id of ids) baseTaken.add(id);
  const baseCounts = {};
  for (const [s, ids] of Object.entries(startRosters)) {
    const c = {};
    for (const id of ids) { const q = posOf(id); c[q] = (c[q] || 0) + 1; }
    baseCounts[s] = c;
  }

  const nowCount = new Map(), survCount = new Map(), bestSum = {};

  function runSpan(span, taken, counts, rng) {
    for (const cell of span) {
      const slot = cell.slot, round = cell.round || 1;
      const c = counts[slot] = counts[slot] || {};
      const tp = (timing && timing[slot]) || {};
      // starter-first: with the measured probability for this round, the
      // manager restricts himself to players who fill an empty starter seat
      const seats = openSkillSeats(c, starters);
      const strict = STARTER_FIRST_BY_ROUND[round] || 0;
      const enforce = seats.size > 0 && strict > 0 && rng() < strict;

      const legal = [];
      for (const p of pool) {
        if (taken.has(p.id)) continue;
        if ((c[p.position] || 0) >= (mx[p.position] ?? 99)) continue;
        if ((p.position === "K" || p.position === "DST") && round < floor) continue;
        if (enforce && !seats.has(p.position)) continue;
        legal.push(p);
        if (legal.length >= 40) break;      // pool is value-sorted
      }
      if (!legal.length && enforce) {       // never deadlock on the constraint
        for (const p of pool) {
          if (taken.has(p.id)) continue;
          if ((c[p.position] || 0) >= (mx[p.position] ?? 99)) continue;
          if ((p.position === "K" || p.position === "DST") && round < floor) continue;
          legal.push(p);
          if (legal.length >= 40) break;
        }
      }
      if (!legal.length) continue;
      const scored = legal.map((p) => {
        const have = c[p.position] || 0, need = starters[p.position] || 0;
        const mult = have < need ? 1.0 : have === need ? 0.25 : 0.10;
        const want = tp[p.position];
        const early = (want && round < want) ? 12 * (want - round) : 0;
        return [p, (p.val ?? -1e6) * mult - early];
      }).sort((a, b) => b[1] - a[1]);
      const u = rng();
      const k = u < 0.6 ? 0 : u < 0.85 ? 1 : 2;
      const pick = scored[Math.min(k, scored.length - 1)][0];
      if (trace) trace.push({ slot, round, pos: pick.position,
                              filledSeat: seats.has(pick.position), hadSeat: seats.size > 0 });
      taken.add(pick.id);
      c[pick.position] = (c[pick.position] || 0) + 1;
    }
  }

  for (let r = 0; r < runs; r++) {
    const rng = R.makeRng(500000 + r * 7907);
    const taken = new Set(baseTaken);
    const counts = {};
    for (const s of Object.keys(baseCounts)) counts[s] = { ...baseCounts[s] };

    runSpan(preSpan, taken, counts, rng);
    for (const p of pool) if (!taken.has(p.id)) nowCount.set(p.id, (nowCount.get(p.id) || 0) + 1);

    runSpan(between, taken, counts, rng);
    const bestAtPos = {};
    for (const p of pool) {
      if (taken.has(p.id)) continue;
      survCount.set(p.id, (survCount.get(p.id) || 0) + 1);
      if (bestAtPos[p.position] === undefined && p.val != null) bestAtPos[p.position] = p.val;
    }
    for (const [pos, v] of Object.entries(bestAtPos)) bestSum[pos] = (bestSum[pos] || 0) + v;
  }

  const availNow = new Map(), survival = new Map();
  for (const p of pool) {
    availNow.set(p.id, (nowCount.get(p.id) || 0) / runs);
    survival.set(p.id, (survCount.get(p.id) || 0) / runs);
  }
  const nextBest = {};
  for (const [pos, s] of Object.entries(bestSum)) nextBest[pos] = s / runs;

  return {
    yourPick: openCells[here].overall,
    nextPick: nextIdx === -1 ? null : openCells[nextIdx].overall,
    onClock: preSpan.length === 0,
    availNow, survival, nextBest, runs,
  };
}

/**
 * Rank the available players for your upcoming pick.
 *
 * score = roster-adjusted value + opportunity cost of NOT taking him now.
 * Per Subvertadown's construction the opportunity cost is ADDED to the
 * baseline rather than replacing it, which keeps the ranking stable instead
 * of lurching each time the forecast shifts.
 *
 * Players who will realistically be gone before your pick are dropped: a
 * recommendation you cannot act on is worse than no recommendation.
 */
function rankByVona(pool, myRoster, cfg, posOf, forecast, opts = {}) {
  const OPP_WEIGHT = opts.oppWeight ?? 1.0;
  const MIN_AVAIL = opts.minAvail ?? 0.05;
  const starters = cfg.roster.starters;
  const counts = {};
  for (const id of myRoster) { const q = posOf(id); counts[q] = (counts[q] || 0) + 1; }

  return pool.filter((p) => p.val != null).map((p) => {
    const availNow = forecast.availNow.has(p.id) ? forecast.availNow.get(p.id) : 1;
    const surv = forecast.survival.has(p.id) ? forecast.survival.get(p.id) : 0;
    const have = counts[p.position] || 0, need = starters[p.position] || 0;
    const mult = have < need ? 1.0 : have === need ? 0.25 : 0.10;
    const nextAt = forecast.nextBest[p.position];
    const vona = (nextAt == null) ? 0 : Math.max(0, p.val - nextAt);
    const urgency = vona * (1 - surv);      // certain to survive => no urgency
    return { player: p, base: p.val * mult, vona, survival: surv, availNow,
             score: p.val * mult + OPP_WEIGHT * urgency };
  }).filter((x) => x.availNow >= MIN_AVAIL)
    .sort((a, b) => b.score - a.score);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports.survivalForecast = survivalForecast;
  module.exports.rankByVona = rankByVona;
}
