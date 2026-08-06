/**
 * Draftmark — expected weekly points via the survival-sum identity.
 *
 * Floors and bonuses do not commute with the mean, so NEVER score the mean
 * stat line. For Y ~ Gamma: E[floor(Y/y0)] = sum over k>=1 of P(Y >= y0*k),
 * and each bonus tier contributes points * P(Y in tier). TD terms are linear
 * so they pass through the mean directly.
 *
 * Every constant comes from config/league.json. Reads a JSON array of player
 * parameter objects on argv[2], writes expected points per game to argv[3].
 *
 * Input row: { id, lambda, pass_td_pg, int_pg,
 *              gammas: { rush: {shape, scale}, rec: {...}, pass: {...} } }
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { gammaSurvival } = require("../src/distributions.js");

const ROOT = path.join(__dirname, "..");
const league = JSON.parse(fs.readFileSync(path.join(ROOT, "config/league.json"), "utf8"));
const cfg = league.scoring;

const K_MAX = 14; // survival series terminates by k ~ 12 (Part V.1)

function floorTerm(gamma, yardsPerPoint) {
  if (!gamma) return 0;
  let s = 0;
  for (let k = 1; k <= K_MAX; k++) {
    s += gammaSurvival(yardsPerPoint * k, gamma.shape, gamma.scale);
  }
  return s;
}

function bonusTerm(gamma, tiers) {
  if (!gamma || !tiers || !tiers.length) return 0;
  let s = 0;
  for (const t of tiers) {
    const pMin = gammaSurvival(t.min, gamma.shape, gamma.scale);
    const pMax = t.max === null || t.max === undefined
      ? 0
      : gammaSurvival(t.max + 1, gamma.shape, gamma.scale);
    s += t.points * (pMin - pMax);
  }
  return s;
}

function expectedPointsPerGame(p) {
  const g = p.gammas || {};
  let e = 0;
  // touchdowns (linear in lambda) — rush/rec at 6, passing at its own rate
  e += cfg.touchdowns.rushing * (p.lambda || 0); // lambda covers rush+rec TD, both 6
  e += cfg.touchdowns.passing * (p.pass_td_pg || 0);
  e += cfg.turnovers.interception_thrown * (p.int_pg || 0);
  // floored yardage, per category, independently
  e += floorTerm(g.rush, cfg.yardage_floors.rushing.yards_per_point);
  e += floorTerm(g.rec, cfg.yardage_floors.receiving.yards_per_point);
  e += floorTerm(g.pass, cfg.yardage_floors.passing.yards_per_point);
  // non-stacking bonuses: tiers in config are disjoint by construction
  e += bonusTerm(g.rush, cfg.yardage_bonuses.rushing);
  e += bonusTerm(g.rec, cfg.yardage_bonuses.receiving);
  e += bonusTerm(g.pass, cfg.yardage_bonuses.passing);
  return e;
}

const rows = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = rows.map((p) => ({ id: p.id, ef_pg: expectedPointsPerGame(p) }));
fs.writeFileSync(process.argv[3], JSON.stringify(out));
console.log(`[project] expected points for ${out.length} players via survival-sum`);
