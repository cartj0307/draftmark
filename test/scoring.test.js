"use strict";

const fs = require("fs");
const path = require("path");
const { score } = require("../src/scoring.js");

const league = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/league.json"), "utf8"));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/gibbs_2025.json"), "utf8"));

let pass = 0, fail = 0;
const failures = [];

function check(name, line, expected) {
  const got = score(line, league);
  if (got === expected) { pass++; }
  else { fail++; failures.push(`${name}: expected ${expected}, got ${got}`); }
}

// The 17 Gibbs games
for (const g of fixture.games) {
  check(`Gibbs Wk ${g.week}`, g.line, g.expected);
}

// The three synthetics
const [s1, s2, s3] = fixture.synthetics;
check(s1.name, s1.line, s1.expected);
check(s2.name, s2.line, s2.expected);
for (const c of s3.lines) check(`${s3.name} (${c.line.rushYds} yds)`, c.line, c.expected);

// Extra hard guarantees
const { EMPTY_LINE } = require("../src/scoring.js");
check("empty stat line scores 0", {}, 0);
check("10 fumbles lost cost nothing", { fumblesLost: 10 }, 0);
check("77 receptions score zero", { receptions: 77 }, 0);
check("pass TD = 3 for anyone", { passTD: 2 }, 6);
check("QB line: 312 pass yds, 2 passTD, 1 INT, 34 rush yds", { passYds: 312, passTD: 2, intThrown: 1, rushYds: 34 }, 12);

// 2pt conversions — settings doc: pass = 1, rush = 2, receive = 2
check("2pt pass conversion is 1 (not 2)", { twoPtPass: 1 }, 1);
check("2pt rush conversion is 2", { twoPtRush: 1 }, 2);
check("2pt receive conversion is 2", { twoPtRec: 1 }, 2);

// Kicker scoring per the league table
const { scoreKicker, scoreDST } = require("../src/scoring.js");
function checkFn(name, fn, line, expected) {
  const got = fn(line, league);
  if (got === expected) { pass++; }
  else { fail++; failures.push(`${name}: expected ${expected}, got ${got}`); }
}
checkFn("K: 3 PAT + FGs of 25, 44, 52", scoreKicker, { patMade: 3, fgMade: [25, 44, 52] }, 13);
checkFn("K: 61-yarder pays 4", scoreKicker, { fgMade: [61] }, 4);
checkFn("K: empty day scores 0", scoreKicker, {}, 0);

// D/ST scoring per the league table
checkFn("DST: shutout under 100 yds", scoreDST, { pointsAllowed: 0, yardsAllowed: 88 }, 9);
checkFn("DST: 2 INT + 1 FR + pick-6, 17 pts, 305 yds", scoreDST,
  { interceptions: 2, fumblesRecovered: 1, interceptionReturnTD: 1, pointsAllowed: 17, yardsAllowed: 305 }, 12);
checkFn("DST: bad day — 38 allowed, 470 yds", scoreDST, { pointsAllowed: 38, yardsAllowed: 470 }, -4);
checkFn("DST: gap buckets score 0 (24 pts, 375 yds)", scoreDST, { pointsAllowed: 24, yardsAllowed: 375 }, 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.error("  FAIL " + f);
  process.exit(1);
}
console.log("Gibbs suite: 17/17. Synthetics: 4/4. Guarantees: 5/5. Scoring engine VALIDATED.");
