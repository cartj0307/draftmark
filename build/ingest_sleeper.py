import json
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

URL = "https://api.sleeper.app/v1/players/nfl"
FANTASY_POS = {"QB", "RB", "WR", "TE", "K", "DEF"}


def main():
    print("[sleeper] fetching master player list (once per day max)...")
    r = requests.get(URL, timeout=60)
    r.raise_for_status()
    data = r.json()

    players = []
    by_team_rb = {}
    for sid, p in data.items():
        if p.get("position") not in FANTASY_POS:
            continue
        row = {
            "sleeper_id": sid,
            "name": p.get("full_name") or f"{p.get('first_name','')} {p.get('last_name','')}".strip(),
            "position": p.get("position"),
            "team": p.get("team"),
            "gsis_id": p.get("gsis_id"),
            "espn_id": p.get("espn_id"),
            "injury_status": p.get("injury_status"),
            "status": p.get("status"),
            "depth_chart_order": p.get("depth_chart_order"),
            "years_exp": p.get("years_exp"),
        }
        players.append(row)
        if row["position"] == "RB" and row["team"] and row["depth_chart_order"]:
            by_team_rb.setdefault(row["team"], []).append(row)

    # handcuff derivation: RB2 on a depth chart is the handcuff of RB1
    handcuffs = {}
    for team, rbs in by_team_rb.items():
        rbs.sort(key=lambda x: x["depth_chart_order"])
        if len(rbs) >= 2 and rbs[0]["depth_chart_order"] == 1:
            handcuffs[rbs[1]["sleeper_id"]] = rbs[0]["sleeper_id"]

    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "sleeper_players.json").write_text(json.dumps({
        "players": players,
        "handcuffs": handcuffs,
    }))
    print(f"[sleeper] wrote sleeper_players.json ({len(players)} players, "
          f"{len(handcuffs)} handcuff links) — rerun build/emit_bundle.py")


if __name__ == "__main__":
    main()
