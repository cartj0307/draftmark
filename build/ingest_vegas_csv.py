import csv
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

VALID = {"ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN",
         "DET", "GB", "HOU", "IND", "JAX", "KC", "LV", "LAC", "LA", "MIA",
         "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SF", "SEA", "TB",
         "TEN", "WAS"}

TEMPLATE = "home,away,total,home_spread\n"


def main():
    path = RAW / "vegas_manual.csv"
    if not path.exists():
        RAW.mkdir(parents=True, exist_ok=True)
        path.write_text(TEMPLATE)
        raise SystemExit(f"[vegas-csv] created empty template at {path} — "
                         "fill it in and rerun (see this file's docstring)")

    implied = defaultdict(list)
    game_rows = []
    with path.open() as f:
        for i, row in enumerate(csv.DictReader(f), start=2):
            home, away = row["home"].strip().upper(), row["away"].strip().upper()
            for t in (home, away):
                if t not in VALID:
                    raise SystemExit(f"[vegas-csv] line {i}: unknown team '{t}' "
                                     f"(use nflverse abbreviations: WAS, LA, JAX...)")
            total = float(row["total"])
            home_spread = float(row["home_spread"])
            t_home = total / 2 - home_spread / 2
            t_away = total - t_home
            implied[home].append(t_home)
            implied[away].append(t_away)
            game_rows.append({"home": home, "away": away, "total": total,
                              "home_spread": home_spread,
                              "implied_home": round(t_home, 2),
                              "implied_away": round(t_away, 2)})

    if not game_rows:
        raise SystemExit("[vegas-csv] the CSV has no data rows yet")

    teams = {t: {"implied_total": round(sum(v) / len(v), 2), "games_posted": len(v)}
             for t, v in implied.items()}
    (RAW / "vegas_totals.json").write_text(json.dumps(
        {"source": "manual_csv", "teams": teams, "games": game_rows}))
    print(f"[vegas-csv] wrote vegas_totals.json ({len(teams)} teams, "
          f"{len(game_rows)} games) — rerun build/emit_bundle.py")


if __name__ == "__main__":
    main()
