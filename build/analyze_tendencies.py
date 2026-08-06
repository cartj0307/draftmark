"""
Does manager draft history actually contain signal?

Before building a per-manager opponent model, measure whether one exists.
Roster rules force most of the positional distribution (everyone must end with
1QB/2RB/2WR/1TE/1K/1DST), so raw positional counts are nearly identical by
construction. The only place preference can show up is TIMING: how early each
manager reaches for a position relative to the league.

The test: for each manager, compute the average round of their first QB / TE /
K / DST and their RB-vs-WR share through round 6. Then compare the spread
BETWEEN managers to the spread WITHIN a manager across years. If a manager
differs from himself year to year as much as he differs from the field, the
"profile" is noise and modelling it would inject false confidence.
"""

import re
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "league" / "drafts_raw.txt"

# league renames / shorthand -> the canonical names in config/league.json
CANON = {
    "Rich's Rednecks": "Rich's Rednecks",
    "James' Dumpsterfire Igles": "Dumpsterfire Igles",
    "Kate's Show Us Your TDs": "Show Us Your TDs",
    "Margo's Black Magic Women": "Margo's Blackmagicwomen",
    "Jeff's Mojos": "Jeff's Mojos",
    "Nate's Jive Turkeys": "Nate's Jive Turkeys",
    "Jive Turkeys": "Nate's Jive Turkeys",
    "Kay's Cuties": "Kay's Cuties",
    "Nick III's Nighthawks": "Nick jr Nighthawks",
    "Ern Jr's Tightwads": "Ern's Tightwads",
    "Russman's Rappers": "Russmans' Rappers",
    "Nick's Bluemeanies": "Nick's Bluemeanies",
    "Bob's Steeltown Punishers": "steeltown punishers",
}
POS_MAP = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "PK": "K", "Def": "DST"}

LINE = re.compile(r"^(\d+)\.(\d+)\t(.+?)\t(.*?)\(([A-Z]{2,3}|FA) / (QB|RB|WR|TE|PK|Def)\)(Keeper)?\s*$")


def parse() -> pd.DataFrame:
    rows, year = [], None
    for raw in RAW.read_text().splitlines():
        if raw.startswith("#YEAR"):
            year = int(raw.split()[1])
            continue
        m = LINE.match(raw)
        if not m:
            continue
        rnd, pick, team, player, _tm, pos, keeper = m.groups()
        team = CANON.get(team.strip())
        if team is None:
            continue          # a manager no longer in the league
        rows.append({
            "year": year, "round": int(rnd), "pick": int(pick), "team": team,
            "player": player.strip(), "pos": POS_MAP[pos], "keeper": bool(keeper),
        })
    return pd.DataFrame(rows)


def profile(g: pd.DataFrame) -> dict:
    """Timing summary for one manager-year. Keepers excluded: not real picks."""
    live = g[~g["keeper"]]
    out = {}
    for pos in ("QB", "TE", "K", "DST"):
        hit = live[live["pos"] == pos]["round"]
        out[f"first_{pos}"] = float(hit.min()) if len(hit) else 17.0
    early = live[live["round"] <= 6]
    n_rb = int((early["pos"] == "RB").sum())
    n_wr = int((early["pos"] == "WR").sum())
    out["rb_share_r1_6"] = n_rb / max(n_rb + n_wr, 1)
    out["n_early_rbwr"] = n_rb + n_wr
    return out


def main():
    df = parse()
    years = sorted(df["year"].unique())
    print(f"parsed {len(df)} picks across {years}, {df['team'].nunique()} managers")
    print(f"keepers excluded from timing: {int(df['keeper'].sum())}\n")

    recs = []
    for (team, year), g in df.groupby(["team", "year"]):
        p = profile(g)
        p.update({"team": team, "year": year})
        recs.append(p)
    prof = pd.DataFrame(recs)

    metrics = ["first_QB", "first_TE", "first_K", "first_DST", "rb_share_r1_6"]

    print("=" * 74)
    print("PER-MANAGER AVERAGES (round of first pick at each position)")
    print("=" * 74)
    avg = prof.groupby("team")[metrics].mean().round(2)
    avg = avg.sort_values("first_QB")
    print(avg.to_string())
    print(f"\nLEAGUE MEAN: " + "  ".join(
        f"{m} {prof[m].mean():.2f}" for m in metrics))

    print("\n" + "=" * 74)
    print("IS IT SIGNAL OR NOISE?")
    print("=" * 74)
    print(f"{'metric':<16} {'between-mgr sd':>15} {'within-mgr sd':>15} {'ratio':>8}  verdict")
    for m in metrics:
        between = prof.groupby("team")[m].mean().std(ddof=1)
        # within: average |year-to-year deviation| from that manager's own mean
        within = prof.groupby("team")[m].std(ddof=1).mean()
        ratio = between / within if within and within > 0 else float("nan")
        verdict = ("SIGNAL" if ratio > 1.15 else
                   "weak" if ratio > 0.85 else "NOISE")
        print(f"{m:<16} {between:>15.2f} {within:>15.2f} {ratio:>8.2f}  {verdict}")

    print("\nA ratio above ~1 means managers differ from each other MORE than")
    print("they differ from themselves year to year — i.e. a real tendency.")

    print("\n" + "=" * 74)
    print("LEAGUE-WIDE POSITIONAL TIMING (all managers pooled)")
    print("=" * 74)
    live = df[~df["keeper"]]
    tab = (live.groupby(["round", "pos"]).size().unstack(fill_value=0)
           .reindex(columns=["QB", "RB", "WR", "TE", "K", "DST"], fill_value=0))
    print(tab.to_string())


if __name__ == "__main__":
    main()


def emit_profiles():
    """Write only the tendencies that MEASURED as signal.

    QB timing is a strong, consistent per-manager trait (between/within = 1.78).
    K and D/ST timing likewise, and league-wide nobody touches them before
    round 7. TE timing and RB/WR mix did NOT separate from noise, so they are
    deliberately NOT modelled — inventing a profile there would inject false
    confidence into the board.
    """
    import json
    df = parse()
    recs = []
    for (team, year), g in df.groupby(["team", "year"]):
        p = profile(g)
        p.update({"team": team, "year": year})
        recs.append(p)
    prof = pd.DataFrame(recs)

    out = {"_note": "QB/K/DST timing only — TE and RB-WR mix tested as noise",
           "_years": sorted(int(y) for y in df["year"].unique()),
           "managers": {}}
    K_SHRINK = 1.5
    for m in ("first_QB", "first_K", "first_DST"):
        league = float(prof[m].mean())
        out.setdefault("league_mean", {})[m] = round(league, 2)
        for team, g in prof.groupby("team"):
            n = len(g)
            obs = float(g[m].mean())
            shrunk = (n * obs + K_SHRINK * league) / (n + K_SHRINK)
            out["managers"].setdefault(team, {})[m] = round(shrunk, 2)

    live = df[~df["keeper"]]
    for pos, key in (("K", "earliest_K"), ("DST", "earliest_DST")):
        r = live[live["pos"] == pos]["round"]
        out[key] = int(r.min()) if len(r) else 7
    out["earliest_QB"] = int(live[live["pos"] == "QB"]["round"].min())

    dest = ROOT / "data" / "league" / "manager_profiles.json"
    dest.write_text(json.dumps(out, indent=1))
    print(f"\n[profiles] wrote {dest.name}: {len(out['managers'])} managers, "
          f"QB/K/DST timing only")
    print(f"[profiles] league never drafts K before round {out['earliest_K']}, "
          f"D/ST before round {out['earliest_DST']}, QB before round {out['earliest_QB']}")
