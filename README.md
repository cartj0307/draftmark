# Draftmark

Draft board and projection model for the Penn-Ohio Football League.

## League

12 teams, ESPN head-to-head points. No flex. 6 pts rushing/receiving TD, 3 pts
passing TD. Rules in config/league.json.

Draft order: round 1 straight, round 2 restarts at slot 1, round 3+ snake.
Slot 11 picks: 11, 23, 26, 47, 50, 71, 74, 95, 98, 119, 122, 143, 146, 167,
170, 191.

## Build

    python build/ingest_nflverse.py
    python build/build_xref.py
    python build/ingest_sleeper.py
    python build/ingest_espn.py
    python build/ingest_odds_espn.py
    python build/emit_bundle.py
    python build/emit_board.py

Output: app/draftboard.html

build_xref.py hard-fails on ID conflicts. Add overrides to
config/xref_overrides.json.

The three ingest scripts are optional. emit_bundle.py skips missing inputs.

features.py, fit_distributions.py, dst_k_models.py and rookie_model.py read
only 2023-2025 play by play. Rerun only if that data changes.

## Requirements

    pip install pandas numpy pyarrow requests scipy statsmodels

Node required. backtest.py, dst_k_models.py and fit_distributions.py call node
to run src/scoring.js.

## Board

Open app/draftboard.html in a browser.

Type a name, Enter records the pick for the team on the clock. All 12 teams'
picks get entered.

    Tab   position filter
    F2    undo
    F3    flag target
    F4    corrections
    F5    full league board
    F6    sandbox
    F7    season sim
    F8    export log
    F9    recommendation

State saves to localStorage, per browser per machine. F8 exports the event log.

Position limits are enforced at entry. Own final picks restricted to unfilled
starter seats.

## Model

Touchdowns: Poisson GLM mapping opportunity to per-game rate. Goal line carries
and end zone targets dominate; raw volume is near zero. Features clipped to
training range, capped at max sustained rate, anchored to observed rate by
games played.

Yardage: per-player Gamma. Points from summing survival probabilities, not
scoring a mean stat line.

Passing: pass TD and INT rates blended across three seasons with recency
weights.

Rookies: projected from draft capital, fitted on 2023-2025 first-year outcomes.
Predictions clipped to observed draft-slot range.

D/ST and K: 2025 weekly points regressed to league mean. Year-over-year
correlation 0.08 (DST), 0.13 (K).

Board state: append-only event log. Board is a fold over the log.

Recommender: opportunity cost against a simulated forecast of the next pick.
Opponent model uses measured behavior from the 2023-2025 drafts. No K or DST
before round 7. Starter seats filled before depth in rounds 1-6 at rates
1.00/1.00/1.00/0.97/0.94/0.76.

Season sim: correlated weekly draws, optimal lineups, 14-week schedule plus
6-team bracket.

## Tests

    node test/scoring.test.js            36 assertions, Gibbs 2025 game log
    node test/opponents.test.js          simulated draft vs real league
    node test/vona.test.js               recommender
    node test/board.acceptance.test.js   full draft, jsdom

10 suites under test/.

## Layout

    app/       board template and built html
    build/     pipeline
    src/       scoring, distributions, draft logic, recommender
    test/
    config/    league.json, xref_overrides.json
    data/      raw, interim, bundle.json, league draft logs

