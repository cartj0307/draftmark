"use strict";

let R = null; // { prepareSimPlayers, runChampionshipSim, makeRng }

const STARTER_FIRST_BY_ROUND = { 1: 1.00, 2: 1.00, 3: 1.00, 4: 0.95, 5: 0.70, 6: 0.50, 7: 0.20 };
function openSkillSeats(counts, starters) {
  const open = new Set();
  for (const [pos, n] of Object.entries(starters)) {
    if (pos === "K" || pos === "DST") continue;
    if ((counts[pos] || 0) < n) open.add(pos);
  }
  return open;
}
function configureRecommend(deps) { R = deps; }

function countsBySlot(rosters, posOf) {
  const out = {};
  for (const [slot, ids] of Object.entries(rosters)) {
    const c = {};
    for (const id of ids) { const p = posOf(id); c[p] = (c[p] || 0) + 1; }
    out[slot] = c;
  }
  return out;
}

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
    const est = emptyStarterSeats(c, starters);
    const funnel = isYou && est.n > 0 && remainingBySlot[slot] <= est.n ? est.need : null;

    const legal = (p) => (c[p.position] || 0) < (mx[p.position] ?? 99) &&
                         (!funnel || funnel.has(p.position)) &&
                         !((p.position === "K" || p.position === "DST") && round < KDST_FLOOR);

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

function selectCandidates(openCells, startRosters, pool, yourSlot, cfg, posOf, flaggedIds, cap, timing) {
  cap = cap || 5;
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

/* ---------------------------------------------------------------------------
 * Roster value.
 *
 * The old rule scaled a player by whether he filled a starting seat: full
 * value if he did, a quarter if he was the first backup, a tenth after that.
 * Once your lineup is full that scales every skill player down to a tenth
 * while kicker and defense still have empty seats holding full value, so from
 * round seven on the board recommends nothing but kickers and defenses. It is
 * not a close call in the numbers either — it is structural.
 *
 * The replacement level that VOR is built on assumes you can always go get
 * another player of that quality. For kicker and defense that is true: after
 * 192 picks the best kicker on waivers is 0.7 points worse over a season than
 * the twelfth kicker, and the best defense is 0.0 worse. Nobody carries a
 * second one, so the whole league rosters twelve, and the thirteenth is free
 * all year. For running back it is false: the best running back on waivers is
 * 31.5 points worse than the twenty-fourth, because the league rosters sixty.
 *
 * So a bench player is not worth a fraction of his own value — he is worth the
 * gap between him and what waivers would hand you in the week you need him,
 * times the odds you need him. That gap is the entire argument for depth, and
 * it is worth 31.5 points at running back and 0.7 at kicker.
 * ------------------------------------------------------------------------- */

/* per-season odds a man at this position misses time the next man up covers */
const BENCH_DECAY = { QB: 0.20, RB: 0.45, WR: 0.40, TE: 0.22, K: 0.02, DST: 0.02 };

/* How deep each position is rostered league-wide, and therefore where waivers
 * start. Bench spots go where injuries go, so allocate them across positions
 * in proportion to starting seats times the odds that seat needs covering. */
function waiverBaselines(allPlayers, cfg) {
  const teams = cfg.teams;
  const starters = cfg.roster.starters;
  const mx = cfg.roster.position_max || {};
  const seats = Object.values(starters).reduce((a, b) => a + b, 0);
  const bench = Math.max(0, (cfg.roster.size || (seats + 8)) - seats);

  let wsum = 0;
  const w = {};
  for (const [pos, n] of Object.entries(starters)) {
    w[pos] = n * (BENCH_DECAY[pos] ?? 0.30);
    wsum += w[pos];
  }
  const perTeam = {};
  for (const [pos, n] of Object.entries(starters)) {
    const extra = wsum > 0 ? bench * (w[pos] / wsum) : 0;
    perTeam[pos] = Math.min(n + extra, mx[pos] ?? 99);
  }

  const byPos = {};
  for (const p of allPlayers) {
    if (p.val == null) continue;
    (byPos[p.position] = byPos[p.position] || []).push(p.val);
  }
  const out = {};
  for (const [pos, list] of Object.entries(byPos)) {
    list.sort((a, b) => b - a);
    const rank = Math.round(teams * (perTeam[pos] ?? 1));
    out[pos] = list[Math.min(rank, list.length - 1)] ?? 0;
  }
  return out;
}

function positionValue(vals, seats, decay, floor, waiver) {
  let v = 0;
  for (let i = 0; i < seats; i++) v += vals[i] ?? floor;
  for (let i = seats; i < vals.length; i++) {
    /* insurance: what he gives you over the waiver body, in the weeks the man
     * ahead of him is out. Never negative — you would just stream instead. */
    v += Math.pow(decay, i - seats + 1) * Math.max(0, vals[i] - waiver);
  }
  return v;
}

function marginalGain(pos, val, posVals, cfg, floor, waiver) {
  const seats = cfg.roster.starters[pos] || 0;
  const decay = BENCH_DECAY[pos] ?? 0.30;
  const f = floor ?? 0, w = waiver ?? 0;
  const before = positionValue(posVals, seats, decay, f, w);
  const after = positionValue([...posVals, val].sort((a, b) => b - a), seats, decay, f, w);
  return after - before;
}

/* What an empty starter seat is really worth: the better of what the draft
 * still holds once every team ahead of you in line has filled the same seat,
 * and what waivers will hand you all season. The second term is why an empty
 * kicker seat never becomes urgent and an empty running back seat does. */
function seatFloors(pool, rosters, cfg, posOf, waiver) {
  const starters = cfg.roster.starters;
  const need = {};
  for (const pos of Object.keys(starters)) need[pos] = 0;
  for (const ids of Object.values(rosters || {})) {
    const c = {};
    for (const id of ids) { const q = posOf(id); c[q] = (c[q] || 0) + 1; }
    for (const [pos, n] of Object.entries(starters)) need[pos] += Math.max(0, n - (c[pos] || 0));
  }
  const byPos = {};
  for (const p of pool) {
    if (p.val == null) continue;
    (byPos[p.position] = byPos[p.position] || []).push(p.val);
  }
  const floors = {};
  for (const [pos, n] of Object.entries(need)) {
    const list = byPos[pos] || [];
    const draftFloor = list.length
      ? list[Math.min(Math.max(n - 1, 0), list.length - 1)] : -Infinity;
    floors[pos] = Math.max(draftFloor, (waiver && waiver[pos] != null) ? waiver[pos] : 0);
  }
  return floors;
}

function valsByPos(ids, valOf, posOf) {
  const out = {};
  for (const id of ids) (out[posOf(id)] = out[posOf(id)] || []).push(valOf(id) ?? 0);
  for (const k of Object.keys(out)) out[k].sort((a, b) => b - a);
  return out;
}

function rankByVona(pool, myRoster, cfg, posOf, forecast, opts = {}) {
  const OPP_WEIGHT = opts.oppWeight ?? 1.0;
  const MIN_AVAIL = opts.minAvail ?? 0.05;
  const waiver = opts.waiver || {};
  const floors = opts.floors || {};
  const valOf = opts.valOf || null;
  const round = opts.round || 0;

  /* You will not spend a pick on a kicker or a defense before these rounds.
   * Held as a rule rather than left to the score because the score can only
   * ever price the position at a few points either way, and a rule is honest
   * about that being a decision rather than a calculation. Lifted when the
   * lineup rule leaves nothing else legal. */
  const kFloor = opts.earliestK || 0;
  const dFloor = opts.earliestDST || 0;

  const posVals = valOf
    ? valsByPos(myRoster, valOf, posOf)
    : (() => {                                   // fall back to pool lookups
        const m = new Map(pool.map((p) => [p.id, p.val]));
        return valsByPos(myRoster, (id) => m.get(id) ?? 0, posOf);
      })();

  const gain = (pos, val) =>
    marginalGain(pos, val, posVals[pos] || [], cfg, floors[pos] ?? 0, waiver[pos] ?? 0);

  const priced = pool.filter((p) => p.val != null).map((p) => {
    const availNow = forecast.availNow.has(p.id) ? forecast.availNow.get(p.id) : 1;
    const surv = forecast.survival.has(p.id) ? forecast.survival.get(p.id) : 0;
    const base = gain(p.position, p.val);
    const nextAt = forecast.nextBest[p.position];
    const vona = nextAt == null ? 0 : Math.max(0, base - gain(p.position, nextAt));
    const urgency = vona * (1 - surv);           // certain to survive => no urgency
    const early = (p.position === "K" && round && round < kFloor) ||
                  (p.position === "DST" && round && round < dFloor);
    return { player: p, base, vona, survival: surv, availNow, early,
             score: base + OPP_WEIGHT * urgency };
  }).filter((x) => x.availNow >= MIN_AVAIL);

  const open = priced.filter((x) => !x.early);
  return (open.length ? open : priced)           // never leave the board empty
    .sort((a, b) => b.score - a.score);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports.survivalForecast = survivalForecast;
  module.exports.rankByVona = rankByVona;
  module.exports.waiverBaselines = waiverBaselines;
  module.exports.seatFloors = seatFloors;
  module.exports.marginalGain = marginalGain;
  module.exports.positionValue = positionValue;
  module.exports.valsByPos = valsByPos;
  module.exports.BENCH_DECAY = BENCH_DECAY;
}
