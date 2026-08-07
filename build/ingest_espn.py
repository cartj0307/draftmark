import argparse
import json
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leaguedefaults/3"
PAGE = 400

# ESPN stat source ids: 1 = projection; statSplitTypeId 0 = full season
def fantasy_filter(offset: int, season: int) -> str:
    return json.dumps({
        "players": {
            "filterSlotIds": {"value": [0, 2, 4, 6, 17, 16]},  # QB RB WR TE K DST
            "limit": PAGE,
            "offset": offset,
            "sortDraftRanks": {"sortPriority": 100, "sortAsc": True, "value": "STANDARD"},
        }
    })


def fetch_players(season: int):
    players, offset = [], 0
    while True:
        r = requests.get(
            BASE.format(season=season),
            params={"view": "kona_player_info"},
            headers={"x-fantasy-filter": fantasy_filter(offset, season),
                     "accept": "application/json"},
            timeout=30,
        )
        r.raise_for_status()
        batch = r.json().get("players", [])
        if not batch:
            break
        players.extend(batch)
        print(f"[espn] fetched {len(players)} players...")
        if len(batch) < PAGE:
            break
        offset += PAGE
        time.sleep(0.5)
    return players


def extract(p: dict, season: int) -> dict:
    pl = p.get("player", {})
    ownership = pl.get("ownership") or {}
    proj = None
    for s in pl.get("stats", []):
        # statSourceId 1 = projected, statSplitTypeId 0 = season total
        if s.get("statSourceId") == 1 and s.get("statSplitTypeId") == 0 \
                and s.get("seasonId") == season:
            proj = s.get("appliedTotal")
    return {
        "espn_id": pl.get("id"),
        "name": pl.get("fullName"),
        "position_id": pl.get("defaultPositionId"),
        "team_id": pl.get("proTeamId"),
        "projection": proj,          # ESPN default-scoring season projection (a PRIOR only)
        "adp": ownership.get("averageDraftPosition"),
        "adp_sd": ownership.get("auctionValueAverage") and None,  # sd not exposed; estimated downstream
        "percent_drafted": ownership.get("percentOwned"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backtest", action="store_true",
                    help="pull 2025 preseason projections for build/backtest.py")
    args = ap.parse_args()
    season = 2025 if args.backtest else 2026

    raw = fetch_players(season)
    out = [extract(p, season) for p in raw]
    out = [p for p in out if p["espn_id"]]

    RAW.mkdir(parents=True, exist_ok=True)
    if args.backtest:
        # map to gsis via the xref before the backtest consumes it
        import pandas as pd
        xref = pd.read_parquet(ROOT / "data" / "interim" / "player_xref.parquet")
        m = {str(r.espn_id): r.gsis_id for r in xref.itertuples() if r.espn_id}
        players = [{"gsis_id": m.get(str(p["espn_id"])),
                    "espn_proj_ppg": (p["projection"] or 0) / 17}
                   for p in out if m.get(str(p["espn_id"]))]
        (RAW / "espn_projections_2025.json").write_text(json.dumps({"players": players}))
        print(f"[espn] wrote espn_projections_2025.json ({len(players)} matched) — rerun build/backtest.py")
    else:
        (RAW / "espn_players.json").write_text(json.dumps({"season": season, "players": out}))
        print(f"[espn] wrote espn_players.json ({len(out)} players) — rerun build/emit_bundle.py")


if __name__ == "__main__":
    main()
