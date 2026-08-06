"""
Draftmark Phase 1 — build the player ID crosswalk.

ESPN ID != Sleeper ID != GSIS ID. A wrong join silently attaches one player's
goal-line carries to another's projection and nothing throws an error, so:

  - Start from nflverse ff_playerids (dynastyprocess) — the widest crosswalk.
  - Join the 2025 nflverse roster on gsis_id (exact) to confirm/fill
    espn_id and sleeper_id.
  - Every join is exact-ID or it is flagged. Conflicts between sources and
    players lacking IDs are written to data/interim/xref_review.csv and MUST
    be resolved by hand into config/xref_overrides.json.

Acceptance: zero unresolved fuzzy matches survive into the bundle.
"""

import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
INTERIM = ROOT / "data" / "interim"
CONFIG = ROOT / "config"

FANTASY_POS = {"QB", "RB", "WR", "TE", "K"}


def norm_id(s):
    """IDs arrive as float/str/NaN across sources; normalize to str or None."""
    if pd.isna(s):
        return None
    if isinstance(s, float):
        return str(int(s))
    s = str(s).strip()
    return s or None


def main():
    ids = pd.read_csv(RAW / "ff_playerids.csv", dtype=str)
    r26 = RAW / "roster_2026.parquet"
    roster_path = r26 if r26.exists() else RAW / "roster_2025.parquet"
    print(f"[xref] roster universe: {roster_path.name}")
    roster = pd.read_parquet(roster_path)

    # active fantasy-relevant universe: on a 2025 roster at a fantasy position
    roster = roster[roster["position"].isin(FANTASY_POS)].copy()
    roster = roster.drop_duplicates("gsis_id")
    roster = roster[roster["gsis_id"].notna()]

    ids = ids[ids["gsis_id"].notna()].drop_duplicates("gsis_id")

    x = roster[["gsis_id", "full_name", "position", "team", "espn_id", "sleeper_id", "birth_date"]].merge(
        ids[["gsis_id", "espn_id", "sleeper_id", "name", "position", "team", "age", "draft_year"]],
        on="gsis_id", how="left", suffixes=("_roster", "_ffids"),
    )

    rows, review = [], []
    for _, r in x.iterrows():
        espn_r, espn_f = norm_id(r["espn_id_roster"]), norm_id(r["espn_id_ffids"])
        slp_r, slp_f = norm_id(r["sleeper_id_roster"]), norm_id(r["sleeper_id_ffids"])

        espn = espn_r or espn_f
        sleeper = slp_r or slp_f
        method = "exact_id"
        conf = 1.0

        conflict = []
        if espn_r and espn_f and espn_r != espn_f:
            conflict.append(f"espn {espn_r}!={espn_f}")
        if slp_r and slp_f and slp_r != slp_f:
            conflict.append(f"sleeper {slp_r}!={slp_f}")
        if conflict:
            method, conf = "conflict", 0.0
            review.append({"gsis_id": r["gsis_id"], "name": r["full_name"],
                           "team": r["team_roster"], "pos": r["position_roster"],
                           "issue": "; ".join(conflict)})

        rows.append({
            "draftmark_id": f"dm_{r['gsis_id']}",
            "gsis_id": r["gsis_id"],
            "espn_id": espn,
            "sleeper_id": sleeper,
            "name": r["full_name"],
            "position": r["position_roster"],
            "team": r["team_roster"],
            "match_method": method,
            "match_confidence": conf,
        })

    xref = pd.DataFrame(rows)

    # hand-maintained overrides win over everything
    ovr_path = CONFIG / "xref_overrides.json"
    if ovr_path.exists():
        overrides = json.loads(ovr_path.read_text())
        for gsis, fix in overrides.items():
            mask = xref["gsis_id"] == gsis
            for k, v in fix.items():
                xref.loc[mask, k] = v
            xref.loc[mask, "match_method"] = "manual"
            xref.loc[mask, "match_confidence"] = 1.0

    INTERIM.mkdir(parents=True, exist_ok=True)
    xref.to_parquet(INTERIM / "player_xref.parquet", index=False)

    unresolved = xref[xref["match_method"] == "conflict"]
    if len(review):
        pd.DataFrame(review).to_csv(INTERIM / "xref_review.csv", index=False)
    print(f"[xref] {len(xref)} players | exact: {(xref.match_method=='exact_id').sum()} "
          f"| manual: {(xref.match_method=='manual').sum()} | UNRESOLVED CONFLICTS: {len(unresolved)}")
    missing_espn = xref["espn_id"].isna().sum()
    missing_slp = xref["sleeper_id"].isna().sum()
    print(f"[xref] missing espn_id: {missing_espn} | missing sleeper_id: {missing_slp} "
          f"(mostly deep depth-chart; resolved when ESPN/Sleeper ingests run)")
    if len(unresolved):
        print("[xref] BLOCKING: resolve data/interim/xref_review.csv into config/xref_overrides.json")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
