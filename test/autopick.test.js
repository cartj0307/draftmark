"use strict";

/* Drives the auto-drafter and the mock scout through the built board, not
 * through the modules, so the keybindings, the event log and the roster rules
 * are all under test. One JSDOM window throughout: two live windows in one
 * process starve each other's timers and the chunked loops crawl. */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require(path.join("/tmp/jsdomenv", "node_modules", "jsdom"));

const html = fs.readFileSync(path.join(__dirname, "../app/draftboard.html"), "utf8");
const league = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/league.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://draftmark.local/" });
const { window } = dom;
const doc = window.document;
const $ = (id) => doc.getElementById(id);
const key = (k, opts = {}) => doc.dispatchEvent(
  new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
async function until(cond, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(25); }
  return false;
}

$("btnStart").click();
ok("draft started", !$("setup").classList.contains("show"));

const YOU = league.your_slot;
const starters = league.roster.starters;
const posMax = league.roster.position_max;

/* ---- one auto pick fills exactly one cell for the team on the clock ---- */
{
  const before = window._dm.state();
  const slot = before.onClockSlot;
  const overall = before.current.overall;
  key("F10");
  const after = window._dm.state();
  ok("F10 fills the cell on the clock",
     after.current.overall === overall + 1, `${overall} -> ${after.current.overall}`);
  ok("the pick lands on the right team",
     after.rosters[slot].some((pk) => pk.overall === overall));
  key("F2");
  ok("the pick is a normal PICK event, so F2 undoes it",
     window._dm.state().current.overall === overall);
}

/* ---- the DRAFT / QUEUE button ---- */
{
  const st = window._dm.state();
  const onClock = st.untilYou === 0;
  const btn = doc.querySelector("#poolBody .rowbtn");
  ok("every pool row carries an action button", !!btn);
  ok("the button reads QUEUE when it is not your pick",
     onClock || btn.textContent === "QUEUE", btn && btn.textContent);

  /* queue a player, then check the QUEUE tab shows him */
  const target = doc.querySelector("#poolBody tr").dataset.id;
  btn.click();
  ok("clicking QUEUE flags the player",
     doc.querySelector(`#poolBody tr[data-id="${target}"] .rowbtn`).textContent === "QUEUED");
  ok("QUEUE is a filter tab", window.POS_ORDER_HAS_QUEUE !== false &&
     [...doc.querySelectorAll(".pf")].some((e) => e.dataset.p === "QUEUE"));

  [...doc.querySelectorAll(".pf")].find((e) => e.dataset.p === "QUEUE").click();
  ok("the QUEUE tab lists the queued player",
     !!doc.querySelector(`#poolBody tr[data-id="${target}"]`));
  [...doc.querySelectorAll(".pf")].find((e) => e.dataset.p === "ALL").click();
  doc.querySelector(`#poolBody tr[data-id="${target}"] .rowbtn`).click();   // unqueue
}

/* ---- Shift+F10 runs opponents and stops on your clock ---- */
{
  key("F10", { shiftKey: true });
  ok("run-to-your-pick reaches your slot",
     await until(() => window._dm.state().onClockSlot === YOU));
  const st = window._dm.state();
  ok("it did not pick for you", st.rosters[YOU].length === 0, `${st.rosters[YOU].length} picks`);
  ok("every opponent cell before you is filled",
     st.board.filter((c) => c.overall < st.current.overall).every((c) => c.playerId));

  const btn = doc.querySelector("#poolBody .rowbtn");
  ok("the button reads DRAFT on your pick", btn && btn.textContent === "DRAFT",
     btn && btn.textContent);
  const who = doc.querySelector("#poolBody tr").dataset.id;
  const before = st.current.overall;
  btn.click();
  ok("clicking DRAFT records the pick",
     window._dm.state().current.overall === before + 1);
  ok("DRAFT recorded the right player",
     window._dm.state().rosters[YOU].some((pk) => pk.playerId === who));
  key("F2");
  ok("a DRAFT-button pick undoes like any other",
     window._dm.state().current.overall === before);
}

/* ---- F9 must not collapse to kickers and defenses once starters are full --- */
{
  /* fill your starting lineup, then check what the recommender offers */
  const need = { QB: 1, RB: 2, WR: 2, TE: 1 };
  let guard = 0;
  while (guard++ < 400) {
    const st = window._dm.state();
    if (st.complete) break;
    const mine = st.rosters[YOU].map((pk) => window._dm.pos(pk.playerId));
    const short = Object.entries(need).find(([p, n]) =>
      mine.filter((x) => x === p).length < n);
    if (!short && st.rosters[YOU].length >= 6) break;
    if (st.untilYou === 0 && short) {
      const row = [...doc.querySelectorAll("#poolBody tr")]
        .find((tr) => tr.querySelector(".chip") &&
                      tr.querySelector(".chip").textContent === short[0]);
      if (row) { row.querySelector(".rowbtn").click(); continue; }
    }
    key("F10");
  }

  const st = window._dm.state();
  ok("your starting lineup is full before the check",
     ["QB", "RB", "WR", "TE"].every((p) =>
       st.rosters[YOU].filter((pk) => window._dm.pos(pk.playerId) === p).length >=
       league.roster.starters[p]),
     st.rosters[YOU].map((pk) => window._dm.pos(pk.playerId)).join(","));

  if (!st.complete) {
    window.runRecommend();
    await until(() => !doc.getElementById("recNote").textContent.includes("forecasting"));
    const chips = [...doc.querySelectorAll("#recNote .chip")].map((c) => c.textContent);
    const kd = chips.filter((c) => c === "K" || c === "DST").length;
    ok("F9 does not fill the board with kickers and defenses",
       chips.length === 0 || kd < chips.length,
       `${kd} of ${chips.length} are K/DST: ${chips.join(",")}`);
  }
}

/* ---- the mock scout, mid-draft ---- */
{
  const before = window._dm.state();
  const boardBefore = before.board.map((c) => c.playerId).join(",");
  const yourLeft = before.board.filter((c) => !c.playerId && c.slot === YOU).length;

  window.runScout(3);
  ok("scout overlay opens", $("scoutOverlay").classList.contains("show"));
  ok("scout runs all three mocks and reports the count",
     await until(() => $("scoutWrap").textContent.includes("3 auto-drafts ·")),
     $("scoutWrap").textContent.slice(-80));

  const txt = $("scoutWrap").textContent;
  ok("scout stops reporting partial results once finished", !txt.includes("so far"));
  ok("scout leaves the live board untouched",
     window._dm.state().board.map((c) => c.playerId).join(",") === boardBefore);

  const cells = [...doc.querySelectorAll("#scoutWrap td.pk")];
  ok("one row per remaining pick of yours", cells.length === yourLeft,
     `${cells.length} rows vs ${yourLeft} picks`);
  ok("scout reports only picks still ahead of you",
     cells.every((td) => parseInt(td.textContent, 10) >= before.current.overall),
     cells.map((t) => parseInt(t.textContent, 10)).join(","));

  const pcts = (txt.match(/(\d+)%/g) || []).map((x) => parseInt(x, 10));
  ok("every reported share is a real probability",
     pcts.length > 0 && pcts.every((p) => p > 0 && p <= 100), `${pcts.length} values`);

  const early = [...doc.querySelectorAll("#scoutWrap tbody tr")].filter((tr) => {
    const m = tr.querySelector("td.pk").textContent.match(/round (\d+)/);
    return m && +m[1] < 12;
  });
  ok("K and D/ST are hidden in the early rounds",
     early.length > 0 && early.every((tr) => !/\bDST\b/.test(tr.textContent)),
     `${early.length} early rows`);

  key("Escape");
  ok("scout closes on Esc", !$("scoutOverlay").classList.contains("show"));
}

/* ---- Ctrl+F10 completes the whole board ---- */
{
  window.confirm = () => true;
  key("F10", { ctrlKey: true });
  ok("auto-draft completes the board", await until(() => window._dm.state().complete));
  const st = window._dm.state();
  ok("no duplicate players anywhere", st.errors.length === 0, st.errors.join("; "));

  const incomplete = [], overMax = [], doubleKD = [];
  for (let s = 1; s <= league.teams; s++) {
    const c = {};
    for (const pk of st.rosters[s]) {
      const q = window._dm.pos(pk.playerId);
      c[q] = (c[q] || 0) + 1;
    }
    for (const [p, n] of Object.entries(starters)) if ((c[p] || 0) < n) incomplete.push(`${s}:${p}`);
    for (const [p, m] of Object.entries(posMax)) if ((c[p] || 0) > m) overMax.push(`${s}:${p}`);
    for (const p of ["K", "DST"]) if ((c[p] || 0) > 1) doubleKD.push(`${s}:${p}`);
  }
  ok("every team leaves with a full starting lineup", incomplete.length === 0, incomplete.join(","));
  ok("nobody exceeds a league position limit", overMax.length === 0, overMax.join(","));
  ok("nobody rosters two kickers or two defenses", doubleKD.length === 0, doubleKD.join(","));

  const kd = st.board.filter((c) => {
    const q = window._dm.pos(c.playerId);
    return q === "K" || q === "DST";
  });
  ok("K and D/ST all go after round 10",
     kd.length > 0 && kd.every((c) => c.round >= 11),
     kd.filter((c) => c.round < 11).map((c) => `R${c.round}`).join(","));
}

/* ---- the sandbox is the container for throwaway mocks ---- */
{
  const live = window._dm.state().board.map((c) => c.playerId).join(",");
  key("F6");
  ok("sandbox active", doc.body.classList.contains("sandbox"));
  key("F6");
  ok("sandbox discarded", !doc.body.classList.contains("sandbox"));
  ok("live board survived the sandbox round trip",
     window._dm.state().board.map((c) => c.playerId).join(",") === live);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
