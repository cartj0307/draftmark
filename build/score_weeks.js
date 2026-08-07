"use strict";

const fs = require("fs");
const path = require("path");
const { score } = require("../src/scoring.js");

const ROOT = path.join(__dirname, "..");
const league = JSON.parse(fs.readFileSync(path.join(ROOT, "config/league.json"), "utf8"));

const rows = JSON.parse(fs.readFileSync(path.join(ROOT, "data/interim/player_weeks.json"), "utf8"));

const out = rows.map((r) => ({
  gsis_id: r.gsis_id,
  season: r.season,
  week: r.week,
  position: r.position,
  team: r.team,
  opponent: r.opponent ?? null,
  points: score(
    {
      passYds: r.passing_yards || 0,
      rushYds: r.rushing_yards || 0,
      recYds: r.receiving_yards || 0,
      passTD: r.passing_tds || 0,
      rushTD: r.rushing_tds || 0,
      recTD: r.receiving_tds || 0,
      intThrown: r.passing_interceptions || 0,
      receptions: r.receptions || 0,
    },
    league
  ),
}));

fs.writeFileSync(path.join(ROOT, "data/interim/player_week_points.json"), JSON.stringify(out));
console.log(`[score_weeks] scored ${out.length} player-weeks through the validated engine`);
