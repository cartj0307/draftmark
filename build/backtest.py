"""
Rebuild as of the START of 2025: fit the opportunity->lambda model on
2023-2024 only, parameterize every player from 2024 usage, project expected
points per game for 2025 through the survival-sum identity (build/project.js,
constants from config), and compare Spearman rank correlation against
realized 2025 points per game (engine-scored) with a minimum of 6 games.
"""

import json
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from fit_distributions import fit_lambda_model, gamma_moments, SKILL_POS

ROOT = Path(__file__).resolve().parents[1]
INTERIM = ROOT / "data" / "interim"
RAW = ROOT / "data" / "raw"

PRIOR_GAMES = 8
MIN_GAMES_EVAL = 6


def main():
    usage = pd.read_parquet(INTERIM / "player_usage.parquet")
    env = pd.read_parquet(INTERIM / "team_env.parquet")
    weeks = pd.read_parquet(INTERIM / "player_weeks.parquet")
    points = pd.read_parquet(INTERIM / "player_week_points.parquet")

    # ---- fit on 2023-2024 only (no knowledge of 2025) ----
    train_weeks = weeks[weeks.season <= 2024]
    train_usage = usage[usage.season <= 2024]
    train_env = env[env.season <= 2024]
    model, df, feats, clips = fit_lambda_model(train_usage, train_weeks, train_env)

    # positional priors from the training fit (whole position, as production)
    priors = {}
    for pos, grp in df[df.season == 2024].groupby("position"):
        priors[pos] = float(np.average(grp["lambda_fit"], weights=grp["games"]))

    # ---- parameterize each player from 2024, production pipeline exactly:
    # ceiling cap (training-observed) + observed-rate anchor + prior shrink ----
    SEASON_W = {2024: 1.0, 2023: 0.62}
    df["sw"] = df["season"].map(SEASON_W).fillna(0) * df["games"]
    ev = df.groupby("gsis_id").apply(
        lambda g: pd.Series({
            "eff_games": float(g["sw"].sum()),
            "rate_obs": float((g["season"].map(SEASON_W).fillna(0) * g["tds"]).sum()
                              / max(g["sw"].sum(), 1e-9)),
        }), include_groups=False).reset_index()
    obs = df[df.games >= 10].copy()
    CEIL = float((obs["tds"] / obs["games"]).max())
    p24 = df[df.season == 2024].copy().merge(ev, on="gsis_id", how="left")
    p24["eff_games"] = p24["eff_games"].fillna(p24["games"])
    p24["rate_obs"] = p24["rate_obs"].fillna(0.0)
    lam_cap = CEIL * (1 - np.exp(-p24["lambda_fit"] / CEIL))
    ANCHOR_K = 12.0
    w_obs = p24["eff_games"] / (p24["eff_games"] + ANCHOR_K)
    p24["lambda_pred"] = (1 - w_obs) * lam_cap + w_obs * p24["rate_obs"]
    w = p24["eff_games"] / (p24["eff_games"] + PRIOR_GAMES)
    p24["lambda_base"] = w * p24["lambda_pred"] + (1 - w) * p24["position"].map(priors)

    w24 = train_weeks[train_weeks.season == 2024]
    qb_pass_prior = w24[w24.position == "QB"]["passing_tds"].fillna(0).mean()
    qb_int_prior = w24[w24.position == "QB"]["passing_interceptions"].fillna(0).mean()

    rows = []
    for _, r in p24.iterrows():
        g = w24[w24.gsis_id == r.gsis_id]
        n = len(g)
        if n == 0:
            continue
        shrink = n / (n + PRIOR_GAMES)
        if r.position == "QB":
            ptd = shrink * g["passing_tds"].fillna(0).mean() + (1 - shrink) * qb_pass_prior
            pint = shrink * g["passing_interceptions"].fillna(0).mean() + (1 - shrink) * qb_int_prior
        else:
            ptd = g["passing_tds"].fillna(0).mean() * shrink
            pint = g["passing_interceptions"].fillna(0).mean() * shrink
        gam = {}
        for cat, col in (("rush", "rushing_yards"), ("rec", "receiving_yards"), ("pass", "passing_yards")):
            vals = g[col].fillna(0).to_numpy()
            fit = gamma_moments(vals) if n >= 6 else None
            if fit:
                gam[cat] = {"shape": fit[0], "scale": fit[1]}
        rows.append({"id": r.gsis_id, "pos": r.position, "lambda": float(r.lambda_base),
                     "pass_td_pg": float(ptd), "int_pg": float(pint), "gammas": gam})

    inp, outp = INTERIM / "backtest_in.json", INTERIM / "backtest_out.json"
    inp.write_text(json.dumps(rows))
    subprocess.run(["node", str(ROOT / "build" / "project.js"), str(inp), str(outp)], check=True)
    proj = pd.DataFrame(json.loads(outp.read_text())).rename(columns={"id": "gsis_id"})

    # ---- realized 2025, engine-scored ----
    real25 = points[points.season == 2025].groupby("gsis_id").agg(
        ppg=("points", "mean"), games=("week", "nunique"), position=("position", "first")
    ).reset_index()
    real25 = real25[real25.games >= MIN_GAMES_EVAL]

    # naive baseline: 2024 realized ppg (league scoring)
    real24 = points[points.season == 2024].groupby("gsis_id").agg(
        ppg24=("points", "mean"), g24=("week", "nunique")).reset_index()
    real24 = real24[real24.g24 >= MIN_GAMES_EVAL]

    ev = real25.merge(proj, on="gsis_id", how="inner").merge(real24, on="gsis_id", how="inner")

    espn_path = RAW / "espn_projections_2025.json"
    espn = None
    if espn_path.exists():
        e = pd.DataFrame(json.loads(espn_path.read_text())["players"])
        ev = ev.merge(e[["gsis_id", "espn_proj_ppg"]], on="gsis_id", how="left")
        espn = ev["espn_proj_ppg"].notna().sum() > 50

    print(f"\n[backtest] eval universe: {len(ev)} players with >= {MIN_GAMES_EVAL} games in both seasons\n")
    print(f"{'pos':>5} {'n':>4} {'model':>8} {'last-yr':>8}" + ("   espn" if espn else ""))
    for pos in ["RB", "WR", "TE", "QB"]:
        sub = ev[ev.position == pos]
        if len(sub) < 8:
            continue
        rm = spearmanr(sub.ef_pg, sub.ppg).statistic
        rb = spearmanr(sub.ppg24, sub.ppg).statistic
        line = f"{pos:>5} {len(sub):>4} {rm:>8.3f} {rb:>8.3f}"
        if espn:
            se = sub.dropna(subset=["espn_proj_ppg"])
            line += f" {spearmanr(se.espn_proj_ppg, se.ppg).statistic:>6.3f}"
        print(line)
    allm = spearmanr(ev.ef_pg, ev.ppg).statistic
    allb = spearmanr(ev.ppg24, ev.ppg).statistic
    print(f"{'ALL':>5} {len(ev):>4} {allm:>8.3f} {allb:>8.3f}")
    if not espn:
        print("\n[backtest] ESPN 2025 preseason projections not present "
              "(data/raw/espn_projections_2025.json) — the consensus half of the "
              "gate runs when the ESPN ingest is executed on your machine.")
    verdict = "PASSES vs naive baseline" if allm > allb else "FAILS vs naive baseline — STOP AND INVESTIGATE"
    print(f"\n[backtest] {verdict} (model {allm:.3f} vs last-year {allb:.3f})")


if __name__ == "__main__":
    main()
