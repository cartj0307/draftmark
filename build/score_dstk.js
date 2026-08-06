"use strict";
/* Scores D/ST and kicker weekly lines through src/scoring.js (scoreDST /
 * scoreKicker). Input data/interim/dstk_lines.json; output dstk_points.json. */

const fs = require("fs");
const path = require("path");
const { scoreDST, scoreKicker } = require("../src/scoring.js");

const ROOT = path.join(__dirname, "..");
const league = JSON.parse(fs.readFileSync(path.join(ROOT, "config/league.json"), "utf8"));
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, "data/interim/dstk_lines.json"), "utf8"));

const out = rows.map((r) => ({
  kind: r.kind, key: r.key, week: r.week,
  points: r.kind === "dst" ? scoreDST(r.line, league) : scoreKicker(r.line, league),
}));
fs.writeFileSync(path.join(ROOT, "data/interim/dstk_points.json"), JSON.stringify(out));
console.log(`[score_dstk] scored ${out.length} D/ST + kicker weeks through the engine`);
