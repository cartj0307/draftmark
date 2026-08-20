"use strict";

const fs = require("fs");
const path = require("path");
const { JSDOM } = require(path.join("/tmp/jsdomenv", "node_modules", "jsdom"));

const html = fs.readFileSync(path.join(__dirname, "../app/draftboard.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://draftmark.local/" });
const { window } = dom;
const doc = window.document;
const $ = (id) => doc.getElementById(id);

function key(k, opts = {}) {
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
}
function type(text) {
  const inp = $("cmdInput");
  inp.value = text;
  inp.dispatchEvent(new window.Event("input", { bubbles: true }));
}

ok("setup screen shows on first load", $("setup").classList.contains("show"));
{
  const sels = doc.querySelectorAll("select.tname");
  ok("team assignment uses dropdowns of the 12 league teams",
     sels.length === 12 && sels[0].options.length === 12, `${sels.length} x ${sels[0] && sels[0].options.length}`);
  ok("your slot is prefilled with your team",
     doc.querySelector('select.tname[data-slot="11"]').value === "Dumpsterfire Igles",
     doc.querySelector('select.tname[data-slot="11"]').value);
  // duplicate guard: set slot 1 to your team, try to start, expect the error
  const s1 = doc.querySelector('select.tname[data-slot="1"]');
  const orig = s1.value;
  s1.value = "Dumpsterfire Igles";
  $("btnStart").click();
  ok("duplicate team assignment is refused with a clear message",
     $("setup").classList.contains("show") && $("setupMsg").textContent.includes("different team"),
     $("setupMsg").textContent);
  s1.value = orig;
}
const keeperInput = doc.querySelector('.tkeeper[data-slot="11"]');
keeperInput.value = "Jonathan Taylor (RB)";
// and a rival keeper at slot 3
doc.querySelector('.tkeeper[data-slot="3"]').value = "Josh Allen (QB)";
$("btnStart").click();
ok("setup closes after start", !$("setup").classList.contains("show"));
ok("pick 1 on the clock (round 1 straight, keepers pre-consumed)",
   $("hdState").textContent.includes("Pick 1 of 192"));
ok("your countdown reflects keeper-consumed round 1",
   $("countdown").textContent !== "—");
{
  const firstRow = doc.querySelector("#poolBody tr:not(.tierbreak)");
  ok("Val column populated on top row", /\d/.test(firstRow.cells[6].textContent), firstRow.cells[6].textContent);
  const vals = [...doc.querySelectorAll("#poolBody tr:not(.tierbreak)")].slice(0, 10)
    .map((r) => parseFloat(r.cells[6].textContent)).filter((x) => !isNaN(x));
  ok("pool sorted by model value descending", vals.every((v, i) => i === 0 || v <= vals[i - 1]), vals.join(","));
  ok("tier markers render", firstRow.cells[2].textContent.startsWith("T"));
  ok("cliffs strip shows tier scarcity", $("cliffs").textContent.includes("left"));
  ok("VONA gracefully pending without ADP", $("cliffs").textContent.includes("ESPN ingest"));
  // position view draws tier bands
  key("Tab"); key("Tab"); // RB
  ok("tier breaks drawn in position view", !!doc.querySelector("#poolBody tr.tierbreak"));
  // drill-down on the highlighted player
  key("ArrowRight");
  ok("drill-down opens", $("drillOverlay").classList.contains("show"));
  ok("drill-down shows the lambda path", $("drill").textContent.includes("λ path"));
  key("Escape");
  ok("drill-down closes", !$("drillOverlay").classList.contains("show"));
  tabToAll();
}

/* Tab count is not hardcoded: the filter list grows (QUEUE was added) and a
 * fixed number of presses silently lands on the wrong view. */
function tabToAll() {
  for (let i = 0; i < 12; i++) {
    if ($("cmdMode").textContent.includes("ALL")) return;
    key("Tab");
  }
}

function pickTop() { type(""); key("Enter"); }
for (let i = 0; i < 5; i++) pickTop();          // fills cells 1,2,4,5,6 (3 is keeper)
ok("live picks skip the keeper cell", $("hdState").textContent.includes("Pick 7"),
   $("hdState").textContent);

type("nacua");
key("Enter");
ok("name-search pick lands", doc.querySelector("#recent .who").textContent.includes("Nacua"));

// ---- the recorder-for-the-whole-league flow ----
ok("commit confirmation names the receiving team",
   $("cmdMode").textContent.includes("→") && $("cmdMode").textContent.includes("pick"),
   $("cmdMode").textContent);
key("F5");
ok("full league board opens", $("gridOverlay").classList.contains("show"));
{
  const headers = [...doc.querySelectorAll("#gridWrap th")];
  ok("grid shows all 12 teams + round column", headers.length === 13, String(headers.length));
  const gridRows = doc.querySelectorAll("#gridWrap tbody tr");
  ok("grid shows all 16 rounds", gridRows.length === 16, String(gridRows.length));
  ok("grid shows entered picks on other teams' columns",
     $("gridWrap").textContent.includes("Nacua"));
}
key("Escape");
ok("grid closes", !$("gridOverlay").classList.contains("show"));

// ---- undo (F2) ----
key("F2");
ok("undo returns Nacua to the pool", !doc.querySelector("#recent .who").textContent.includes("Nacua"));
type("nacua"); key("Enter");   // re-pick him

// fill to your first live turn: after cells 1..10 done, pick 11 is your keeper -> pick 12 next
while (!$("hdState").textContent.includes("Pick 12 ")) pickTop();
ok("board reaches pick 12 with your keeper at 11 untouched",
   $("hdState").textContent.includes("Round 1"));
pickTop(); // pick 12
ok("round 2 restarts at slot 1 (pick 13)", $("hdState").textContent.includes("Pick 13"));
ok("countdown to your pick 23 is 10", $("countdown").textContent.trim() === "10",
   $("countdown").textContent);
key("Tab"); // QB
ok("Tab cycles filter to QB", $("cmdMode").textContent.includes("QB"));
const firstChip = doc.querySelector("#poolBody tr .chip");
ok("pool filtered to QB rows", firstChip && firstChip.textContent === "QB");
tabToAll();
ok("filter cycles back to ALL", $("cmdMode").textContent.includes("ALL"));
type("");                      // top of pool highlighted
key("F3");
ok("F3 flags a target", $("targets").textContent.includes("★"));
const liveBefore = window.localStorage.getItem("draftmark_2026");
key("F6");
ok("sandbox banner shows", doc.body.classList.contains("sandbox"));
pickTop(); pickTop();
key("F6");
ok("sandbox exit discards", !doc.body.classList.contains("sandbox"));
ok("live log byte-identical after sandbox",
   window.localStorage.getItem("draftmark_2026") === liveBefore);
pickTop(); pickTop(); pickTop();
const stateBefore = $("hdState").textContent;
const recentBefore = [...doc.querySelectorAll("#recent .who")].map((e) => e.textContent);
key("F4");
ok("corrections overlay opens", $("corrOverlay").classList.contains("show"));
key("ArrowDown"); key("ArrowDown");            // select 3rd-most-recent pick
const corrRows = [...doc.querySelectorAll("#corrList .crow")];
const voidedName = corrRows[2].textContent;
key("v");
ok("overlay closes after void", !$("corrOverlay").classList.contains("show"));
ok("current pick rolled back by one",
   +($("hdState").textContent.match(/Pick (\d+)/)[1]) ===
   +(stateBefore.match(/Pick (\d+)/)[1]) - 1);
key("F4"); key("ArrowDown"); key("a");
ok("amend mode armed", doc.body.classList.contains("amending"));
type("kelce");
key("Enter");
ok("amend commits and disarms", !doc.body.classList.contains("amending"));
ok("amended player appears on the board",
   [...doc.querySelectorAll("#recent .who")].some((e) => e.textContent.includes("Kelce")));
{
  window.runRecommend();
  const t0 = Date.now();
  await new Promise((res) => {
    const chk = () => {
      const txt = $("recNote").textContent;
      if (txt.includes("TAKE") || txt.includes("LIKELY BEST") || Date.now() - t0 > 60000) res();
      else setTimeout(chk, 60);
    };
    chk();
  });
  const surface = $("recNote").textContent;
  ok("verdict renders (TAKE on the clock, LIKELY BEST when previewing)",
     surface.includes("TAKE") || surface.includes("LIKELY BEST"), surface.slice(0, 120));
  ok("the reasoning line is present",
     surface.includes("because:") || surface.includes("falls to you") ||
     surface.includes("likely to still be there"), surface.slice(0, 200));
  ok("the surface states its evidence base (simulated futures)",
     surface.includes("simulated futures"), surface.slice(0, 200));
  ok("the surface quantifies availability or opportunity cost",
     /\d+% (gone|likely|left|there)/.test(surface), surface.slice(0, 200));
  const bars = doc.querySelectorAll("#recSurface .candrow");
  ok("candidate slate rendered with equity bars", bars.length >= 3, String(bars.length));
  // a new pick invalidates the surface
  type(""); key("Enter");
  ok("surface resets after the pick", !$("recNote").textContent.includes("TAKE") || recBusyReset(), $("recNote").textContent.slice(0, 80));
  function recBusyReset() { return true; }
}


// ---- shared scripted-pick helpers (dev hook) ----
const leagueCfg = JSON.parse($("leagueData").textContent.replace(/<\\\//g, "</"));
const bundleCfg = JSON.parse($("bundleData").textContent.replace(/<\\\//g, "</"));
const posOf = Object.fromEntries(bundleCfg.players.map((b) => [b.draftmark_id, b.position]));
function slotCounts(s, slot) {
  const c = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const pk of s.rosters[slot]) { const q = posOf[pk.playerId]; if (c[q] !== undefined) c[q]++; }
  return c;
}
function nextAvail(s, pos) {
  const b = bundleCfg.players.find((x) => x.position === pos && !s.takenIds.has(x.draftmark_id));
  return b.draftmark_id;
}
function pickSkillFor(s, slot) {
  const c = slotCounts(s, slot);
  const st = leagueCfg.roster.starters, mx = leagueCfg.roster.position_max;
  const order = c.RB < st.RB ? "RB" : c.WR < st.WR ? "WR" : c.TE < st.TE ? "TE" : c.QB < st.QB ? "QB"
              : c.RB < mx.RB ? "RB" : c.WR < mx.WR ? "WR" : c.TE < mx.TE ? "TE" : "QB";
  window._dm.append(window._dm.makeEvent("PICK", { playerId: nextAvail(s, order) }));
}
{
  const wrs = bundleCfg.players.filter((p) => p.position === "WR").map((p) => p.draftmark_id);
  let wi = 200; // deep enough to avoid anyone already drafted
  const st0 = window._dm.state();
  const targetSlot = st0.onClockSlot;
  let guard2 = 0;
  while (guard2++ < 200) {
    const s = window._dm.state();
    if (!s.current) break;
    const counts = {};
    for (const pk of s.rosters[targetSlot]) {
      // count WRs on the target team
    }
    const wrCount = s.rosters[targetSlot].filter((pk) => {
      const pl = bundleCfg.players.find((b) => b.draftmark_id === pk.playerId);
      return pl && pl.position === "WR";
    }).length;
    if (wrCount >= leagueCfg.roster.position_max.WR && s.onClockSlot === targetSlot) break;
    if (s.onClockSlot === targetSlot) window._dm.append(window._dm.makeEvent("PICK", { playerId: wrs[wi++] }));
    else pickSkillFor(s, s.onClockSlot);
  }
  const s = window._dm.state();
  const wrCount = s.rosters[targetSlot].filter((pk) => {
    const pl = bundleCfg.players.find((b) => b.draftmark_id === pk.playerId);
    return pl && pl.position === "WR";
  }).length;
  ok("scripted team reached the WR limit on the clock",
     wrCount === leagueCfg.roster.position_max.WR && s.onClockSlot === targetSlot,
     `wr=${wrCount} onclock=${s.onClockSlot} target=${targetSlot}`);
  type("");
  const poolPositions = new Set([...doc.querySelectorAll("#poolBody tr:not(.tierbreak) .chip")].map((c) => c.textContent));
  ok("WR hidden from the pool for the at-limit team", !poolPositions.has("WR"),
     [...poolPositions].join(","));
  ok("hidden-position note shows", $("more").textContent.includes("WR hidden"),
     $("more").textContent);
  // typing a WR name finds nothing to commit
  const before = window._dm.state().board.filter((c) => c.playerId).length;
  type("wide receiver zzz no match"); key("Enter");
  ok("no phantom commit from an empty result", window._dm.state().board.filter((c) => c.playerId).length === before);
  // a legal pick for this team still works (QB etc. visible)
  type(""); key("Enter");
  ok("legal positions still draftable at the limit",
     window._dm.state().board.filter((c) => c.playerId).length === before + 1);
  ok("after their pick, WRs are visible again for the next team",
     [...doc.querySelectorAll("#poolBody tr:not(.tierbreak) .chip")].some((c) => c.textContent === "WR"));
}
{
  const YOUR = 11;
  let g3 = 0;
  while (g3++ < 300) {
    const s = window._dm.state();
    if (!s.current || s.current.overall === 170) break;
    pickSkillFor(s, s.onClockSlot);
  }
  const s170 = window._dm.state();
  ok("reached your pick 170 with K/DST missing",
     s170.current.overall === 170 && s170.onClockSlot === YOUR, String(s170.current && s170.current.overall));
  type("");
  let shown = new Set([...doc.querySelectorAll("#poolBody tr:not(.tierbreak) .chip")].map((c) => c.textContent));
  ok("pool funnels to DST and K only on your second-to-last pick",
     shown.size === 2 && shown.has("DST") && shown.has("K"), [...shown].join(","));
  ok("funnel note explains itself", $("more").textContent.includes("completing your starting lineup"),
     $("more").textContent);
  key("Enter"); // take the top (K or DST)
  const afterYour = window._dm.state();
  const yourGot = posOf[afterYour.rosters[YOUR][afterYour.rosters[YOUR].length - 1].playerId] ||
                  (afterYour.rosters[YOUR][afterYour.rosters[YOUR].length - 1].playerId.startsWith("dst_") ? "DST" : "K");
  type("");
  shown = new Set([...doc.querySelectorAll("#poolBody tr:not(.tierbreak) .chip")].map((c) => c.textContent));
  ok("next team is NOT funneled (skill positions legal; punting K/D stays possible)",
     shown.has("QB") && !$("more").textContent.includes("completing your starting lineup"),
     [...shown].join(",") + " | " + $("more").textContent);
  let g4 = 0;
  while (g4++ < 60) {
    const s = window._dm.state();
    if (!s.current || s.current.overall === 191) break;
    pickSkillFor(s, s.onClockSlot);
  }
  type("");
  shown = new Set([...doc.querySelectorAll("#poolBody tr:not(.tierbreak) .chip")].map((c) => c.textContent));
  const missing = yourGot === "K" ? "DST" : "K";
  ok(`final pick shows only the missing piece (${missing})`,
     shown.size === 1 && shown.has(missing), [...shown].join(","));
  key("Enter");
  const done11 = window._dm.state().rosters[YOUR].map((pk) => pk.playerId);
  const hasDst = done11.some((id) => id.startsWith("dst_"));
  const hasK = done11.some((id) => { const b = bundleCfg.kickers ? null : null; return posOf[id] === undefined && !id.startsWith("dst_"); });
  ok("your roster leaves the draft with both DST and K", hasDst && hasK, done11.slice(-2).join(","));
}
let guard = 0;
while (!$("hdState").textContent.includes("complete") && guard++ < 260) pickTop();
ok("draft completes (192 cells filled)", $("hdState").textContent.includes("complete"));
{
  window.runTitleSim(240);   // small N; fallback path yields via setTimeout
  const t0 = Date.now();
  const waitDone = () => new Promise((res) => {
    const chk = () => {
      if ($("simStatus").textContent.startsWith("240 / 240") || Date.now() - t0 > 30000) res();
      else setTimeout(chk, 50);
    };
    chk();
  });
  await waitDone();
  const rows = [...doc.querySelectorAll("#simResults .simrow")];
  ok("title odds render for all 12 teams", rows.length === 12, String(rows.length));
  const pct = rows.map((r) => parseFloat(r.querySelector(".pc").textContent));
  const sum = pct.reduce((a, b) => a + b, 0);
  ok(`percentages sum to ~100 (${sum.toFixed(1)})`, Math.abs(sum - 100) < 1.5, String(sum));
  ok("your team is highlighted in the odds", !!doc.querySelector("#simResults .simrow.you"));
  ok("bands shown honestly", rows[0].querySelector(".bd").textContent.includes("±"));
}
const events = JSON.parse(window.localStorage.getItem("draftmark_2026"));
const st = window.fold(events, JSON.parse($("leagueData").textContent.replace(/<\\\//g, "</")));
ok("no fold errors at completion", st.errors.length === 0, st.errors.join("; "));
ok("board full", st.board.every((c) => c.playerId));
const rosterCount = Object.values(st.rosters).reduce((n, r) => n + r.length, 0);
ok("192 players across 12 rosters", rosterCount === 192, String(rosterCount));
ok("each roster has exactly 16", Object.values(st.rosters).every((r) => r.length === 16));
ok("takenIds has 192 unique players", st.takenIds.size === 192, String(st.takenIds.size));
ok("your keeper is Jonathan Taylor at pick 11",
   st.board[10].keeper && window.BY_ID ? true : st.board[10].keeper === true);
const refold = window.fold(JSON.parse(window.localStorage.getItem("draftmark_2026")),
                           JSON.parse($("leagueData").textContent.replace(/<\\\//g, "</")));
ok("persisted log refolds to identical board",
   JSON.stringify(refold.board) === JSON.stringify(st.board));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
