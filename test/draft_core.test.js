"use strict";

const fs = require("fs");
const path = require("path");
const {
  generateOrder, picksForSlot, fold, rosterView, searchPool, normName,
  makeEvent, resetSeq, latestUndoable,
} = require("../src/draft_core.js");

const league = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/league.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ---- order generation: the non-standard round structure -------------------
const cells = generateOrder(league.teams, league.draft.rounds);
eq("192 cells", cells.length, 192);
eq("slot 11 picks match Part I.6 exactly",
   picksForSlot(cells, 11), league.draft.your_overall_picks);
eq("round 1 straight (pick 12 = slot 12)", cells[11].slot, 12);
eq("round 2 restarts at slot 1 (pick 13)", cells[12].slot, 1);
eq("round 3 snakes (pick 25 = slot 12)", cells[24].slot, 12);
eq("pick 26 = slot 11", cells[25].slot, 11);
eq("final pick 192 = slot 12", cells[191].slot, 12);

// ---- keeper consumption ----------------------------------------------------
resetSeq(0);
const setup = makeEvent("SETUP", {
  teams: Array.from({ length: 12 }, (_, i) => ({ slot: i + 1, name: `Team ${i + 1}` })),
  yourSlot: 11,
});
const kJT = makeEvent("KEEPER", { slot: 11, playerId: "JT" });
const kQB = makeEvent("KEEPER", { slot: 3, playerId: "ALLEN" });
let ev = [setup, kJT, kQB];
let st = fold(ev, league);
eq("keeper occupies your round-1 cell", st.board[10].playerId, "JT");
ok("keeper flagged", st.board[10].keeper === true);
eq("keeper occupies slot 3 cell", st.board[2].playerId, "ALLEN");
eq("first live pick on the clock is pick 1 (slot 1)", st.current.overall, 1);

// live picks skip keeper-consumed cells
for (const p of ["P1", "P2"]) ev.push(makeEvent("PICK", { playerId: p }));
st = fold(ev, league);
eq("pick after slot-2 pick skips keeper cell -> pick 4 on clock", st.current.overall, 4);
// P1 -> cell 1, P2 -> cell 2; cell 3 keeper ALLEN; current cell 4
eq("cell 2 player", st.board[1].playerId, "P2");

// fill through your round-1 keeper: 10 live picks total fill cells 1,2,4..12(minus 11)
for (const p of ["P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"]) ev.push(makeEvent("PICK", { playerId: p }));
st = fold(ev, league);
eq("after 10 live picks + 2 keepers, round 2 pick 13 on clock", st.current.overall, 13);
eq("your countdown to pick 23 is 10", st.untilYou, 10);

// ---- VOID cascade -----------------------------------------------------------
// void P2 (cell 2): every later pick shifts back one cell on refold
const p2evt = ev.find((e) => e.playerId === "P2");
const evVoid = [...ev, makeEvent("VOID", { targetId: p2evt.id })];
let sv = fold(evVoid, league);
eq("VOID returns P2 to pool (not on board)", sv.takenIds.has("P2"), false);
eq("P3 cascades from cell 4 to cell 2", sv.board[1].playerId, "P3");
eq("keeper cell untouched by cascade", sv.board[2].playerId, "ALLEN");
eq("current pick rolls back to 12", sv.current.overall, 12);

// ---- AMEND ------------------------------------------------------------------
const evAmend = [...ev, makeEvent("AMEND", { targetId: p2evt.id, playerId: "P2FIX" })];
let sa = fold(evAmend, league);
eq("AMEND swaps player in place", sa.board[1].playerId, "P2FIX");
eq("old player back in pool", sa.takenIds.has("P2"), false);
eq("later picks unmoved by AMEND", sa.board[3].playerId, "P3");
eq("current pick unchanged", sa.current.overall, 13);

// void the amend -> original restored
const amendEvt = evAmend[evAmend.length - 1];
let sva = fold([...evAmend, makeEvent("VOID", { targetId: amendEvt.id })], league);
eq("VOIDing an AMEND restores the original player", sva.board[1].playerId, "P2");

// duplicate-player legality: warn, never block
let sd = fold([...ev, makeEvent("PICK", { playerId: "P1" })], league);
ok("duplicate selection warns", sd.errors.some((e) => e.includes("selected twice")));
eq("...but is still recorded", sd.board[12].playerId, "P1");

// ---- undo target ------------------------------------------------------------
eq("latest undoable is last pick", latestUndoable(ev).playerId, "P10");
const evU = [...ev, makeEvent("VOID", { targetId: latestUndoable(ev).id })];
eq("after undo, latest undoable is P9", latestUndoable(evU).playerId, "P9");

// ---- export/import round-trip ------------------------------------------------
const json = JSON.stringify(evAmend);
const back = JSON.parse(json);
eq("round-trip fold is byte-identical",
   JSON.stringify(fold(back, league).board), JSON.stringify(fold(evAmend, league).board));

// ---- sandbox isolation --------------------------------------------------------
const sandbox = [...ev];  // fork = copy
sandbox.push(makeEvent("PICK", { playerId: "HYPO" }));
st = fold(ev, league);
ok("sandbox pick never touches the live log", !st.takenIds.has("HYPO"));
eq("live log length unchanged", ev.length, 13);

// ---- roster view ---------------------------------------------------------------
const playersById = {
  JT: { position: "RB" }, W1: { position: "WR" }, W2: { position: "WR" },
  W3: { position: "WR" }, R2: { position: "RB" }, R3: { position: "RB" },
};
const picks = [
  { playerId: "JT", overall: 11, round: 1, keeper: true },
  { playerId: "W1", overall: 23, round: 2 },
  { playerId: "R2", overall: 26, round: 3 },
  { playerId: "W2", overall: 47, round: 4 },
  { playerId: "W3", overall: 50, round: 5 },
  { playerId: "R3", overall: 71, round: 6 },
];
const rv = rosterView(picks, playersById, league.roster);
eq("JT in RB starter seat", rv.seats.find((s) => s.pos === "RB").player.playerId, "JT");
eq("third WR goes to bench",
   rv.seats.filter((s) => s.kind === "bench")[0].player.playerId, "W3");
eq("QB starter seat empty (structural gap visible)",
   rv.seats.find((s) => s.pos === "QB").player, null);
ok("no false position-max warnings", rv.warnings.length === 0);

// ---- search ----------------------------------------------------------------------
const pool = [
  { searchName: normName("Jonathan Taylor"), position: "RB", xtd: 15.3, name: "Jonathan Taylor" },
  { searchName: normName("Tyreek Hill"), position: "WR", xtd: 8.1, name: "Tyreek Hill" },
  { searchName: normName("Tyler Allgeier"), position: "RB", xtd: 4.0, name: "Tyler Allgeier" },
];
eq("prefix beats substring", searchPool(pool, "ty")[0].name, "Tyreek Hill");
eq("last-name word-prefix works", searchPool(pool, "taylor")[0].name, "Jonathan Taylor");
eq("initials match", searchPool(pool, "jt")[0].name, "Jonathan Taylor");
eq("position filter", searchPool(pool, "", "RB").length, 2);
eq("empty query sorts by expected TDs", searchPool(pool, "")[0].name, "Jonathan Taylor");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
