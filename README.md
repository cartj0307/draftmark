# Draftmark — Phase 1

The validated scoring engine and the data bundle. Everything downstream (board,
rankings, simulator, recommender) consumes what's in this repo.

## What is built and VALIDATED (ran live, real data, no placeholders)

| Piece | Status |
|---|---|
| `config/league.json` | Full ruleset, single source of truth, zero magic numbers in code |
| `src/scoring.js` | Pure function, integer output — **17/17 Gibbs games + 3 synthetics + 5 hard guarantees passing** (`node test/scoring.test.js`) |
| `src/distributions.js` | NB (Gamma-Poisson) sampling, Gamma sampling, Gamma survival/interval — 11 Monte Carlo/analytic tests passing |
| nflverse ingest | Real 2023–2025 play-by-play (146k plays), weekly stats, 2025+2026 rosters, real 2026 schedule, dynastyprocess crosswalk |
| `build/features.py` | Goal-line carries, RZ touches, EZ targets, team RZ environment — sanity-anchored on Gibbs (18 TD, matching the Phase 0 decomposition) |
| `build/build_xref.py` | 950 players on 2026 rosters, **all exact-ID joins, zero unresolved conflicts** (conflicts hard-fail the build) |
| `build/fit_distributions.py` | Opportunity→λ Poisson GLM, dispersion by position, per-player Gamma yardage, defensive multipliers (shrunk 25%), regression flags |
| `build/project.js` | The survival-sum identity (E of the floor is the sum of survivals) — constants from config, never scores a mean stat line |
| `build/backtest.py` | **The Phase 1 gate: PASSES.** Fit on 2023–24 only, projected 2025, Spearman vs realized: model 0.769 vs last-year-points 0.719 (RB +.068, WR +.048, TE +.119) |
| `data/bundle.json` | 0.89 MB, 908 skill players with fitted λ + dispersion + weekly λ path over the **real 2026 schedule** with byes; hard assertion that `projected_points` appears nowhere |

## Findings from the real fit (worth knowing before draft night)

- **The opportunity model confirms the thesis numerically.** Goal-line carries
  carry a coefficient of +1.01 and end-zone targets +0.89, while raw carries
  (+0.04) and targets (+0.10) are nearly irrelevant. The league pays for
  proximity to the end zone, and now that's measured, not asserted.
- **Dispersion: weekly TDs are near-Poisson at the population level.**
  Median variance-to-mean ratio is 0.93–1.01 by position across 2023–2025
  TD-role players. Gibbs 2025 alone shows 1.24 (the Phase 0 number) but his
  own three-season ratio is 1.04. The NB machinery stays (phi is a fitted
  parameter), but expect it to behave close to Poisson.
- **Taylor does NOT flag for negative regression in this fit.** 20 total TD
  against 23.6 fitted from his opportunity — his goal-line volume supported
  the output. Phase 0's rough estimate (12.9 expected) is superseded by the
  fitted model. **Gibbs flags instead** (18 on 11.3 fitted), along with
  Goedert, Josh Allen (rushing), Dart, Harvey, Achane.
- **Known weak spot: QB.** The λ model covers rushing/receiving TDs; passing
  is currently a shrunk per-game rate. Backtest QB rank correlation (0.17)
  trails the naive baseline (0.22). A proper passing model (attempts × TD
  rate × team environment) is the first Phase 1 follow-up — it matters here
  because of the 3-per-pass-TD line and the QB-points matchup tiebreaker.

## Run it

```
python3 build/ingest_nflverse.py      # downloads all raw data (done once)
python3 build/features.py            # play-by-play -> usage + team env
python3 build/build_xref.py          # crosswalk (hard-fails on conflicts)
python3 build/fit_distributions.py   # the model fit (scores weeks via node)
python3 build/emit_bundle.py         # -> data/bundle.json
node test/scoring.test.js            # 26 assertions
node test/distributions.test.js      # 11 assertions
cd build && python3 backtest.py      # the gate
```

Python deps: `pandas pyarrow requests scipy statsmodels`. Node: none (stdlib only).

## Run on YOUR machine (these APIs are unreachable from sandboxed builds)

1. **ESPN** — `python3 build/ingest_espn.py` (priors + ADP into the bundle),
   and `python3 build/ingest_espn.py --backtest` to fetch 2025 preseason
   projections so `backtest.py` can run the model-vs-ESPN half of the gate.
2. **Sleeper** — `python3 build/ingest_sleeper.py` (injury status, depth
   charts, handcuff links). Free, no key. Once per day max.
3. **Vegas** — primary: `python3 build/ingest_odds_espn.py` (ESPN's public
   scoreboard odds — free, keyless, same API family as the projections
   ingest). Fallback that can never break: `python3 build/ingest_vegas_csv.py`
   after hand-filling `data/raw/vegas_manual.csv` from any free odds page
   (~16 rows preseason). Both compute implied totals with the doc's exact
   formula — implied total equals half the game total minus half the spread —
   and emit the identical `vegas_totals.json`, so downstream never knows the
   source. (`ingest_vegas.py`, The Odds API, remains as an optional spare;
   it needs an account and is not the default.)

   Vegas matters least of the three: the lambda model already runs on real
   team red-zone environment from play-by-play and passed its backtest gate
   without a single Vegas number. Implied totals sharpen offseason-changed
   teams and activate the D/ST and kicker projections.

After any of these, rerun `python3 build/emit_bundle.py` — the emitter
consumes their outputs automatically and `meta.pending` shrinks.

## Open items you must supply (no invented numbers)

- ~~D/ST and K scoring tables~~ **CLOSED**: full kicking and D/ST tables are
  now in `config/league.json` from the real ESPN settings, with engine
  functions `scoreKicker` / `scoreDST` and tests (36 assertions total). The
  settings doc also corrected the 2-pt passing conversion to 1 (rush/receive
  stay 2). D/ST and K *projections* still activate with the Vegas ingest.
- ESPN ADP standard deviation isn't exposed by the API; `adp_sd` is estimated
  downstream (Phase 3) from ADP rank until a better source lands.

## Preseason refresh (before draft day)

A few days before your league's draft, refresh the data to catch preseason
moves, injuries, and depth-chart shifts:

```bash
python3 build/ingest_sleeper.py        # injury status, depth charts, handcuffs
python3 build/ingest_espn.py           # ADP + 2026 projections
python3 build/ingest_odds_espn.py      # Vegas implied totals (or use CSV fallback)
python3 build/emit_bundle.py           # rebuild data/bundle.json with all three
python3 build/emit_board.py            # re-inline into app/draftboard.html
```

Then download the new `app/draftboard.html` and you're locked in. The board
carries the fresh data but makes no API calls during the draft — it's fully
offline and persistence-safe from that point forward.

## Phase 2 — the draft board (BUILT AND VALIDATED)

`app/draftboard.html` — one self-contained offline file (0.93 MB) with the
real bundle inlined. Download it, double-click it, it runs; every keystroke
saves to localStorage in your browser (disabled only inside Claude.ai
previews). Rebuild after any bundle refresh with `python3 build/emit_board.py`.

- **Event-sourced** (`src/draft_core.js`): the board is a pure fold of an
  append-only log — KEEPER, PICK, VOID, AMEND. A fix at pick 44 cascades
  correctly through 45–50 on every refold.
- **The non-standard order is tested against your exact picks**: round 1
  straight with keepers auto-consumed, round 2 restarts at slot 1, round 3+
  snakes — slot 11 = 11, 23, 26, 47, 50, 71, 74, … 191.
- **Keyboard-first**: type + Enter drafts to the team on the clock; arrows
  move; Tab cycles position filter; F2 undo; F3 flag target; F4 corrections
  (V void / A amend); F6 scratch space; F8 export; Esc clears.
- **Scratch space** is a true fork — sandbox picks can never touch the live
  log (verified byte-identical after exit).
- **Rails**: your roster with bye collisions and structural-gap escalation on
  the left; on-clock, countdown-to-your-pick, event-ordered recent picks,
  targets, and position-run warnings on the right. Recommendation surface is
  reserved and never reflows (filled in Phase 5).
- **Warn, never block — with one deliberate exception**: duplicate selections
  are recorded and flagged (they can genuinely happen through entry error),
  but roster position limits are ENFORCED at entry, mirroring ESPN: at-limit
  positions vanish from the pool for the receiving team (with a note saying
  so), because ESPN prevents those picks at the source — a pick that cannot
  happen in the real draft must not be recordable here.
- **Tested headlessly against the emitted file itself**
  (`test/board.acceptance.test.js`, jsdom): a full 12-team, 192-pick
  keyboard-only mock with mid-draft undo, void, amend, sandbox, and a
  persistence refold-equivalence check — 31 assertions. This run also caught
  a real NaN-in-JSON bug in the bundle before it could break a browser;
  serialization is now gated with allow_nan=False.

## Phase 3 — the intelligence layer (BUILT AND VALIDATED)

`src/intel.js`, inlined into the board and computed at load (81 ms for 908
players, cached — recomputes nothing heavy per pick):

- **E[F_season] through the survival-sum identity**, matchup-adjusted by the
  weekly λ path over the real 2026 schedule, availability-scaled — verified
  against Monte Carlo through `scoring.js` to within 0.15 pts/week.
- **The QB fix landed**: shrunk pass-TD and INT rates are now in every
  player's `td_model`, so quarterbacks are no longer valued as pure runners.
- **VOR** against the shallow no-flex replacement (QB12/RB24/WR24/TE12). The
  format's re-sort is visible: 7 RBs in the model's top 15, WR compressed.
- **Tiers** as the largest real VOR cliffs (≥4 pts, max 6 tiers), drawn as
  horizontal breaks in position view, T-chips in the ALL view.
- **Cliffs strip** above the pool: how many players remain in each position's
  top tier (warm when ≤2), plus pair-aware **VONA** — "biggest cliff before
  pick N" — which activates automatically once ADP arrives from the ESPN
  ingest (until then it says so, honestly, instead of faking a number).
- **Drill-down** with → on any highlighted player: E/VOR, the weekly λ
  sparkline, dispersion, red-zone usage, actual-vs-fitted TDs, playoff-weeks
  tilt (labeled a tiebreaker), notes.
- 40 headless acceptance assertions including the Phase 3 UI; all suites:
  scoring 36, distributions 11, draft core 40, intel 16.

**Honest caveat:** values are one season of opportunity plus positional
priors. A few rankings will look bold against market (aging vets with elite
end-zone usage rank high). That's partly the league's real signal and partly
missing consensus shrinkage — running `build/ingest_espn.py` once tempers it
and lights up ADP/VONA.

## Phase 4 — the season simulator (BUILT AND VALIDATED)

`src/sim.js` plus real D/ST & kicker models (`build/dst_k_models.py`) — it
turned out Vegas wasn't needed for those: points allowed, yards allowed,
takeaways, return TDs, and kick distances are all in the play-by-play, so
every D/ST and kicker now carries a real 2025 weekly distribution,
engine-scored through `scoreDST`/`scoreKicker` (never a Python copy).

The simulator (Part VI):
- **Correlated weekly draws through the engine**: touchdowns drawn first via a
  Gaussian factor copula (QB↔catcher +, RB↔RB −, D/ST rides its offense),
  passing TDs share the pass-game factor (the stack mechanism), yardage
  through Wilson–Hilferty Gamma quantiles, every sampled line scored by
  `scoring.js`. A player's outcome is drawn once league-wide per week —
  common random numbers by construction.
- **Honest lineups**: seats chosen by pre-week expectation, scored by realized
  outcome; no flex; byes and missed weeks leave real holes.
- **The season path**: per-sim talent multipliers and availability; weeks 1–11
  round robin + three cross-division rematch weeks (sampled until ESPN posts
  the real three); QB-points matchup tiebreak; points-for seeding; 6-team
  bracket, top-2 byes, no reseeding.
- **VI.8 gates all pass** (`test/sim.test.js`): sampled weekly mean matches
  the Phase 3 closed form; lineup legality with holes; correlation signs
  verified on 2026 same-team pairs (Goff↔ARSB +, Taylor↔Giddens −);
  probabilities sum to exactly 1.0; symmetric matchup = coin flip; stacking
  raises weekly variance; ~1.5 ms/season (6k seasons in ~9 s).
- **In the board**: F7 / "Simulate season" streams title odds for all twelve
  teams into the right rail with honest ±bands, your team in accent. Runs in
  a Web Worker assembled from the page's own inlined sources, with a chunked
  main-thread fallback. Works on sandbox rosters too — fork, make hypothetical
  picks, F7, see the equity move, discard.
- One found-and-fixed: an unguarded module export would have silently killed
  the worker in real browsers; caught by the headless run, now guarded
  everywhere. 160 assertions total across six suites.

## Phase 5 — the recommender (BUILT AND VALIDATED)

`src/recommend.js` fills the reserved surface. The moment you're on the
clock, it runs automatically (F9 previews anytime — opponents are simulated
up to your pick first):

1. **Candidate selection**: a deterministic probe completes the draft to your
   pick to see who plausibly survives; candidates are the best survivors by
   value, the best at each position where you still need a starter, and any
   flagged targets — capped at five.
2. **For each candidate**: assume you take him, complete the remaining draft
   for all twelve teams (greedy value + roster need; seeded top-3 jitter for
   opponents; your own future picks honor the lineup-completion funnel and
   position maxes), then run the championship simulator.
3. **Common random numbers**: every candidate is evaluated on the identical
   stream of simulated seasons — same opponent drafts, same injuries, same
   weekly outcomes — so the title-probability difference is the pick's
   signal, not Monte Carlo noise. Batches stream to the surface and stop
   adaptively once the verdict is decisive (or at 1,200 seasons/candidate).
4. **The verdict**: TAKE [name] — the edge (+X% title odds vs the runner-up),
   the because (empty starter seat / tier cliff / stack / raw value), and the
   honesty tax: the ±band, and when the edge is inside the noise floor the
   surface says "coin flip — take either" instead of manufacturing precision.

Runs in a Web Worker assembled from the page's own sources (main-thread
fallback included); every new pick cancels and invalidates the surface; works
in the sandbox. First readable verdict streams in ~2 s, decisive typically
inside 15 s. 198 assertions across seven suites.

## The roadmap is complete

All five phases of the master document are built, tested, and inlined into
one offline file. Remaining sharpeners are data, not code: run the ESPN,
Sleeper, and Vegas ingests before draft day (see "Preseason refresh") to
light up ADP/VONA, injury status, and market-informed priors.
