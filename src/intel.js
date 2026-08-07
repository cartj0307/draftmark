"use strict";

let _gammaSurvival = (typeof gammaSurvival !== "undefined") ? gammaSurvival : null;
function useGammaSurvival(fn) { _gammaSurvival = fn; }

const K_MAX = 14;

function floorTerm(gamma, yardsPerPoint) {
  if (!gamma || !gamma.shape) return 0;
  let s = 0;
  for (let k = 1; k <= K_MAX; k++) s += _gammaSurvival(yardsPerPoint * k, gamma.shape, gamma.scale);
  return s;
}
function bonusTerm(gamma, tiers) {
  if (!gamma || !gamma.shape || !tiers || !tiers.length) return 0;
  let s = 0;
  for (const t of tiers) {
    const pMin = _gammaSurvival(t.min, gamma.shape, gamma.scale);
    const pMax = t.max == null ? 0 : _gammaSurvival(t.max + 1, gamma.shape, gamma.scale);
    s += t.points * (pMin - pMax);
  }
  return s;
}

/** Expected points for one week given that week's lambda. */
function expectedWeek(player, lambdaW, cfgScoring) {
  if (lambdaW <= 0) return 0; // bye
  const tm = player.td_model, ym = player.yardage_model || {};
  let e = 0;
  e += cfgScoring.touchdowns.rushing * lambdaW;                 // rush+rec TD, both 6
  e += cfgScoring.touchdowns.passing * (tm.pass_td_pg || 0);
  e += cfgScoring.turnovers.interception_thrown * (tm.int_pg || 0);
  e += floorTerm(ym.rush, cfgScoring.yardage_floors.rushing.yards_per_point);
  e += floorTerm(ym.rec, cfgScoring.yardage_floors.receiving.yards_per_point);
  e += floorTerm(ym.pass, cfgScoring.yardage_floors.passing.yards_per_point);
  e += bonusTerm(ym.rush, cfgScoring.yardage_bonuses.rushing);
  e += bonusTerm(ym.rec, cfgScoring.yardage_bonuses.receiving);
  e += bonusTerm(ym.pass, cfgScoring.yardage_bonuses.passing);
  return e;
}

/**
 * Season expectation over the regular-season weeks (1..14), matchup-adjusted
 * through lambda_weekly, scaled by availability.
 */
function expectedSeason(player, league) {
  const tm = player.td_model;
  if (!tm) return null;
  const [w0, w1] = league.schedule.regular_season_weeks;
  const weeks = tm.lambda_weekly || [];
  let e = 0;
  for (let w = w0; w <= w1; w++) e += expectedWeek(player, weeks[w - 1] ?? tm.lambda_base, league.scoring);
  const avail = player.availability && player.availability.expected_games
    ? Math.min(1, player.availability.expected_games / 17) : 0.88;
  return e * avail;
}

function playoffTilt(player, league) {
  const tm = player.td_model;
  if (!tm || !tm.lambda_weekly) return null;
  const [w0, w1] = league.schedule.regular_season_weeks;
  const [p0, p1] = league.schedule.playoff_weeks;
  const regWeeks = [], poWeeks = [];
  for (let w = w0; w <= w1; w++) { const l = tm.lambda_weekly[w - 1]; if (l > 0) regWeeks.push(expectedWeek(player, l, league.scoring)); }
  for (let w = p0; w <= p1; w++) { const l = tm.lambda_weekly[w - 1]; if (l > 0) poWeeks.push(expectedWeek(player, l, league.scoring)); }
  if (!regWeeks.length || !poWeeks.length) return null;
  const rm = regWeeks.reduce((a, b) => a + b) / regWeeks.length;
  const pm = poWeeks.reduce((a, b) => a + b) / poWeeks.length;
  return rm > 0 ? (pm / rm - 1) : null;
}

function computeValues(players, league) {
  const byPos = {};
  const es = new Map();
  for (const p of players) {
    const v = expectedSeason(p, league);
    if (v == null) continue;
    es.set(p.id, v);
    (byPos[p.position] = byPos[p.position] || []).push(v);
  }
  const repl = {};
  for (const [pos, vals] of Object.entries(byPos)) {
    vals.sort((a, b) => b - a);
    const r = (league.replacement_levels || {})[pos] || 12;
    repl[pos] = vals[Math.min(r - 1, vals.length - 1)] ?? 0;
  }
  const out = new Map();
  for (const p of players) {
    if (!es.has(p.id)) continue;
    out.set(p.id, { es: es.get(p.id), vor: es.get(p.id) - (repl[p.position] ?? 0) });
  }
  return { values: out, replacement: repl };
}

function detectTiers(players, values, league) {
  const MIN_GAP = 4.0, MAX_TIERS = 6;
  const tiers = new Map();
  const byPos = {};
  for (const p of players) {
    if (!values.has(p.id)) continue;
    (byPos[p.position] = byPos[p.position] || []).push(p);
  }
  for (const [posName, list] of Object.entries(byPos)) {
    list.sort((a, b) => values.get(b.id).vor - values.get(a.id).vor);
    const repl = (league && league.replacement_levels && league.replacement_levels[posName]) || 12;
    const window = Math.min(list.length, 2 * repl);
    const gaps = [];
    for (let i = 1; i < window; i++) {
      gaps.push({ i, g: values.get(list[i - 1].id).vor - values.get(list[i].id).vor });
    }
    const breaks = gaps.filter((x) => x.g >= MIN_GAP)
      .sort((a, b) => b.g - a.g)
      .slice(0, MAX_TIERS - 1)
      .map((x) => x.i)
      .sort((a, b) => a - b);
    let tier = 1, bi = 0;
    for (let i = 0; i < list.length; i++) {
      while (bi < breaks.length && i >= breaks[bi]) { tier++; bi++; }
      tiers.set(list[i].id, Math.min(tier, MAX_TIERS));
    }
  }
  return tiers;
}

/* ---- ADP survival (V.4) — degrades gracefully until ADP lands ---- */

function normCdf(z) {
  // Abramowitz-Stegun
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** sigma estimated from ADP when a real sd is absent: noisier later in draft. */
function adpSigma(adp, adpSd) {
  if (adpSd) return adpSd;
  return Math.max(3, 0.18 * adp);
}

/** P(player still available at overall pick k). */
function survivalProb(player, k) {
  if (player.adp == null) return null;
  const z = (k - player.adp) / adpSigma(player.adp, player.adp_sd);
  return 1 - normCdf(z);
}

function expectedBestAt(list, values, k) {
  let acc = 0, probAllGone = 1;
  for (const p of list) {
    const s = survivalProb(p, k);
    if (s == null) return null; // no ADP -> can't compute
    acc += values.get(p.id).es * s * probAllGone;
    probAllGone *= (1 - s);
  }
  return acc;
}

function vonaByPosition(pool, values, nextPick) {
  const out = {};
  const byPos = {};
  for (const p of pool) {
    if (!values.has(p.id)) continue;
    (byPos[p.position] = byPos[p.position] || []).push(p);
  }
  for (const [pos, list] of Object.entries(byPos)) {
    list.sort((a, b) => values.get(b.id).es - values.get(a.id).es);
    const top = list.slice(0, 25);
    const bestNow = values.get(top[0].id).es;
    const bestLater = nextPick != null ? expectedBestAt(top, values, nextPick) : null;
    out[pos] = {
      bestNow,
      bestLater,
      vona: bestLater == null ? null : bestNow - bestLater,
      topName: top[0].name || top[0].id,
    };
  }
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    useGammaSurvival, expectedWeek, expectedSeason, playoffTilt,
    computeValues, detectTiers, survivalProb, expectedBestAt,
    vonaByPosition, normCdf, adpSigma,
  };
}
