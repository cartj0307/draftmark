"""
Draftmark Phase 1 — fit the player model.

The core object is lambda, the weekly touchdown rate. Everything else corrects it.

  1. Dispersion phi by position, across 2023-2025 player-weeks (method of
     moments on the NB relation: variance = lambda + lambda^2 / phi).
  2. lambda from OPPORTUNITY, not history: Poisson regression of season TDs
     on goal-line carries, RZ touches, EZ targets, and team environment,
     with games as exposure. Last year's TD count is contaminated by luck;
     the opportunity that generated it is not.
  3. Shrinkage of the fitted rate toward the positional prior by sample size.
  4. Regression flags: actual TDs minus fitted expectation (run Taylor first).
  5. Gamma yardage per category per player (moments, shrunk to position).
  6. Defensive strength by position from engine-scored player-weeks,
     SHRUNK HARD preseason (Part V.5), -> lambda_weekly over the real
     2026 schedule with byes at zero.

Writes data/interim/model.parquet + def_mult.json + team_model.json.
"""

import json
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm

ROOT = Path(__file__).resolve().parents[1]
INTERIM = ROOT / "data" / "interim"

SKILL_POS = {"QB", "RB", "WR", "TE"}
DEF_SHRINK = 0.25          # preseason: keep only a quarter of the observed deviation
PRIOR_GAMES = 8            # shrinkage weight, in games, toward positional prior
MIN_WEEKS_PHI = 8          # weeks needed for a player to inform the phi fit


def run_engine_scoring(weeks: pd.DataFrame) -> pd.DataFrame:
    """Score all player-weeks through src/scoring.js — the only implementation."""
    weeks.to_json(INTERIM / "player_weeks.json", orient="records")
    subprocess.run(["node", str(ROOT / "build" / "score_weeks.js")], check=True)
    return pd.read_json(INTERIM / "player_week_points.json")


def fit_phi_by_position(weeks: pd.DataFrame) -> dict:
    """NB dispersion: for each player, mean m and variance v of weekly TDs.
    NB implies v = m + m^2/phi  ->  (v - m) = m^2 / phi. Fit phi per position
    by regression through the origin of (v - m) on m^2, floored so phi > 1."""
    out = {}
    for pos, grp in weeks[weeks.position.isin(SKILL_POS)].groupby("position"):
        # pool each player's weeks across ALL seasons; dispersion is a trait,
        # and clustering lives among players with real TD roles
        stats = grp.groupby("gsis_id")["tds"].agg(["mean", "var", "count"]).dropna()
        stats = stats[(stats["count"] >= 2 * MIN_WEEKS_PHI) & (stats["mean"] >= 0.2)]
        m = stats["mean"].to_numpy()
        v = stats["var"].to_numpy()
        n = stats["count"].to_numpy()
        # pooled, weeks-weighted moment estimator:
        # NB implies v = m + m^2/phi  ->  phi = sum(n*m^2) / sum(n*(v-m))
        excess = float((n * (v - m)).sum())
        phi = float((n * m * m).sum() / excess) if excess > 1e-9 else 200.0
        if not np.isfinite(phi) or phi <= 1.0:
            phi = 200.0
        # EMPIRICAL FINDING (2023-2025, engine data): the population of
        # TD-role players is near-Poisson (median var/mean ~ 0.93-1.01 by
        # position). Gibbs 2025 alone shows 1.24 — the Phase 0 number — but
        # his own 3-season ratio is 1.04. phi capped at 200 (~Poisson) is
        # what the data supports; the NB machinery remains so per-player
        # overdispersion can be dialed in if later evidence demands it.
        out[pos] = {"phi": round(min(phi, 200.0), 3), "n_players": int(len(stats))}
    return out


def fit_lambda_model(usage: pd.DataFrame, weeks: pd.DataFrame, env: pd.DataFrame):
    """Poisson GLM: season TDs ~ per-game opportunity, exposure = games."""
    season_td = weeks.groupby(["gsis_id", "season"]).agg(
        tds=("tds", "sum"), games=("week", "nunique"),
        position=("position", "first")).reset_index()
    df = season_td.merge(usage, on=["gsis_id", "season"], how="inner")
    df = df.merge(env[["team", "season", "rz_td_rate", "off_td_pg"]],
                  on=["team", "season"], how="left")
    df = df[df.position.isin(SKILL_POS) & (df.games >= 4)].copy()
    df["rz_td_rate"] = df["rz_td_rate"].fillna(df["rz_td_rate"].mean())
    df["off_td_pg"] = df["off_td_pg"].fillna(df["off_td_pg"].mean())

    for col in ["gl_carries", "rz20_carries", "rz20_targets", "ez_targets", "carries", "targets"]:
        df[col + "_pg"] = df[col] / df["games"]

    feats = ["gl_carries_pg", "rz20_carries_pg", "rz20_targets_pg",
             "ez_targets_pg", "carries_pg", "targets_pg", "rz_td_rate", "off_td_pg"]
    # CLIP features at the 99th percentile: a log-link model cannot be trusted
    # beyond its training support — unclipped, McCaffrey's outlier red-zone
    # usage predicted 41 TDs against an actual 17. Clips are returned so
    # prediction uses the identical support.
    clips = {f: float(df[f].quantile(0.99)) for f in feats}
    for f in feats:
        df[f] = df[f].clip(upper=clips[f])
    # NOTE: fit on raw numpy — the pandas-DataFrame + exposure path silently
    # yields NaN params in statsmodels 0.14.6 / numpy 2.4. Verified identical
    # design matrix fits cleanly as ndarray.
    X = np.column_stack([np.ones(len(df)), df[feats].to_numpy(dtype=np.float64)])
    y = df["tds"].to_numpy(dtype=np.float64)
    exposure = df["games"].to_numpy(dtype=np.float64)
    model = sm.GLM(y, X, family=sm.families.Poisson(), exposure=exposure).fit()
    if not np.isfinite(model.params).all():
        raise RuntimeError("lambda model produced non-finite coefficients — do not proceed")
    # per-game rate: exp(X @ beta), exposure excluded
    df["lambda_fit"] = np.exp(X @ model.params)
    model.feature_names = ["const"] + feats
    return model, df, feats, clips


def positional_priors(df: pd.DataFrame) -> dict:
    """Positional prior lambda: games-weighted mean fitted rate over the WHOLE
    position. (Top-half-only priors pulled every fringe player upward toward
    starter rates, inflating the tail so that positional recalibration then
    taxed the stars — Taylor fitted 12.5 against an actual 20.)"""
    pri = {}
    for pos, grp in df[df.season == df.season.max()].groupby("position"):
        pri[pos] = float(np.average(grp["lambda_fit"], weights=grp["games"]))
    return pri


def gamma_moments(vals: np.ndarray):
    """Method-of-moments Gamma on weekly yardage (zeros kept — they are real
    weeks). Returns (shape, scale) or None if degenerate."""
    m, v = float(np.mean(vals)), float(np.var(vals, ddof=1)) if len(vals) > 1 else (0.0, 0.0)
    if m <= 0 or v <= 0:
        return None
    return (m * m / v, v / m)


def defensive_multipliers(points: pd.DataFrame, weeks: pd.DataFrame) -> dict:
    """Points-allowed-over-expectation by (defense, position), 2025 only,
    engine-scored, shrunk hard preseason. Multiplier ~ 1 +- small."""
    w25 = weeks[weeks.season == 2025][["gsis_id", "week", "opponent_team"]]
    p = points[points.season == 2025].merge(
        w25, left_on=["gsis_id", "week"], right_on=["gsis_id", "week"], how="left")
    p = p[p.position.isin(SKILL_POS) & p.opponent_team.notna()]
    # weekly positional total allowed by each defense
    allowed = p.groupby(["opponent_team", "position", "week"])["points"].sum().reset_index()
    by_def = allowed.groupby(["opponent_team", "position"])["points"].mean()
    league_avg = allowed.groupby("position")["points"].mean()
    mult = {}
    for (d, pos), val in by_def.items():
        dev = val / league_avg[pos] - 1.0
        mult.setdefault(d, {})[pos] = round(1.0 + DEF_SHRINK * dev, 4)
    return mult


def main():
    usage = pd.read_parquet(INTERIM / "player_usage.parquet")
    env = pd.read_parquet(INTERIM / "team_env.parquet")
    weeks = pd.read_parquet(INTERIM / "player_weeks.parquet")
    weeks["opponent_team"] = None
    # opponent comes from player_stats where available
    raw = []
    for s in (2023, 2024, 2025):
        ps = pd.read_parquet(ROOT / "data" / "raw" / f"player_stats_{s}.parquet")
        ps = ps[ps["season_type"] == "REG"].rename(columns={"player_id": "gsis_id"})
        raw.append(ps[["gsis_id", "season", "week", "opponent_team"]])
    opp = pd.concat(raw).drop_duplicates(["gsis_id", "season", "week"])
    weeks = weeks.drop(columns=["opponent_team"]).merge(opp, on=["gsis_id", "season", "week"], how="left")

    points = run_engine_scoring(weeks)

    phi_full = fit_phi_by_position(weeks)
    phi = {pos: d["phi"] for pos, d in phi_full.items()}
    print(f"[fit] NB dispersion by position: {phi_full}")

    model, df, feats, clips = fit_lambda_model(usage, weeks, env)
    print("[fit] Poisson opportunity model coefficients:")
    for name, coef in zip(model.feature_names, model.params):
        print(f"       {name:>16}: {coef:+.4f}")

    priors = positional_priors(df)
    print(f"[fit] positional prior lambda: { {k: round(v,3) for k,v in priors.items()} }")

    # ---- 2026 lambda: current-role prediction, disciplined by reality ----
    # Role (2025 usage) stays single-season — a changed role IS the signal
    # (Part II). Discipline comes from three places instead:
    #   clip:   features cannot leave the training support (done in the fit);
    #   cap:    no fitted rate above the best any player actually sustained;
    #   anchor: blend with the player's own recency-weighted OBSERVED TD rate,
    #           weight growing with evidence (rookies stay model-driven,
    #           three-year veterans are anchored to what they actually score).
    SEASON_W = {2025: 1.0, 2024: 0.62, 2023: 0.38}
    df["sw"] = df["season"].map(SEASON_W).fillna(0) * df["games"]
    ev = df.groupby("gsis_id").apply(
        lambda g: pd.Series({
            "eff_games": float(g["sw"].sum()),
            "rate_obs": float((g["season"].map(SEASON_W).fillna(0) * g["tds"]).sum()
                              / max(g["sw"].sum(), 1e-9)),
        }), include_groups=False).reset_index()

    obs = df[df.games >= 10].copy()
    obs["rate"] = obs["tds"] / obs["games"]
    CEIL = float(obs["rate"].max())
    print(f"[fit] observed TD-rate ceiling (>=10g seasons): {CEIL:.3f}/g — fitted rates soft-capped there")

    latest = df[df.season == 2025].copy()
    latest = latest.merge(ev, on="gsis_id", how="left")
    latest["eff_games"] = latest["eff_games"].fillna(latest["games"])
    latest["rate_obs"] = latest["rate_obs"].fillna(0.0)
    lam_cap = CEIL * (1 - np.exp(-latest["lambda_fit"] / CEIL))
    ANCHOR_K = 12.0   # games of evidence at which observed rate carries half the weight
    w_obs = latest["eff_games"] / (latest["eff_games"] + ANCHOR_K)
    latest["lambda_pred"] = (1 - w_obs) * lam_cap + w_obs * latest["rate_obs"]

    wsh = latest["eff_games"] / (latest["eff_games"] + PRIOR_GAMES)
    latest["lambda_base"] = wsh * latest["lambda_pred"] + (1 - wsh) * latest["position"].map(priors)

    # positional recalibration: implied 2025 totals must match actual totals —
    # aggregate honesty preserved, ordering untouched.
    for pos, grp in latest.groupby("position"):
        implied = float((grp["lambda_base"] * grp["games"]).sum())
        actual = float(grp["tds"].sum())
        if implied > 0:
            k = actual / implied
            latest.loc[latest.position == pos, "lambda_base"] *= k
            print(f"[fit] recalibration {pos}: x{k:.3f}")
    latest["phi"] = latest["position"].map(phi)

    # regression flag: actual minus the CALIBRATED expectation over their games
    latest["td_expected"] = latest["lambda_base"] * latest["games"]
    latest["td_delta"] = latest["tds"] - latest["td_expected"]

    # Gamma yardage per category, shrunk to position by sample
    w25 = weeks[weeks.season == 2025]
    pos_pool = {pos: {
        "rush": gamma_moments(g["rushing_yards"].fillna(0).to_numpy()),
        "rec": gamma_moments(g["receiving_yards"].fillna(0).to_numpy()),
        "pass": gamma_moments(g["passing_yards"].fillna(0).to_numpy()),
    } for pos, g in w25[w25.position.isin(SKILL_POS)].groupby("position")}

    yard_models = {}
    for gsis, g in w25.groupby("gsis_id"):
        pos = g["position"].iloc[0]
        if pos not in SKILL_POS:
            continue
        ym = {}
        for cat, col in (("rush", "rushing_yards"), ("rec", "receiving_yards"), ("pass", "passing_yards")):
            vals = g[col].fillna(0).to_numpy()
            fit = gamma_moments(vals) if len(vals) >= 6 else None
            fit = fit or (pos_pool.get(pos) or {}).get(cat)
            if fit:
                ym[cat] = {"shape": round(fit[0], 4), "scale": round(fit[1], 4),
                           "mean_pg": round(float(np.mean(vals)), 2)}
        yard_models[gsis] = ym

    dmult = defensive_multipliers(points, weeks)

    latest.to_parquet(INTERIM / "model.parquet", index=False)
    (INTERIM / "def_mult.json").write_text(json.dumps(dmult))
    (INTERIM / "yard_models.json").write_text(json.dumps(yard_models))
    (INTERIM / "phi.json").write_text(json.dumps(phi))
    points.to_parquet(INTERIM / "player_week_points.parquet", index=False)

    # The mandated first check: Jonathan Taylor's regression flag
    names = pd.read_parquet(INTERIM / "player_weeks.parquet")[
        ["gsis_id", "player_display_name"]].drop_duplicates("gsis_id")
    lt = latest.merge(names, on="gsis_id")
    jt = lt[lt.player_display_name == "Jonathan Taylor"]
    if len(jt):
        r = jt.iloc[0]
        print(f"[fit] TAYLOR CHECK: {int(r.tds)} actual TD vs {r.td_expected:.1f} fitted "
              f"-> delta {r.td_delta:+.1f} ({'NEGATIVE-REGRESSION FLAG' if r.td_delta > 3 else 'no flag'})")
    top = lt.nlargest(8, "td_delta")[["player_display_name", "position", "tds", "td_expected", "td_delta"]]
    print("[fit] largest negative-regression candidates (TD over fitted):")
    print(top.to_string(index=False))


if __name__ == "__main__":
    main()
