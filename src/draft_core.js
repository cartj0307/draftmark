"use strict";

function generateOrder(teams, rounds) {
  const cells = [];
  let overall = 1;
  for (let round = 1; round <= rounds; round++) {
    const ascending = round <= 2 || round % 2 === 0;
    for (let i = 0; i < teams; i++) {
      const slot = ascending ? i + 1 : teams - i;
      cells.push({ overall: overall++, round, slot });
    }
  }
  return cells;
}

function picksForSlot(cells, slot) {
  return cells.filter((c) => c.slot === slot).map((c) => c.overall);
}

function fold(events, config) {
  const teams = config.teams;
  const rounds = config.draft.rounds;
  const cells = generateOrder(teams, rounds);

  // resolution pass: voided targets and last-surviving amend per target
  const voided = new Set();
  for (const e of events) if (e.type === "VOID") voided.add(e.targetId);
  const amended = new Map(); // targetId -> playerId (latest non-voided AMEND)
  for (const e of events) {
    if (e.type === "AMEND" && !voided.has(e.id)) amended.set(e.targetId, e.playerId);
  }

  const live = (e) => !voided.has(e.id);
  const playerOf = (e) => (amended.has(e.id) ? amended.get(e.id) : e.playerId);

  let setup = null;
  const filled = new Map(); // overall -> { playerId, eventId, keeper }
  const errors = [];

  // keepers occupy their slot's round-1 cell before any live pick
  for (const e of events) {
    if (e.type === "SETUP" && live(e)) setup = e;
    if (e.type === "KEEPER" && live(e)) {
      const cell = cells.find((c) => c.round === 1 && c.slot === e.slot);
      if (filled.has(cell.overall)) {
        errors.push(`duplicate keeper for slot ${e.slot}`);
        continue;
      }
      filled.set(cell.overall, { playerId: playerOf(e), eventId: e.id, keeper: true });
    }
  }

  // live picks fill sequential open cells
  for (const e of events) {
    if (e.type !== "PICK" || !live(e)) continue;
    const cell = cells.find((c) => !filled.has(c.overall));
    if (!cell) {
      errors.push("pick beyond final cell");
      continue;
    }
    filled.set(cell.overall, { playerId: playerOf(e), eventId: e.id, keeper: false });
  }

  // derived views
  const taken = new Map(); // playerId -> overall (duplicates -> errors)
  const rosters = {};
  for (let s = 1; s <= teams; s++) rosters[s] = [];
  const board = cells.map((c) => {
    const f = filled.get(c.overall) || null;
    if (f) {
      if (taken.has(f.playerId)) {
        errors.push(`player ${f.playerId} selected twice (picks ${taken.get(f.playerId)} and ${c.overall})`);
      } else {
        taken.set(f.playerId, c.overall);
      }
      rosters[c.slot].push({
        playerId: f.playerId, overall: c.overall, round: c.round,
        keeper: f.keeper, eventId: f.eventId,
      });
    }
    return { ...c, ...(f || { playerId: null, eventId: null, keeper: false }) };
  });

  const current = board.find((c) => !c.playerId) || null;
  const yourSlot = setup ? setup.yourSlot : null;
  let untilYou = null;
  if (current && yourSlot) {
    const idx = board.indexOf(current);
    for (let i = idx; i < board.length; i++) {
      if (board[i].slot === yourSlot) { untilYou = i - idx; break; }
    }
  }

  return {
    setup,
    board,
    rosters,
    takenIds: taken,
    current,               // the cell on the clock (null when draft complete)
    onClockSlot: current ? current.slot : null,
    untilYou,              // 0 = you are on the clock
    complete: !current,
    errors,                // warn, never block (Part IV.7)
  };
}

function rosterView(picks, playersById, rosterCfg) {
  const seats = [];
  for (const [pos, n] of Object.entries(rosterCfg.starters)) {
    for (let i = 0; i < n; i++) seats.push({ kind: "starter", pos, player: null });
  }
  for (let i = 0; i < rosterCfg.bench; i++) seats.push({ kind: "bench", pos: null, player: null });
  const overflow = [];
  const counts = {};
  for (const pk of picks) {
    const p = playersById[pk.playerId];
    const pos = p ? p.position : "?";
    counts[pos] = (counts[pos] || 0) + 1;
    const starter = seats.find((s) => s.kind === "starter" && s.pos === pos && !s.player);
    const bench = seats.find((s) => s.kind === "bench" && !s.player);
    const seat = starter || bench;
    if (seat) seat.player = { ...pk, position: pos };
    else overflow.push({ ...pk, position: pos });
  }
  const warnings = [];
  for (const [pos, max] of Object.entries(rosterCfg.position_max)) {
    if ((counts[pos] || 0) > max) warnings.push(`${pos} over league max (${counts[pos]}/${max})`);
  }
  if (overflow.length) warnings.push(`${overflow.length} pick(s) beyond roster size`);
  return { seats, overflow, counts, warnings };
}


function normName(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, "");
}

function searchPool(pool, query, posFilter) {
  const q = normName(query || "").trim();
  let list = pool;
  if (posFilter && posFilter !== "ALL") list = list.filter((p) => p.position === posFilter);
  const rank = (p) => (p.sortVal !== undefined && p.sortVal !== null) ? p.sortVal : (p.xtd || 0) - 1e6;
  if (!q) {
    return [...list].sort((a, b) => rank(b) - rank(a));
  }
  const scored = [];
  for (const p of list) {
    const n = p.searchName;
    let s = -1;
    if (n.startsWith(q)) s = 3;
    else if (n.split(" ").some((w) => w.startsWith(q))) s = 2;
    else if (n.includes(q)) s = 1;
    else {
      // initials + last name ("jt" -> jonathan taylor, "cmc" style)
      const words = n.split(" ");
      const inits = words.map((w) => w[0]).join("");
      if (inits.startsWith(q)) s = 1.5;
      else if (q.length >= 3 && words.length > 1 && (words[0][0] + words[words.length - 1]).startsWith(q)) s = 1.2;
    }
    if (s > 0) scored.push([s, p]);
  }
  scored.sort((a, b) => b[0] - a[0] || rank(b[1]) - rank(a[1]));
  return scored.map(([, p]) => p);
}

let _seq = 0;
function makeEvent(type, fields, seq) {
  _seq = seq !== undefined ? seq : _seq + 1;
  return {
    id: `e${_seq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    seq: _seq,
    at: Date.now(),
    type,
    ...fields,
  };
}
function resetSeq(n) { _seq = n || 0; }

function latestUndoable(events) {
  const voided = new Set(events.filter((e) => e.type === "VOID").map((e) => e.targetId));
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if ((e.type === "PICK" || e.type === "KEEPER" || e.type === "AMEND") && !voided.has(e.id)) return e;
  }
  return null;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    generateOrder, picksForSlot, fold, rosterView,
    searchPool, normName, makeEvent, resetSeq, latestUndoable,
  };
}
