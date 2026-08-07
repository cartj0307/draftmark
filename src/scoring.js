"use strict";

const EMPTY_LINE = Object.freeze({
  passYds: 0,
  rushYds: 0,
  recYds: 0,
  passTD: 0,
  rushTD: 0,
  recTD: 0,
  intThrown: 0,
  fumblesLost: 0,
  receptions: 0,
  twoPtPass: 0,
  twoPtRush: 0,
  twoPtRec: 0,
});
function yardageBonus(yards, tiers) {
  if (!tiers || tiers.length === 0) return 0;
  let best = 0;
  for (const tier of tiers) {
    const min = tier.min;
    const max = tier.max === null || tier.max === undefined ? Infinity : tier.max;
    if (yards >= min && yards <= max && tier.points > best) {
      best = tier.points;
    }
  }
  return best;
}

function score(statLine, leagueConfig) {
  const cfg = leagueConfig.scoring;
  // hot path: direct reads with validation (called ~30M times per full sim)
  const F = (v, k) => {
    if (v === undefined || v === null) return 0;
    if (!Number.isFinite(v)) throw new Error(`non-finite stat: ${k}=${v}`);
    return v;
  };
  const s = {
    passYds: F(statLine.passYds, "passYds"), rushYds: F(statLine.rushYds, "rushYds"),
    recYds: F(statLine.recYds, "recYds"), passTD: F(statLine.passTD, "passTD"),
    rushTD: F(statLine.rushTD, "rushTD"), recTD: F(statLine.recTD, "recTD"),
    intThrown: F(statLine.intThrown, "intThrown"), fumblesLost: F(statLine.fumblesLost, "fumblesLost"),
    receptions: F(statLine.receptions, "receptions"), twoPtPass: F(statLine.twoPtPass, "twoPtPass"),
    twoPtRush: F(statLine.twoPtRush, "twoPtRush"), twoPtRec: F(statLine.twoPtRec, "twoPtRec"),
  };

  let pts = 0;

  pts += Math.floor(s.passYds / cfg.yardage_floors.passing.yards_per_point);
  pts += Math.floor(s.rushYds / cfg.yardage_floors.rushing.yards_per_point);
  pts += Math.floor(s.recYds / cfg.yardage_floors.receiving.yards_per_point);
  pts += s.rushTD * cfg.touchdowns.rushing;
  pts += s.recTD * cfg.touchdowns.receiving;
  pts += s.passTD * cfg.touchdowns.passing;
  pts += s.intThrown * cfg.turnovers.interception_thrown;
  pts += s.fumblesLost * cfg.turnovers.fumble_lost; // weight 0 — validated
  pts += yardageBonus(s.rushYds, cfg.yardage_bonuses.rushing);
  pts += yardageBonus(s.recYds, cfg.yardage_bonuses.receiving);
  pts += yardageBonus(s.passYds, cfg.yardage_bonuses.passing);
  pts += s.receptions * cfg.receptions;
  pts += s.twoPtPass * cfg.two_point_conversions.pass;
  pts += s.twoPtRush * cfg.two_point_conversions.rush;
  pts += s.twoPtRec * cfg.two_point_conversions.receive;

  if (!Number.isInteger(pts)) {
    throw new Error(`non-integer score ${pts} — a constant is fractional and wrong`);
  }
  return pts;
}
function bucketPoints(value, buckets) {
  for (const b of buckets) {
    const max = b.max === null || b.max === undefined ? Infinity : b.max;
    if (value >= b.min && value <= max) return b.points;
  }
  throw new Error(`no bucket matches value ${value} — config buckets not exhaustive`);
}
function scoreKicker(line, leagueConfig) {
  const cfg = leagueConfig.scoring.kicking;
  const pat = line.patMade || 0;
  const fgs = line.fgMade || [];
  let pts = pat * cfg.pat_made;
  for (const dist of fgs) {
    pts += bucketPoints(dist, cfg.fg_made);
  }
  if (!Number.isInteger(pts)) throw new Error(`non-integer kicker score ${pts}`);
  return pts;
}
function scoreDST(line, leagueConfig) {
  const cfg = leagueConfig.scoring.dst;
  const s = {
    kickoffReturnTD: 0, puntReturnTD: 0, interceptionReturnTD: 0,
    fumbleReturnTD: 0, blockedKickReturnTD: 0, twoPointReturn: 0,
    onePointSafety: 0, blockedKick: 0, interceptions: 0,
    fumblesRecovered: 0, safeties: 0,
    pointsAllowed: 0, yardsAllowed: 0,
    ...line,
  };
  let pts = 0;
  pts += s.kickoffReturnTD * cfg.kickoff_return_td;
  pts += s.puntReturnTD * cfg.punt_return_td;
  pts += s.interceptionReturnTD * cfg.interception_return_td;
  pts += s.fumbleReturnTD * cfg.fumble_return_td;
  pts += s.blockedKickReturnTD * cfg.blocked_kick_return_td;
  pts += s.twoPointReturn * cfg.two_point_return;
  pts += s.onePointSafety * cfg.one_point_safety;
  pts += s.blockedKick * cfg.blocked_kick;
  pts += s.interceptions * cfg.interception;
  pts += s.fumblesRecovered * cfg.fumble_recovered;
  pts += s.safeties * cfg.safety;
  pts += bucketPoints(s.pointsAllowed, cfg.points_allowed);
  pts += bucketPoints(s.yardsAllowed, cfg.yards_allowed);
  if (!Number.isInteger(pts)) throw new Error(`non-integer D/ST score ${pts}`);
  return pts;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { score, scoreKicker, scoreDST, yardageBonus, bucketPoints, EMPTY_LINE };
}
