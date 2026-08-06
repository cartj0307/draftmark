"""
Draftmark — Vegas ingest, OPTIONAL THIRD PATH (The Odds API — requires an
account/key; NOT the default). Use build/ingest_odds_espn.py (free, keyless)
or build/ingest_vegas_csv.py (hand-entered) instead. Kept only as a spare.

    ODDS_API_KEY=yourkey python3 build/ingest_vegas.py

Pulls NFL game totals and spreads, computes each team's implied total per the
doc's formula (implied total T equals the game total over two, minus the
team's spread over two), and averages across all posted 2026 games:

    T = O/2 - L/2      where O = game total, L = team's spread (negative if favored)

Preseason this covers whichever weeks books have posted; in-season rerun
weekly. Writes data/raw/vegas_totals.json; rerun build/emit_bundle.py after.
"""

import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

BASE = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds"

# The Odds API uses full team names; map to nflverse abbreviations
TEAM_ABBR = {
    "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL",
    "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
    "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL",
    "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
    "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
    "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC",
    "Los Angeles Rams": "LA", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN",
    "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
    "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT",
    "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB",
    "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
}


def consensus_price(bookmakers, market_key, selector):
    """Median across books of the value picked out by selector(outcome)."""
    vals = []
    for bk in bookmakers:
        for m in bk.get("markets", []):
            if m["key"] != market_key:
                continue
            for o in m.get("outcomes", []):
                v = selector(o)
                if v is not None:
                    vals.append(v)
    if not vals:
        return None
    vals.sort()
    return vals[len(vals) // 2]


def main():
    key = os.environ.get("ODDS_API_KEY")
    if not key:
        sys.exit("Set ODDS_API_KEY (free key at https://the-odds-api.com)")

    r = requests.get(BASE, params={
        "apiKey": key, "regions": "us",
        "markets": "spreads,totals", "oddsFormat": "american",
    }, timeout=30)
    r.raise_for_status()
    games = r.json()
    print(f"[vegas] {len(games)} games with posted lines "
          f"(requests remaining: {r.headers.get('x-requests-remaining')})")

    implied = defaultdict(list)
    game_rows = []
    for gm in games:
        home, away = gm["home_team"], gm["away_team"]
        total = consensus_price(gm["bookmakers"], "totals",
                                lambda o: o.get("point") if o["name"] == "Over" else None)
        spread_home = consensus_price(gm["bookmakers"], "spreads",
                                      lambda o: o.get("point") if o["name"] == home else None)
        if total is None or spread_home is None:
            continue
        # T = O/2 - L/2 ; home spread L is negative when home is favored
        t_home = total / 2 - spread_home / 2
        t_away = total - t_home
        h, a = TEAM_ABBR.get(home), TEAM_ABBR.get(away)
        if not h or not a:
            continue
        implied[h].append(t_home)
        implied[a].append(t_away)
        game_rows.append({"home": h, "away": a, "total": total,
                          "home_spread": spread_home,
                          "implied_home": round(t_home, 2),
                          "implied_away": round(t_away, 2),
                          "commence": gm.get("commence_time")})

    teams = {t: {"implied_total": round(sum(v) / len(v), 2), "games_posted": len(v)}
             for t, v in implied.items()}

    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "vegas_totals.json").write_text(json.dumps({"teams": teams, "games": game_rows}))
    print(f"[vegas] wrote vegas_totals.json ({len(teams)} teams) — rerun build/emit_bundle.py")


if __name__ == "__main__":
    main()
