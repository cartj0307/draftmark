import json
import sys
from datetime import date
from pathlib import Path

import numpy as np
import math

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rookie_model import predict as rookie_predict  # noqa: E402
RAW = ROOT / "data" / "raw"
INTERIM = ROOT / "data" / "interim"

SEASON = 2026
LEAGUE_WEEKS = 17
SKILL_POS = {"QB", "RB", "WR", "TE"}
REGRESSION_FLAG_TD = 3.0  # actual minus fitted TDs above this -> flag


def load_schedule():
    g = pd.read_csv(RAW / "games.csv")
    g = g[(g["season"] == SEASON) & (g["game_type"] == "REG")]
    sched = {}
    for _, r in g.iterrows():
        wk = int(r["week"])
        if wk > LEAGUE_WEEKS + 1:
            continue
        sched.setdefault(r["home_team"], {})[wk] = {"opp": r["away_team"], "home": True}
        sched.setdefault(r["away_team"], {})[wk] = {"opp": r["home_team"], "home": False}
    out = {}
    for team, weeks in sched.items():
        arr, bye = [], None
        for w in range(1, LEAGUE_WEEKS + 1):
            if w in weeks:
                arr.append(weeks[w]["opp"])
            else:
                arr.append(None)
                bye = w
        out[team] = {"opponents": arr, "bye": bye}
    return out


def nn(v):
    """NaN-from-pandas -> None; invalid JSON in browsers otherwise."""
    return None if v is None or (isinstance(v, float) and v != v) else v


def optional_json(path: Path):
    return json.loads(path.read_text()) if path.exists() else None


def main():
    xref = pd.read_parquet(INTERIM / "player_xref.parquet")
    model = pd.read_parquet(INTERIM / "model.parquet")
    usage = pd.read_parquet(INTERIM / "player_usage.parquet")
    env = pd.read_parquet(INTERIM / "team_env.parquet")
    yard_models = json.loads((INTERIM / "yard_models.json").read_text())
    phi_by_pos = json.loads((INTERIM / "phi.json").read_text())
    def_mult = json.loads((INTERIM / "def_mult.json").read_text())
    weeks = pd.read_parquet(INTERIM / "player_weeks.parquet")
    schedule = load_schedule()

    # ---- rookie prior: draft capital is the only honest pre-season signal ----
    # Without this every player with no 2025 snaps collapses into one bucket
    # and a 3rd-overall pick scores like a camp body. See build/rookie_model.py.
    rookie_model = optional_json(INTERIM / "rookie_model.json")
    draft_info = {}
    rpath = RAW / "roster_2026.parquet"
    if rpath.exists():
        rr = pd.read_parquet(rpath)
        for _, row in rr.drop_duplicates("gsis_id").iterrows():
            gid = row.get("gsis_id")
            if not isinstance(gid, str):
                continue
            dn = row.get("draft_number")
            draft_info[gid] = {
                "years_exp": (int(row["years_exp"])
                              if pd.notna(row.get("years_exp")) else None),
                "draft_number": (float(dn) if pd.notna(dn) else None),
                "draft_club": (row.get("draft_club")
                               if pd.notna(row.get("draft_club")) else None),
            }
    if rookie_model is None:
        print("[bundle] WARNING: rookie_model.json absent — run build/rookie_model.py "
              "or every rookie falls back to an undifferentiated prior")

    # positional Gamma shapes, so a synthesized rookie yardage model keeps a
    # realistic spread instead of being invented whole
    shape_by_pos = {}
    for gid_, ym in yard_models.items():
        prow = xref[xref.gsis_id == gid_]
        if prow.empty:
            continue
        ppos = prow.iloc[0]["position"]
        for cat in ("rush", "rec", "pass"):
            c = (ym or {}).get(cat)
            if c and c.get("shape", 0) > 0.01:
                shape_by_pos.setdefault((ppos, cat), []).append(c["shape"])
    shape_by_pos = {k: float(np.median(v)) for k, v in shape_by_pos.items() if v}

    def gamma_from_mean(ppos, cat, mean_pg):
        """Gamma hitting a target mean, borrowing the position's typical shape."""
        if mean_pg is None or mean_pg <= 0.05:
            return None
        sh = shape_by_pos.get((ppos, cat), 0.7)
        sh = max(sh, 0.05)
        return {"shape": round(sh, 4), "scale": round(mean_pg / sh, 4),
                "mean_pg": round(mean_pg, 2)}

    # positional median yards/g among players who DO have a fitted model —
    # used to give the residual no-usage bucket a real yardage model instead
    # of null (a player scored as gaining zero yards all season is never a
    # defensible prior, even for a fringe player).
    ypg_by_pos = {}
    for gid_, ym in yard_models.items():
        prow_ = xref[xref.gsis_id == gid_]
        if prow_.empty or not ym:
            continue
        ppos_ = prow_.iloc[0]["position"]
        for cat in ("rush", "rec", "pass"):
            c = ym.get(cat)
            if c and c.get("mean_pg", 0) > 0:
                ypg_by_pos.setdefault((ppos_, cat), []).append(c["mean_pg"])
    ypg_by_pos = {k: float(np.median(v)) for k, v in ypg_by_pos.items() if v}

    rookie_applied = {"count": 0, "by_pos": {}}

    # Ceiling for any rookie: the 95th percentile of ESTABLISHED players at the
    # position. Draft capital is real information but it is not evidence of NFL
    # production — no player with zero snaps may project above the top handful
    # of proven starters.
    est = model[model.index.isin(usage.index)] if False else model
    rookie_cap = {}
    for pos_ in SKILL_POS:
        vals = model.loc[model["position"] == pos_, "lambda_base"].to_numpy(dtype=float) \
            if "position" in model.columns else np.array([])
        if len(vals):
            rookie_cap[pos_] = float(np.percentile(vals, 95))

    # yardage ceiling for rookies: the 90th percentile of established players
    ypg_cap = {}
    for gid_c, ym_c in yard_models.items():
        prow_c = xref[xref.gsis_id == gid_c]
        if prow_c.empty or not ym_c:
            continue
        ppos_c = prow_c.iloc[0]["position"]
        for cat_c in ("rush", "rec", "pass"):
            c_c = ym_c.get(cat_c)
            if c_c and c_c.get("mean_pg", 0) > 0:
                ypg_cap.setdefault((ppos_c, cat_c), []).append(c_c["mean_pg"])
    ypg_cap = {k: float(np.percentile(v, 90)) for k, v in ypg_cap.items() if v}

    def discipline_rookie(pos_, slot_, lam_raw):
        """Shrink the draft-capital curve toward the positional prior, then cap.

        A rookie carries zero player-specific NFL evidence, so draft capital is
        treated as a limited quantity of information: an early pick is worth
        more 'evidence games' than a late one, and the rest of the weight falls
        back on the positional prior.
        """
        ls_ = math.log(max(min(float(slot_), 280.0), 1.0))
        ev = max(1.5, 13.0 - 2.2 * ls_)          # ~11 games at pick 3, ~1.5 undrafted
        w = ev / (ev + 11.0)
        prior = pos_prior_lambda.get(pos_, 0.1)
        lam_ = w * lam_raw + (1 - w) * prior
        cap = rookie_cap.get(pos_)
        return (min(lam_, cap) if cap else lam_), w

    # pending-source payloads, consumed if their ingests have been run
    dst_models = optional_json(INTERIM / "dst_models.json") or {}
    k_models = optional_json(INTERIM / "kicker_models.json") or {}
    espn = optional_json(RAW / "espn_players.json")       # projections + ADP by espn_id
    sleeper = optional_json(RAW / "sleeper_players.json") # injury/depth by sleeper_id
    vegas = optional_json(RAW / "vegas_totals.json")      # win totals / implied by team

    env25 = env[env.season == 2025].set_index("team")
    usage25 = usage[usage.season == 2025].set_index("gsis_id")
    model25 = model.set_index("gsis_id")
    games25 = weeks[weeks.season == 2025].groupby("gsis_id")["week"].nunique()

    espn_by_id = {str(p["espn_id"]): p for p in espn["players"]} if espn else {}
    slp_by_id = {str(p["sleeper_id"]): p for p in sleeper["players"]} if sleeper else {}

    # passing model: shrunk per-game pass TD / INT rates from 2025 weeks
    # (the QB fix flagged by the backtest — 3 per pass TD and the QB-points
    # tiebreaker make this matter)
    #
    # Passing rate is blended across the LAST THREE SEASONS with recency
    # weights, not 2025 alone. A career pocket passer who threw 24/20/46 TDs
    # (2023/24/25) should not be projected off the 46 in isolation — that
    # walk-year outlier reverts. Recent seasons weigh more (a young QB trending
    # up keeps most of his rise), but one anomalous year can't dominate.
    SEASON_W = {2025: 1.0, 2024: 0.62, 2023: 0.38}   # recency decay
    qb25 = weeks[(weeks.season == 2025) & (weeks.position == "QB")]
    qb_pass_prior = float(qb25["passing_tds"].fillna(0).mean())
    qb_int_prior = float(qb25["passing_interceptions"].fillna(0).mean())
    PASS_PRIOR_G = 10   # firmer pull to the population mean for thin samples

    def weighted_rate(g, col):
        """Recency-weighted per-game rate over up to three seasons."""
        num = den = 0.0
        for season, sw in SEASON_W.items():
            gs = g[g.season == season]
            if len(gs) == 0:
                continue
            num += sw * gs[col].fillna(0).sum()
            den += sw * len(gs)
        return (num / den, den) if den > 0 else (0.0, 0.0)

    passing = {}
    for gsis, g in weeks.groupby("gsis_id"):
        is_qb = g["position"].iloc[0] == "QB"
        ptd_rate, eff_g = weighted_rate(g, "passing_tds")
        pint_rate, _ = weighted_rate(g, "passing_interceptions")
        # shrink toward the population prior by effective (recency-weighted) games
        sh = eff_g / (eff_g + PASS_PRIOR_G)
        if is_qb:
            ptd = sh * ptd_rate + (1 - sh) * qb_pass_prior
            pint = sh * pint_rate + (1 - sh) * qb_int_prior
        else:
            ptd = sh * ptd_rate
            pint = sh * pint_rate
        passing[gsis] = (round(float(ptd), 4), round(float(pint), 4))

    pos_prior_lambda = {}
    for pos, grp in model.groupby("position"):
        top = grp.nlargest(max(6, len(grp) // 2), "lambda_fit")
        pos_prior_lambda[pos] = float(np.average(top["lambda_base"], weights=top["games"]))

    players = []
    for _, x in xref.iterrows():
        pos, team, gsis = x["position"], x["team"], x["gsis_id"]
        if pos == "K":
            continue  # kickers handled below
        sched = schedule.get(team)
        m = model25.loc[gsis] if gsis in model25.index else None
        u = usage25.loc[gsis] if gsis in usage25.index else None
        g = float(games25.get(gsis, 0))

        di = draft_info.get(gsis, {})
        is_rookie = di.get("years_exp") == 0
        rk = None

        if m is not None:
            lam = float(m["lambda_base"])
            fitted_from = "2025_opportunity"
            td_delta = float(m["td_delta"])
        elif is_rookie and rookie_model and pos in SKILL_POS:
            # draft slot -> first-year rate, fitted over three rookie cohorts
            slot = di.get("draft_number") or rookie_model["undrafted_slot"]
            rk = rookie_predict(rookie_model, pos, slot)
            lam, rk_w = discipline_rookie(pos, slot, rk["lambda"])
            # The SAME evidence weight must govern yardage and passing: they
            # come from the same thin curve (four first-round TEs, one of them
            # an outlier rookie season). Shrinking lambda but leaving yardage
            # raw let a rookie TE out-gain the 90th percentile of the position.
            for cat_, key_ in (("rush", "rush_ypg"), ("rec", "rec_ypg"),
                               ("pass", "pass_ypg")):
                med_ = ypg_by_pos.get((pos, cat_), 0.0)
                val_ = rk_w * rk[key_] + (1 - rk_w) * med_
                cap_ = ypg_cap.get((pos, cat_))
                rk[key_] = round(min(val_, cap_) if cap_ else val_, 1)
            rk["pass_td_pg"] = round(rk_w * rk["pass_td_pg"], 4)
            rk["int_pg"] = round(rk_w * rk["int_pg"], 4)
            rk["games"] = min(rk["games"], 16.0)   # no rookie is a lock for 17
            fitted_from = "rookie_draft_capital"
            td_delta = 0.0
            rookie_applied["count"] += 1
            rookie_applied["by_pos"][pos] = rookie_applied["by_pos"].get(pos, 0) + 1
        else:
            lam = pos_prior_lambda.get(pos, 0.1) * 0.5  # no 2025 usage: half prior
            fitted_from = "positional_prior_no_2025_usage"
            td_delta = 0.0

        lam_weekly = []
        if sched:
            for w in range(LEAGUE_WEEKS):
                opp = sched["opponents"][w]
                if opp is None:
                    lam_weekly.append(0.0)
                else:
                    mult = def_mult.get(opp, {}).get(pos, 1.0)
                    lam_weekly.append(round(lam * mult, 4))
        else:
            lam_weekly = [round(lam, 4)] * LEAGUE_WEEKS

        gpg = (lambda col: round(float(u[col]) / g, 3) if u is not None and g > 0 else 0.0)

        prior = {"espn_projection": None, "adp": None, "adp_sd": None}
        if espn_by_id and x["espn_id"] and str(x["espn_id"]) in espn_by_id:
            e = espn_by_id[str(x["espn_id"])]
            prior = {"espn_projection": e.get("projection"),
                     "adp": e.get("adp"), "adp_sd": e.get("adp_sd")}

        status = None
        if slp_by_id and x["sleeper_id"] and str(x["sleeper_id"]) in slp_by_id:
            status = slp_by_id[str(x["sleeper_id"])].get("injury_status")

        if pos not in SKILL_POS:
            exp_games = None
        elif rk is not None:
            # rookies have no prior-season games; availability comes from the
            # same draft-capital curve rather than a constant 4.6 for everyone
            exp_games = round(rk["games"] / 17 * LEAGUE_WEEKS, 1)
        else:
            exp_games = round((g + 0.85 * 8) / (17 + 8) * LEAGUE_WEEKS, 1)

        rookie_yardage = None
        if (rk is None and pos in SKILL_POS
                and fitted_from == "positional_prior_no_2025_usage"
                and yard_models.get(gsis) is None):
            # same half-discount as the lambda, so points and yards agree
            rookie_yardage = {
                cat: gamma_from_mean(pos, cat, ypg_by_pos.get((pos, cat), 0.0) * 0.5)
                for cat in ("rush", "rec", "pass")
            }
        if rk is not None and yard_models.get(gsis) is None:
            rookie_yardage = {
                "rush": gamma_from_mean(pos, "rush", rk["rush_ypg"]),
                "rec": gamma_from_mean(pos, "rec", rk["rec_ypg"]),
                "pass": gamma_from_mean(pos, "pass", rk["pass_ypg"]),
            }

        notes = []
        if td_delta > REGRESSION_FLAG_TD:
            notes.append(f"negative-regression flag: {int(m['tds'])} TD on "
                         f"{m['td_expected']:.1f} fitted from opportunity")
        if fitted_from == "rookie_draft_capital":
            dn = di.get("draft_number")
            where = f"pick {int(dn)}" if dn else "undrafted"
            notes.append(f"rookie ({where}) — projection from draft capital, "
                         "no NFL usage yet")
        elif fitted_from != "2025_opportunity":
            notes.append("no 2025 usage — lambda is a discounted positional prior")

        players.append({
            "draftmark_id": x["draftmark_id"],
            "gsis_id": gsis,
            "espn_id": nn(x["espn_id"]),
            "sleeper_id": nn(x["sleeper_id"]),
            "name": x["name"],
            "position": pos,
            "team": team,
            "usage": {
                "gl_carries_pg": gpg("gl_carries"),
                "rz10_carries_pg": gpg("rz10_carries"),
                "rz20_touches_pg": round(gpg("rz20_carries") + gpg("rz20_targets"), 3),
                "ez_targets_pg": gpg("ez_targets"),
                "carries_pg": gpg("carries"),
                "targets_pg": gpg("targets"),
                "games_2025": int(g),
            },
            "usage_secondary": {
                "target_share": round(float(u["target_share"]), 4) if u is not None else 0.0,
                "air_yards_share": round(float(u["air_yards_share"]), 4) if u is not None else 0.0,
                "wopr": round(float(u["wopr"]), 4) if u is not None else 0.0,
            },
            "td_model": {
                "lambda_base": round(lam, 4),
                "dispersion": phi_by_pos.get(pos, 200.0),
                "lambda_weekly": lam_weekly,
                "pass_td_pg": (rk["pass_td_pg"] if rk is not None
                               else passing.get(gsis, (0.0, 0.0))[0]),
                "int_pg": (rk["int_pg"] if rk is not None
                           else passing.get(gsis, (0.0, 0.0))[1]),
                "fitted_from": fitted_from,
                "td_actual_2025": int(m["tds"]) if m is not None else None,
                "td_fitted_2025": round(float(m["td_expected"]), 1) if m is not None else None,
                "td_delta_2025": round(td_delta, 1) if m is not None else None,
            },
            "yardage_model": (yard_models.get(gsis) or rookie_yardage),
            "availability": {"expected_games": exp_games, "status": status},
            "priors": prior,
            "handcuff_of": None,  # populated by Sleeper depth-chart ingest
            "notes": notes,
        })

    # kickers: identity + schedule; distribution model activates with Vegas
    kickers = []
    for _, x in xref[xref["position"] == "K"].iterrows():
        kickers.append({
            "draftmark_id": x["draftmark_id"], "gsis_id": x["gsis_id"],
            "espn_id": nn(x["espn_id"]), "sleeper_id": nn(x["sleeper_id"]),
            "name": x["name"], "team": x["team"],
            "model": k_models.get(x["gsis_id"]),
            "model_note": "2025 weekly points, engine-scored from real kicks; "
                          "Vegas implied totals sharpen this when ingested",
        })

    # D/ST: one per NFL team; distribution model activates with Vegas
    dst = []
    for team in sorted(schedule.keys()):
        e = env25.loc[team] if team in env25.index else None
        dst.append({
            "team": team,
            "model": dst_models.get(team),
            "model_note": "2025 weekly points, engine-scored from real PA/yards/"
                          "takeaways/return TDs; Vegas sharpens when ingested",
        })

    teams = {}
    for team, sch in schedule.items():
        e = env25.loc[team] if team in env25.index else None
        teams[team] = {
            "schedule_2026": sch["opponents"],
            "bye": sch["bye"],
            "env_2025": {
                "plays_pg": round(float(e["plays_pg"]), 2) if e is not None else None,
                "rz_trips_pg": round(float(e["rz_trips_pg"]), 2) if e is not None else None,
                "rz_td_rate": round(float(e["rz_td_rate"]), 4) if e is not None else None,
                "off_td_pg": round(float(e["off_td_pg"]), 2) if e is not None else None,
            },
            "implied_total": (vegas or {}).get("teams", {}).get(team, {}).get("implied_total"),
            "def_mult_by_pos": def_mult.get(team, {}),
        }

    bundle = {
        "meta": {
            "built": date.today().isoformat(),
            "season": SEASON,
            "sources": {
                "nflverse_pbp": [2023, 2024, 2025],
                "schedule": "nflverse games.csv (real 2026 schedule)",
                "roster": "nflverse roster_2026",
                "espn": bool(espn), "sleeper": bool(sleeper), "vegas": bool(vegas),
            },
            "scoring_validation": "17/17 Gibbs 2025 + 3 synthetics (test/scoring.test.js)",
            "dispersion_finding": "population of TD-role players 2023-2025 is "
                "near-Poisson (median var/mean 0.93-1.01 by position); NB kept "
                "with fitted phi so overdispersion can express where it exists",
            "def_multipliers": "2025 engine-scored points allowed by position, "
                "deviation shrunk to 25% preseason",
            "pending": [k for k, v in
                        {"espn": espn, "sleeper": sleeper, "vegas": vegas}.items() if not v],
        },
        "teams": teams,
        "players": players,
        "dst": dst,
        "kickers": kickers,
    }

    out = json.dumps(bundle, separators=(",", ":"), allow_nan=False)
    # THE RULE — hard gate, not a convention
    assert "projected_points" not in out, "bundle contains projected_points — forbidden"
    path = ROOT / "data" / "bundle.json"
    path.write_text(out)
    size_mb = len(out) / 1e6
    print(f"[bundle] {len(players)} players, {len(kickers)} kickers, {len(dst)} D/ST, "
          f"{len(teams)} teams -> {size_mb:.2f} MB")
    assert size_mb < 5, "bundle exceeds 5 MB"
    n_lam = sum(1 for p in players if p["td_model"]["lambda_base"] > 0)
    print(f"[bundle] {n_lam}/{len(players)} skill players carry fitted lambda + dispersion")
    if rookie_applied["count"]:
        by = ", ".join(f"{k} {v}" for k, v in sorted(rookie_applied["by_pos"].items()))
        print(f"[bundle] rookie prior applied to {rookie_applied['count']} players ({by})")
    missing_ids = sum(1 for p in players
                      if p["espn_id"] is None and p["position"] in SKILL_POS)
    if missing_ids:
        print(f"[bundle] NOTE: {missing_ids} skill players have no ESPN id — ESPN "
              "projections/ADP cannot attach to them (mostly rookies; run "
              "ingest_sleeper.py to improve the crosswalk)")
    print(f"[bundle] pending ingests: {bundle['meta']['pending'] or 'none'}")


if __name__ == "__main__":
    main()
