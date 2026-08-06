"""
Draftmark — Vegas ingest, PRIMARY path: ESPN's public scoreboard API.
Free, keyless, same API family as the projections ingest. Run on YOUR machine.

    python3 build/ingest_odds_espn.py                 # scan all weeks with posted lines
    python3 build/ingest_odds_espn.py --weeks 1 2 3   # specific weeks only

For each game with posted odds it computes each team's implied total with the
doc's formula (implied total equals half the game total minus half the team's
spread) and averages across all posted games per team. Preseason that's
usually week 1 plus look-ahead lines; in-season rerun weekly.

Writes data/raw/vegas_totals.json — identical shape to every other Vegas
path, so nothing downstream knows which source produced it. Rerun
build/emit_bundle.py afterwards.

Fallback if lines aren't posted yet: build/ingest_vegas_csv.py (hand-entered).
"""

import argparse
import json
import re
import time
from collections import defaultdict
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

SEASON = 2026
BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"

# ESPN abbreviation -> nflverse abbreviation (all others match)
ABBR_FIX = {"WSH": "WAS", "LAR": "LA"}


def nflverse_abbr(espn_abbr: str) -> str:
    return ABBR_FIX.get(espn_abbr, espn_abbr)


def parse_game(event: dict):
    """Return (home, away, total, home_spread) or None if no usable odds."""
    comp = (event.get("competitions") or [{}])[0]
    odds_list = comp.get("odds") or []
    if not odds_list:
        return None
    odds = odds_list[0]
    total = odds.get("overUnder")
    if total is None:
        return None

    home = away = None
    for c in comp.get("competitors", []):
        abbr = nflverse_abbr(c["team"]["abbreviation"])
        if c.get("homeAway") == "home":
            home = abbr
        else:
            away = abbr
    if not home or not away:
        return None

    # Preferred: parse "KC -3.5" style details (favorite abbr + line).
    home_spread = None
    details = odds.get("details") or ""
    m = re.match(r"^\s*([A-Z]{2,4})\s*([+-]?\d+(\.\d+)?)\s*$", details)
    if m:
        fav, line = nflverse_abbr(m.group(1)), float(m.group(2))
        if fav == home:
            home_spread = line
        elif fav == away:
            home_spread = -line
    if home_spread is None and details.strip().upper() in ("EVEN", "PK", "PICK"):
        home_spread = 0.0
    # Fallback: numeric spread field + favorite flag
    if home_spread is None and odds.get("spread") is not None:
        spread = float(odds["spread"])
        hto = odds.get("homeTeamOdds") or {}
        if hto.get("favorite") is True:
            home_spread = -abs(spread)
        elif hto.get("favorite") is False:
            home_spread = abs(spread)
        else:
            home_spread = spread  # ESPN's spread field is home-relative when unflagged
    if home_spread is None:
        return None
    return home, away, float(total), home_spread


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weeks", type=int, nargs="*", default=list(range(1, 19)))
    args = ap.parse_args()

    implied = defaultdict(list)
    game_rows = []
    for wk in args.weeks:
        r = requests.get(BASE, params={"seasontype": 2, "week": wk, "dates": SEASON},
                         timeout=30)
        r.raise_for_status()
        events = r.json().get("events", [])
        posted = 0
        for ev in events:
            parsed = parse_game(ev)
            if not parsed:
                continue
            home, away, total, home_spread = parsed
            # T = O/2 - L/2 ; home spread is negative when home is favored
            t_home = total / 2 - home_spread / 2
            t_away = total - t_home
            implied[home].append(t_home)
            implied[away].append(t_away)
            game_rows.append({"week": wk, "home": home, "away": away,
                              "total": total, "home_spread": home_spread,
                              "implied_home": round(t_home, 2),
                              "implied_away": round(t_away, 2)})
            posted += 1
        print(f"[espn-odds] week {wk}: {posted}/{len(events)} games with posted lines")
        time.sleep(0.3)

    if not game_rows:
        raise SystemExit("[espn-odds] no lines posted yet — use "
                         "build/ingest_vegas_csv.py to hand-enter from any free odds page")

    teams = {t: {"implied_total": round(sum(v) / len(v), 2), "games_posted": len(v)}
             for t, v in implied.items()}
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "vegas_totals.json").write_text(json.dumps(
        {"source": "espn_scoreboard", "season": SEASON,
         "teams": teams, "games": game_rows}))
    print(f"[espn-odds] wrote vegas_totals.json ({len(teams)} teams, "
          f"{len(game_rows)} games) — rerun build/emit_bundle.py")


if __name__ == "__main__":
    main()
