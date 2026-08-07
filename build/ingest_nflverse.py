import argparse
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

FILES = {
    "pbp_2023.parquet": "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2023.parquet",
    "pbp_2024.parquet": "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2024.parquet",
    "pbp_2025.parquet": "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2025.parquet",
    "player_stats_2023.parquet": "https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_2023.parquet",
    "player_stats_2024.parquet": "https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_2024.parquet",
    "player_stats_2025.parquet": "https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_2025.parquet",
    "roster_2025.parquet": "https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_2025.parquet",
    "roster_2026.parquet": "https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_2026.parquet",
    "games.csv": "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv",
    "ff_playerids.csv": "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    RAW.mkdir(parents=True, exist_ok=True)
    for name, url in FILES.items():
        dest = RAW / name
        if dest.exists() and not args.force:
            print(f"[nflverse] {name} present, skipping")
            continue
        print(f"[nflverse] downloading {name}")
        r = requests.get(url, timeout=120)
        if r.status_code != 200:
            print(f"[nflverse]   WARNING {name}: HTTP {r.status_code} — skipped", file=sys.stderr)
            continue
        dest.write_bytes(r.content)
    print("[nflverse] done")


if __name__ == "__main__":
    main()
