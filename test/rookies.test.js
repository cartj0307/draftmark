"use strict";
const fs = require("fs");
const path = require("path");
const dist = require("../src/distributions.js");
const intel = require("../src/intel.js");
intel.useGammaSurvival(dist.gammaSurvival);

const ROOT = path.join(__dirname, "..");
const league = JSON.parse(fs.readFileSync(path.join(ROOT, "config/league.json"), "utf8"));
const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, "data/bundle.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const P = bundle.players;
const rookies = P.filter((p) => p.td_model.fitted_from === "rookie_draft_capital");

ok("no player has a null yardage model",
   P.every((p) => p.yardage_model), String(P.filter((p) => !p.yardage_model).length));
ok("rookies exist and are identified", rookies.length > 100, String(rookies.length));
ok("every rookie carries a yardage model", rookies.every((p) => p.yardage_model));
ok("every rookie has a non-zero lambda", rookies.every((p) => p.td_model.lambda_base > 0));

{
  const rbs = rookies.filter((p) => p.position === "RB");
  const lams = new Set(rbs.map((p) => p.td_model.lambda_base.toFixed(4)));
  ok("rookie RBs are not all assigned one identical lambda",
     lams.size > 5, `${lams.size} distinct values across ${rbs.length} RBs`);
  const games = new Set(rookies.map((p) => p.availability.expected_games));
  ok("rookie availability is differentiated, not a constant 4.6",
     games.size > 5 && !(games.size === 1 && games.has(4.6)), `${games.size} distinct`);
}
{
  const withPick = rookies
    .map((p) => ({ p, pick: (p.notes.find((n) => n.includes("pick ")) || "").match(/pick (\d+)/) }))
    .filter((x) => x.pick && x.p.position === "WR")
    .map((x) => ({ lam: x.p.td_model.lambda_base, pick: +x.pick[1] }))
    .sort((a, b) => a.pick - b.pick);
  ok("more rookie WRs with known draft slots than a handful", withPick.length >= 6,
     String(withPick.length));
  const early = withPick.slice(0, 3).reduce((s, x) => s + x.lam, 0) / 3;
  const late = withPick.slice(-3).reduce((s, x) => s + x.lam, 0) / 3;
  ok(`early-round rookie WRs project above late-round (${early.toFixed(3)} vs ${late.toFixed(3)})`,
     early > late);
}

{
  const players = P.map((p) => ({
    id: p.draftmark_id, name: p.name, position: p.position,
    td_model: p.td_model, yardage_model: p.yardage_model, availability: p.availability,
    rookie: p.td_model.fitted_from === "rookie_draft_capital",
  }));
  const { values } = intel.computeValues(players, league);
  for (const pos of ["RB", "WR", "TE"]) {
    const at = players.filter((x) => x.position === pos && values.has(x.id))
      .sort((a, b) => values.get(b.id).vor - values.get(a.id).vor);
    ok(`the top ${pos} is an established player, not a rookie`, !at[0].rookie,
       at[0].name);
    const topRookie = at.findIndex((x) => x.rookie);
    ok(`best ${pos} rookie is not top-2 at the position (rank ${topRookie + 1})`,
       topRookie >= 2, `${at[topRookie] && at[topRookie].name} at ${topRookie + 1}`);
  }
  // and no rookie may exceed the best veteran lambda at his position
  for (const pos of ["RB", "WR", "TE", "QB"]) {
    const vets = P.filter((p) => p.position === pos && p.td_model.fitted_from === "2025_opportunity")
      .map((p) => p.td_model.lambda_base);
    const rk = P.filter((p) => p.position === pos && p.td_model.fitted_from === "rookie_draft_capital")
      .map((p) => p.td_model.lambda_base);
    if (!vets.length || !rk.length) continue;
    ok(`no rookie ${pos} lambda exceeds the best veteran`,
       Math.max(...rk) <= Math.max(...vets),
       `rookie ${Math.max(...rk).toFixed(3)} vs vet ${Math.max(...vets).toFixed(3)}`);
  }
}

{
  const maxLam = Math.max(...rookies.map((p) => p.td_model.lambda_base));
  ok(`no rookie exceeds the sustained TD-rate ceiling (max ${maxLam.toFixed(3)}/g)`,
     maxLam <= 1.4, String(maxLam));
  ok("no rookie is projected for more than 16 games",
     rookies.every((p) => p.availability.expected_games <= 16));
}

ok("every rookie carries a note naming its basis",
   rookies.every((p) => p.notes.some((n) => n.startsWith("rookie ("))),
   String(rookies.filter((p) => !p.notes.some((n) => n.startsWith("rookie ("))).length));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
