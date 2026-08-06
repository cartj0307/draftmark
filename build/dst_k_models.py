"""
Draftmark Phase 4 prerequisite — real D/ST and kicker weekly distributions
from 2025 play-by-play and final scores. No Vegas required (Vegas remains a
forward-looking sharpener); no invented numbers.

Python only ASSEMBLES stat lines. Scoring happens exclusively through
src/scoring.js (scoreDST / scoreKicker) via build/score_dstk.js — the
one-implementation rule holds.

Outputs data/interim/dst_models.json and kicker_models.json:
    { key: { mean, sd, games } }   per team D/ST and per kicker gsis_id.
"""

import json
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
INTERIM = ROOT / "data" / "interim"

PBP_COLS = ["season_type", "week", "game_id", "play_type", "posteam", "defteam",
            "field_goal_result", "kick_distance", "extra_point_result",
            "kicker_player_id", "touchdown", "td_team", "interception",
            "fumble_lost", "safety", "yards_gained", "punt_blocked",
            "defensive_two_point_conv", "return_touchdown"]


def main():
    seasons = [s for s in (2023, 2024, 2025) if (RAW / f"pbp_{s}.parquet").exists()]
    all_scored = {}
    for season in seasons:
        all_scored[season] = _season_lines(season)
    scored = all_scored[max(seasons)]
    return _summarize_and_write(all_scored, seasons)


def _season_lines(season: int):
    pbp = pd.read_parquet(RAW / f"pbp_{season}.parquet", columns=PBP_COLS)
    pbp = pbp[pbp["season_type"] == "REG"]
    games = pd.read_csv(RAW / "games.csv")
    games = games[(games["season"] == season) & (games["game_type"] == "REG")]

    # ---------- D/ST weekly stat lines ----------
    lines = {}  # (team, week) -> dst stat line

    def L(team, week):
        return lines.setdefault((team, int(week)), {
            "kickoffReturnTD": 0, "puntReturnTD": 0, "interceptionReturnTD": 0,
            "fumbleReturnTD": 0, "blockedKickReturnTD": 0, "twoPointReturn": 0,
            "onePointSafety": 0, "blockedKick": 0, "interceptions": 0,
            "fumblesRecovered": 0, "safeties": 0, "pointsAllowed": 0, "yardsAllowed": 0,
        })

    # points allowed from final scores
    for _, g in games.iterrows():
        wk = int(g["week"])
        L(g["home_team"], wk)["pointsAllowed"] = int(g["away_score"])
        L(g["away_team"], wk)["pointsAllowed"] = int(g["home_score"])

    # yards allowed: net yards gained by the offense on run/pass plays
    off = pbp[pbp["play_type"].isin(["run", "pass"]) & pbp["defteam"].notna()]
    ya = off.groupby(["defteam", "week"])["yards_gained"].sum()
    for (team, wk), y in ya.items():
        L(team, wk)["yardsAllowed"] = int(y)

    # takeaways
    for (team, wk), n in pbp[pbp["interception"] == 1].groupby(["defteam", "week"]).size().items():
        L(team, wk)["interceptions"] = int(n)
    for (team, wk), n in pbp[pbp["fumble_lost"] == 1].groupby(["defteam", "week"]).size().items():
        L(team, wk)["fumblesRecovered"] = int(n)
    for (team, wk), n in pbp[pbp["safety"] == 1].groupby(["defteam", "week"]).size().items():
        L(team, wk)["safeties"] = int(n)
    for (team, wk), n in pbp[pbp["defensive_two_point_conv"] == 1].groupby(["defteam", "week"]).size().items():
        L(team, wk)["twoPointReturn"] = int(n)

    # blocked kicks (punt / FG / XP), credited to the defense
    blk = pbp[(pbp["punt_blocked"] == 1) | (pbp["field_goal_result"] == "blocked")
              | (pbp["extra_point_result"] == "blocked")]
    for (team, wk), n in blk.groupby(["defteam", "week"]).size().items():
        L(team, wk)["blockedKick"] = int(n)

    # return / defensive TDs, credited to the scoring team's D/ST
    tds = pbp[(pbp["touchdown"] == 1) & pbp["td_team"].notna()]
    for _, r in tds.iterrows():
        team, wk = r["td_team"], int(r["week"])
        if r["play_type"] == "kickoff":
            L(team, wk)["kickoffReturnTD"] += 1
        elif r["play_type"] == "punt":
            L(team, wk)["puntReturnTD"] += 1
        elif r["td_team"] == r["defteam"]:
            if r["interception"] == 1:
                L(team, wk)["interceptionReturnTD"] += 1
            elif r["field_goal_result"] == "blocked" or r["punt_blocked"] == 1:
                L(team, wk)["blockedKickReturnTD"] += 1
            else:
                L(team, wk)["fumbleReturnTD"] += 1

    dst_rows = [{"kind": "dst", "key": t, "week": w, "line": ln} for (t, w), ln in lines.items()]

    # ---------- kicker weekly stat lines ----------
    kl = {}  # (kicker, week) -> {patMade, fgMade:[]}
    fg = pbp[(pbp["field_goal_result"] == "made") & pbp["kicker_player_id"].notna()]
    for _, r in fg.iterrows():
        d = kl.setdefault((r["kicker_player_id"], int(r["week"])), {"patMade": 0, "fgMade": []})
        d["fgMade"].append(int(r["kick_distance"]))
    xp = pbp[(pbp["extra_point_result"] == "good") & pbp["kicker_player_id"].notna()]
    for (k, wk), n in xp.groupby(["kicker_player_id", "week"]).size().items():
        kl.setdefault((k, int(wk)), {"patMade": 0, "fgMade": []})["patMade"] = int(n)

    k_rows = [{"kind": "k", "key": k, "week": w, "line": ln} for (k, w), ln in kl.items()]

    # ---------- score everything through the engine ----------
    INTERIM.mkdir(parents=True, exist_ok=True)
    (INTERIM / "dstk_lines.json").write_text(json.dumps(dst_rows + k_rows))
    subprocess.run(["node", str(ROOT / "build" / "score_dstk.js")], check=True)
    return json.loads((INTERIM / "dstk_points.json").read_text())


def _summarize_and_write(all_scored, seasons):
    import numpy as np

    def summarize(scored, kind):
        by = {}
        for r in scored:
            if r["kind"] != kind:
                continue
            by.setdefault(r["key"], []).append(r["points"])
        out = {}
        for key, pts in by.items():
            a = np.array(pts, dtype=float)
            out[key] = {"mean": round(float(a.mean()), 2),
                        "sd": round(float(a.std(ddof=1)) if len(a) > 1 else 3.0, 2),
                        "games": len(a)}
        return out

    latest = max(seasons)
    per_season = {s: {k: summarize(all_scored[s], k) for k in ("dst", "k")} for s in seasons}

    # ---- how much of a unit's scoring rate actually carries year to year? ----
    # D/ST performance is famously unstable; projecting last season's rate
    # straight through is the same unshrunk-outlier error that produced a
    # 25-TD McCaffrey. Measure the carryover, then shrink by it.
    def carryover(kind):
        xs, ys = [], []
        for a, b in zip(seasons, seasons[1:]):
            pa, pb = per_season[a][kind], per_season[b][kind]
            for key in set(pa) & set(pb):
                if pa[key]["games"] >= 8 and pb[key]["games"] >= 8:
                    xs.append(pa[key]["mean"]); ys.append(pb[key]["mean"])
        if len(xs) < 12:
            return 0.35, len(xs)
        r = float(np.corrcoef(xs, ys)[0, 1])
        return max(0.0, min(r, 0.95)), len(xs)

    out = {}
    for kind, fname in (("dst", "dst_models.json"), ("k", "kicker_models.json")):
        r, n = carryover(kind)
        cur = per_season[latest][kind]
        league_mean = float(np.mean([v["mean"] for v in cur.values()])) if cur else 0.0
        shrunk = {}
        for key, m in cur.items():
            # regress toward the league mean by (1 - carryover)
            proj = r * m["mean"] + (1 - r) * league_mean
            shrunk[key] = {"mean": round(proj, 2), "sd": m["sd"],
                           "games": m["games"], "raw_mean": m["mean"]}
        (INTERIM / fname).write_text(json.dumps(shrunk))
        out[kind] = shrunk
        print(f"[dstk] {kind.upper()}: year-over-year carryover r={r:.2f} (n={n} pairs) "
              f"-> shrinking {1 - r:.0%} toward the league mean {league_mean:.2f}/g")

    top = sorted(out["dst"].items(), key=lambda x: -x[1]["mean"])[:3]
    print(f"[dstk] {len(out['dst'])} D/ST, {len(out['k'])} kickers, engine-scored over {seasons}")
    print("[dstk] top projected D/ST: " + ", ".join(
        f"{t} {m['mean']}/g (was {m['raw_mean']})" for t, m in top))


if __name__ == "__main__":
    main()
