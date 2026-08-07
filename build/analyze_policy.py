import re
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "league" / "drafts_raw.txt"

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
STARTERS = {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "DST": 1, "K": 1}
SKILL = ("QB", "RB", "WR", "TE")

LINE = re.compile(
    r"^(\d+)\.(\d+)\t(.+?)\t(.*?)\(([A-Z]{2,3}|FA) / (QB|RB|WR|TE|PK|Def)\)(Keeper)?\s*$")


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
            continue
        rows.append({"year": year, "round": int(rnd), "pick": int(pick), "team": team,
                     "player": player.strip(), "pos": POS_MAP[pos], "keeper": bool(keeper)})
    df = pd.DataFrame(rows)
    # order of play within a year: round, then pick number
    return df.sort_values(["year", "round", "pick"]).reset_index(drop=True)


def policy(g: pd.DataFrame) -> dict:
    """Replay one manager-year pick by pick, tracking roster state."""
    have = {p: 0 for p in STARTERS}
    # keepers occupy a seat before live picking starts
    for _, r in g[g["keeper"]].iterrows():
        have[r["pos"]] = have.get(r["pos"], 0) + 1

    need_opportunities = need_filled = 0
    depth_picks = early_picks = 0
    first_six = []

    for _, r in g[~g["keeper"]].sort_values(["round", "pick"]).iterrows():
        pos, rnd = r["pos"], r["round"]
        empty = {p for p, n in STARTERS.items() if have.get(p, 0) < n}
        # only count the decision when a starter seat was actually open
        if empty:
            need_opportunities += 1
            if pos in empty:
                need_filled += 1
        if rnd <= 8:
            early_picks += 1
            if have.get(pos, 0) >= STARTERS.get(pos, 99):
                depth_picks += 1
        if len(first_six) < 6 and pos in SKILL:
            first_six.append(pos)
        have[pos] = have.get(pos, 0) + 1

    conc = 0.0
    if first_six:
        counts = pd.Series(first_six).value_counts()
        conc = float(counts.iloc[0] / len(first_six))

    return {
        "need_rate": need_filled / need_opportunities if need_opportunities else np.nan,
        "depth_rate": depth_picks / early_picks if early_picks else np.nan,
        "concentration": conc,
        "n_picks": int((~g["keeper"]).sum()),
    }


def main():
    df = parse()
    years = sorted(df["year"].unique())
    print(f"parsed {len(df)} picks over {years}; "
          f"{df['team'].nunique()} managers, {int(df['keeper'].sum())} keepers excluded\n")

    recs = []
    for (team, year), g in df.groupby(["team", "year"]):
        p = policy(g)
        p.update({"team": team, "year": year})
        recs.append(p)
    prof = pd.DataFrame(recs)
    # a manager needs >=2 seasons to have a within-manager variance at all
    counts = prof.groupby("team")["year"].count()
    usable = counts[counts >= 2].index
    prof = prof[prof["team"].isin(usable)]

    metrics = ["need_rate", "depth_rate", "concentration"]

    print("=" * 78)
    print("PER-MANAGER POLICY (averaged over their seasons)")
    print("=" * 78)
    avg = prof.groupby("team")[metrics].mean().round(3)
    avg["seasons"] = prof.groupby("team")["year"].count()
    print(avg.sort_values("need_rate", ascending=False).to_string())
    print("\nleague mean: " + "  ".join(f"{m} {prof[m].mean():.3f}" for m in metrics))

    print("\n" + "=" * 78)
    print("SIGNAL OR NOISE?  (between-manager sd vs within-manager sd)")
    print("=" * 78)
    print(f"{'metric':<16}{'between':>10}{'within':>10}{'ratio':>9}   verdict")
    results = {}
    for m in metrics:
        between = prof.groupby("team")[m].mean().std(ddof=1)
        within = prof.groupby("team")[m].std(ddof=1).mean()
        ratio = between / within if within and within > 0 else np.nan
        verdict = ("SIGNAL" if ratio > 1.15 else "weak" if ratio > 0.85 else "NOISE")
        results[m] = ratio
        print(f"{m:<16}{between:>10.3f}{within:>10.3f}{ratio:>9.2f}   {verdict}")

    print("\nRatio > 1 means managers differ from each other more than they differ")
    print("from themselves year to year — i.e. a real, projectable trait.")

    # the league-wide need curve is useful regardless of per-manager stability
    print("\n" + "=" * 78)
    print("LEAGUE-WIDE: how often a pick fills an empty starter seat, by round")
    print("=" * 78)
    live = df[~df["keeper"]]
    rows = []
    for year in years:
        for team, g in df[df["year"] == year].groupby("team"):
            have = {p: 0 for p in STARTERS}
            for _, r in g[g["keeper"]].iterrows():
                have[r["pos"]] += 1
            for _, r in g[~g["keeper"]].sort_values(["round", "pick"]).iterrows():
                empty = {p for p, n in STARTERS.items() if have.get(p, 0) < n}
                rows.append({"round": r["round"],
                             "filled_need": 1 if (empty and r["pos"] in empty) else 0,
                             "had_need": 1 if empty else 0})
                have[r["pos"]] = have.get(r["pos"], 0) + 1
    curve = pd.DataFrame(rows)
    c = curve[curve.had_need == 1].groupby("round")["filled_need"].agg(["mean", "size"])
    c.columns = ["fills_need", "n"]
    print(c.round(3).to_string())


if __name__ == "__main__":
    main()
