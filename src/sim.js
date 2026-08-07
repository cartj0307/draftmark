"use strict";

let D = null; // { score, sampleGamma, samplePoisson, sampleNegBin, gaussian, normCdf, expectedWeek }
function configureSim(deps) { D = deps; }

/* ---------------- deterministic RNG (seedable, for CRN across candidates) -- */
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296 + 1e-12;
  };
}

function buildSchedule(slotTier, rng) {
  const n = 12;
  const weeks = [];
  // round robin, slots 1..12
  const arr = [];
  for (let i = 2; i <= n; i++) arr.push(i);
  for (let w = 0; w < 11; w++) {
    const pairs = [[1, arr[(w) % 11]]];
    for (let k = 1; k <= 5; k++) {
      const a = arr[(w + k) % 11], b = arr[(w - k + 22) % 11];
      pairs.push([a, b]);
    }
    weeks.push(pairs);
  }
  // three cross-division weeks: random perfect matchings tier1 x tier2
  const t1 = [], t2 = [];
  for (let s = 1; s <= 12; s++) (slotTier[s] === 1 ? t1 : t2).push(s);
  for (let w = 0; w < 3; w++) {
    const shuffled = [...t2];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    weeks.push(t1.map((s, i) => [s, shuffled[i]]));
  }
  return weeks; // weeks[w] = array of [slotA, slotB]
}

function drawWeek(players, week, mods, rng, cfg) {
  const factors = {}; // nflTeam -> [gPass, gBack]
  const pts = new Int16Array(players.length);
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    // availability: bye or missed week
    if (p.bye === week || (mods.miss[i] & (1 << (week - 1)))) { pts[i] = -32768; continue; }

    if (p.kind === "dstk") {
      const v = p.mean + p.sd * D.gaussian(rng);
      pts[i] = Math.max(-6, Math.round(v));
      continue;
    }
    let f = factors[p.team];
    if (!f) f = factors[p.team] = [D.gaussian(rng), D.gaussian(rng)];
    const gP = f[0], gB = f[1];
    const talent = mods.talent[i];

    // ---- correlated TD count (drawn first — 62% of the outcome) ----
    const zTD = p.loadPass * gP + p.loadBack * gB + p.residTD * D.gaussian(rng);
    const uTD = D.normCdf(zTD);
    const lam = (p.lamWeekly[week - 1] ?? p.lamBase) * talent;
    let n = 0;
    if (lam > 0) {
      let rate = lam;
      if (p.phi < 100) rate = D.sampleGamma(p.phi, lam / p.phi, rng);
      let cdf = Math.exp(-rate), pmf = cdf;
      while (uTD > cdf && n < 8) { n++; pmf *= rate / n; cdf += pmf; }
    }
    const line = { rushTD: n };

    if (p.gRec) {
      const z = p.recLoad * gP + p.recResid * D.gaussian(rng);
      line.recYds = Math.round(gammaQuantileWH(p.gRec.shape, p.gRec.scale, z, rng) * talent);
    }
    if (p.gRush) {
      const z = p.rushLoad * gB + p.rushResid * D.gaussian(rng);
      line.rushYds = Math.round(gammaQuantileWH(p.gRush.shape, p.gRush.scale, z, rng) * talent);
    }
    if (p.passTdPg > 0.01) {
      const z = 0.55 * gP + p.passResid * D.gaussian(rng);
      const u = D.normCdf(z);
      const plam = p.passTdPg * talent;
      let m = 0, cdf = Math.exp(-plam), pmf = cdf;
      while (u > cdf && m < 8) { m++; pmf *= plam / m; cdf += pmf; }
      line.passTD = m;
    }
    if (p.gPass) {
      const z = 0.5 * gP + 0.8660254 * D.gaussian(rng);
      line.passYds = Math.round(gammaQuantileWH(p.gPass.shape, p.gPass.scale, z, rng) * talent);
    }
    if (p.intPg > 0.01) line.intThrown = D.samplePoisson(p.intPg, rng);

    pts[i] = D.score(line, cfg);
  }
  return pts;
}

function gammaQuantileWH(shape, scale, z, rng) {
  if (shape < 0.25) return D.sampleGamma(shape, scale, rng);
  const c = 1 - 1 / (9 * shape) + z / (3 * Math.sqrt(shape));
  return Math.max(0, shape * scale * c * c * c);
}

function lineupScore(rosterIdx, players, realized, ew, week, starters) {
  const byPos = { QB: [], RB: [], WR: [], TE: [], DST: [], K: [] };
  for (const i of rosterIdx) {
    const p = players[i];
    if (realized[i] === -32768) continue;           // bye / out: not startable
    if (byPos[p.position]) byPos[p.position].push(i);
  }
  let total = 0, qbPts = 0;
  for (const [pos, need] of Object.entries(starters)) {
    const list = byPos[pos];
    list.sort((a, b) => ew[b][week - 1] - ew[a][week - 1]);   // chosen by expectation
    for (let k = 0; k < need && k < list.length; k++) {
      total += realized[list[k]];                              // scored by outcome
      if (pos === "QB") qbPts += realized[list[k]];
    }
  }
  return { total, qbPts };
}

function prepareSimPlayers(playersIn, league) {
  const players = playersIn.map((p) => {
    if (p.kind === "dstk") {
      return { id: p.id, kind: "dstk", position: p.position, team: p.team,
               bye: p.bye, mean: p.mean, sd: p.sd, expGames: 17 };
    }
    const tm = p.td_model, ym = p.yardage_model || {};
    const isQB = p.position === "QB";
    const isRB = p.position === "RB";
    return {
      id: p.id, kind: "skill", position: p.position, team: p.team, bye: p.bye,
      lamBase: tm.lambda_base, lamWeekly: tm.lambda_weekly || [], phi: tm.dispersion,
      passTdPg: tm.pass_td_pg || 0, intPg: tm.int_pg || 0,
      // drop categories whose weekly mean can't meaningfully reach a 25-yd
      // floor increment (saves a gaussian + quantile per player-week; the
      // omitted expectation is < ~0.05 pt/wk)
      gRush: (ym.rush && ym.rush.mean_pg >= 3) ? ym.rush : null,
      gRec: (ym.rec && ym.rec.mean_pg >= 3) ? ym.rec : null,
      gPass: (isQB && ym.pass && ym.pass.mean_pg >= 30) ? ym.pass : null,
      loadPass: isQB ? 0.55 : (p.position === "WR" || p.position === "TE") ? 0.45 : 0.15,
      loadBack: isRB ? 0.45 : 0,
      recLoad: 0.45, rushLoad: isRB ? 0.45 : 0.2,
      expGames: (p.availability && p.availability.expected_games) || 15,
    };
  });
  const rbByTeam = {};
  players.forEach((p, i) => { if (p.kind === "skill" && p.position === "RB") (rbByTeam[p.team] = rbByTeam[p.team] || []).push(i); });
  for (const idxs of Object.values(rbByTeam)) {
    idxs.sort((a, b) => players[b].lamBase - players[a].lamBase);
    idxs.forEach((pi, rank) => { if (rank % 2 === 1) { players[pi].loadBack = -0.45; players[pi].rushLoad = -0.45; } });
  }
  // precompute residual weights so no sqrt runs inside the hot loop
  for (const p of players) {
    if (p.kind !== "skill") continue;
    p.residTD = Math.sqrt(Math.max(0, 1 - p.loadPass * p.loadPass - p.loadBack * p.loadBack));
    p.recResid = Math.sqrt(Math.max(0, 1 - p.recLoad * p.recLoad));
    p.rushResid = Math.sqrt(Math.max(0, 1 - p.rushLoad * p.rushLoad));
    p.passResid = Math.sqrt(1 - 0.55 * 0.55);
  }

  const ew = players.map((p) => {
    const arr = new Float32Array(17);
    for (let w = 1; w <= 17; w++) {
      if (p.bye === w) { arr[w - 1] = -1; continue; }
      if (p.kind === "dstk") { arr[w - 1] = p.mean; continue; }
      arr[w - 1] = D.expectedWeek(
        { td_model: { lambda_base: p.lamBase, lambda_weekly: p.lamWeekly, pass_td_pg: p.passTdPg, int_pg: p.intPg, dispersion: p.phi },
          yardage_model: { rush: p.gRush, rec: p.gRec, pass: p.gPass } },
        p.lamWeekly[w - 1] ?? p.lamBase, league.scoring);
    }
    return arr;
  });
  return { players, ew };
}

function runChampionshipSim(rosters, prepared, league, slotTier, opts = {}) {
  const N = opts.seasons || 2000;
  const rng = makeRng(opts.seed || 12345);
  const { players, ew } = prepared;
  const starters = league.roster.starters;
  const cfg = league;
  const titles = {}, playoffs = {};
  for (let s = 1; s <= 12; s++) { titles[s] = 0; playoffs[s] = 0; }
  const rosterPos = {};
  for (let s = 1; s <= 12; s++) {
    const g = { QB: [], RB: [], WR: [], TE: [], DST: [], K: [] };
    for (const i of rosters[s]) { const pos = players[i].position; if (g[pos]) g[pos].push(i); }
    rosterPos[s] = g;
  }
  const onProgress = opts.onProgress || null;

  for (let sim = 0; sim < N; sim++) {
    // season modifiers: talent multiplier (lognormal sigma .18), missed weeks bitmask
    const mods = { talent: new Float32Array(players.length), miss: new Int32Array(players.length) };
    for (let i = 0; i < players.length; i++) {
      mods.talent[i] = Math.exp(0.18 * D.gaussian(rng) - 0.5 * 0.18 * 0.18);
      const pMiss = Math.max(0, 1 - players[i].expGames / 17);
      let mask = 0;
      for (let w = 0; w < 17; w++) if (rng() < pMiss) mask |= (1 << w);
      mods.miss[i] = mask;
    }
    const schedule = buildSchedule(slotTier, rng);

    const wins = {}, pf = {}, qbpf = {};
    for (let s = 1; s <= 12; s++) { wins[s] = 0; pf[s] = 0; qbpf[s] = 0; }

    for (let w = 1; w <= 14; w++) {
      const realized = drawWeek(players, w, mods, rng, cfg);
      const scores = {};
      for (let s = 1; s <= 12; s++) {
        const r = lineupScoreFast(rosterPos[s], players, realized, ew, w, starters);
        scores[s] = r; pf[s] += r.total; qbpf[s] += r.qbPts;
      }
      for (const [a, b] of schedule[w - 1]) {
        const sa = scores[a], sb = scores[b];
        if (sa.total > sb.total) wins[a]++;
        else if (sb.total > sa.total) wins[b]++;
        else (sa.qbPts >= sb.qbPts ? wins[a]++ : wins[b]++);   // QB-points tiebreak
      }
    }
    const order = [];
    for (let s = 1; s <= 12; s++) order.push(s);
    order.sort((a, b) => wins[b] - wins[a] || pf[b] - pf[a]);
    const seeds = order.slice(0, 6);
    for (const s of seeds) playoffs[s]++;
    const poWeek = {};
    const h2h = (a, b, w) => {
      const realized = poWeek[w] || (poWeek[w] = drawWeek(players, w, mods, rng, cfg));
      const ra = lineupScoreFast(rosterPos[a], players, realized, ew, w, starters);
      const rb = lineupScoreFast(rosterPos[b], players, realized, ew, w, starters);
      if (ra.total !== rb.total) return ra.total > rb.total ? a : b;
      return ra.qbPts >= rb.qbPts ? a : b;
    };
    const w45 = h2h(seeds[3], seeds[4], 15);
    const w36 = h2h(seeds[2], seeds[5], 15);
    const f1 = h2h(seeds[0], w45, 16);
    const f2 = h2h(seeds[1], w36, 16);
    const champ = h2h(f1, f2, 17);
    titles[champ]++;

    if (onProgress && (sim + 1) % Math.max(1, Math.floor(N / 20)) === 0) {
      onProgress(sim + 1, N, titles);
    }
  }
  const out = {}, po = {};
  for (let s = 1; s <= 12; s++) { out[s] = titles[s] / N; po[s] = playoffs[s] / N; }
  // MC half-width for a probability p at N seasons (~95%)
  const band = (p) => 1.96 * Math.sqrt(Math.max(p * (1 - p), 1e-6) / N);
  return { titles: out, playoffs: po, seasons: N, band };
}
function lineupScoreFast(posGroups, players, realized, ew, week, starters) {
  let total = 0, qbPts = 0;
  for (const pos in starters) {
    const need = starters[pos];
    const list = posGroups[pos];
    // select the `need` best-by-expectation available players (need is 1 or 2)
    let b1 = -1, b2 = -1;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      if (realized[i] === -32768) continue;
      const e = ew[i][week - 1];
      if (b1 === -1 || e > ew[b1][week - 1]) { b2 = b1; b1 = i; }
      else if (need > 1 && (b2 === -1 || e > ew[b2][week - 1])) { b2 = i; }
    }
    if (b1 !== -1) { total += realized[b1]; if (pos === "QB") qbPts += realized[b1]; }
    if (need > 1 && b2 !== -1) { total += realized[b2]; if (pos === "QB") qbPts += realized[b2]; }
  }
  return { total, qbPts };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { configureSim, makeRng, buildSchedule, drawWeek, lineupScore, lineupScoreFast, gammaQuantileWH,
                     prepareSimPlayers, runChampionshipSim };
}
