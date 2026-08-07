import json
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
INTERIM = ROOT / "data" / "interim"

SKILL = ["QB", "RB", "WR", "TE"]
COHORTS = [2023, 2024, 2025]
UNDRAFTED_SLOT = 280.0     # past the end of a 7-round (~257 pick) draft
MAX_GAMES = 17


def build_history() -> pd.DataFrame:
    """One row per historical rookie: draft slot + realized first-year output."""
    weeks = pd.read_parquet(INTERIM / "player_weeks.parquet")
    rows = []
    for year in COHORTS:
        path = RAW / f"roster_{year}.parquet"
        if not path.exists():
            print(f"[rookie] roster_{year}.parquet missing — cohort skipped")
            continue
        r = pd.read_parquet(path)
        rk = (r[(r["years_exp"] == 0) & (r["position"].isin(SKILL))]
              [["gsis_id", "position", "draft_number", "full_name"]]
              .drop_duplicates("gsis_id"))
        w = weeks[weeks["season"] == year]
        agg = w.groupby("gsis_id").agg(
            games=("week", "size"),
            tds=("tds", "sum"),
            rush_y=("rushing_yards", "sum"),
            rec_y=("receiving_yards", "sum"),
            pass_td=("passing_tds", "sum"),
            pass_y=("passing_yards", "sum"),
            ints=("passing_interceptions", "sum"),
        ).reset_index()
        m = rk.merge(agg, on="gsis_id", how="left")
        for c in ("games", "tds", "rush_y", "rec_y", "pass_td", "pass_y", "ints"):
            m[c] = m[c].fillna(0.0)
        m["season"] = year
        rows.append(m)
    d = pd.concat(rows, ignore_index=True)
    d["slot"] = d["draft_number"].fillna(UNDRAFTED_SLOT).clip(1, UNDRAFTED_SLOT)
    d["log_slot"] = np.log(d["slot"])
    return d


def fit_rate_curve(d: pd.DataFrame) -> dict:
    """Poisson GLM per position: TDs ~ log(slot), offset log(games).

    Only players who actually appeared inform the RATE (a player with zero
    games has no rate); availability is modeled separately below.
    """
    out = {}
    played = d[d["games"] > 0]
    for pos in SKILL:
        g = played[played["position"] == pos]
        if len(g) < 25:
            out[pos] = None
            continue
        X = sm.add_constant(g["log_slot"].to_numpy(dtype=float))
        y = g["tds"].to_numpy(dtype=float)
        off = np.log(g["games"].to_numpy(dtype=float))
        try:
            res = sm.GLM(y, X, family=sm.families.Poisson(), offset=off).fit()
            b0, b1 = float(res.params[0]), float(res.params[1])
        except Exception as exc:  # pragma: no cover - numerical guard
            print(f"[rookie] {pos} rate GLM failed ({exc}); falling back to mean")
            b0, b1 = float(np.log(max(g["tds"].sum() / g["games"].sum(), 1e-4))), 0.0
        out[pos] = {"b0": round(b0, 5), "b1": round(b1, 5), "n": int(len(g))}
    return out


def fit_games_curve(d: pd.DataFrame) -> dict:
    """Expected first-year games vs log slot: least squares, clipped to [0, 17].

    Fitted over ALL rookies including those who never played — that zero is
    exactly the availability signal we want.
    """
    out = {}
    for pos in SKILL:
        g = d[d["position"] == pos]
        if len(g) < 25:
            out[pos] = None
            continue
        X = sm.add_constant(g["log_slot"].to_numpy(dtype=float))
        y = g["games"].to_numpy(dtype=float)
        res = sm.OLS(y, X).fit()
        out[pos] = {"b0": round(float(res.params[0]), 4),
                    "b1": round(float(res.params[1]), 4), "n": int(len(g))}
    return out


def fit_yardage(d: pd.DataFrame) -> dict:
    """Per-game rushing/receiving yards vs slot, as a multiplier on the R1 rate.

    Stored as absolute yards-per-game at a reference slot plus the same
    log-slot decay, so any rookie's expected yards follow from his draft pick.
    """
    out = {}
    played = d[d["games"] > 0]
    for pos in SKILL:
        g = played[played["position"] == pos]
        if len(g) < 25:
            out[pos] = None
            continue
        res = {}
        for cat, col in (("rush", "rush_y"), ("rec", "rec_y")):
            # rushing yards can be negative on a sack/loss; a per-game rate
            # below zero is not a projectable quantity, so floor it
            ypg = np.clip((g[col] / g["games"]).to_numpy(dtype=float), 0.0, None)
            if ypg.mean() < 0.5:
                res[cat] = None
                continue
            X = sm.add_constant(g["log_slot"].to_numpy(dtype=float))
            # log-link least squares on log(1+ypg) keeps predictions positive
            fit = sm.OLS(np.log1p(ypg), X).fit()
            res[cat] = {"b0": round(float(fit.params[0]), 5),
                        "b1": round(float(fit.params[1]), 5)}
        out[pos] = res
    return out


def fit_passing(d: pd.DataFrame) -> dict:
    """Rookie QB passing: TD/g, INT/g and yards/g vs draft slot.

    Without this a first-overall QB carries pass_td_pg = 0 and scores as a
    non-passer — the same undifferentiated-bucket bug in a second place.
    """
    g = d[(d["position"] == "QB") & (d["games"] > 0) & (d["pass_y"] > 0)]
    if len(g) < 15:
        return None
    X = sm.add_constant(g["log_slot"].to_numpy(dtype=float))
    off = np.log(g["games"].to_numpy(dtype=float))
    out = {}
    for key, col in (("pass_td", "pass_td"), ("int", "ints")):
        try:
            res = sm.GLM(g[col].to_numpy(dtype=float), X,
                         family=sm.families.Poisson(), offset=off).fit()
            out[key] = {"b0": round(float(res.params[0]), 5),
                        "b1": round(float(res.params[1]), 5)}
        except Exception:
            out[key] = None
    ypg = np.clip((g["pass_y"] / g["games"]).to_numpy(dtype=float), 0.0, None)
    fit = sm.OLS(np.log1p(ypg), X).fit()
    out["pass_y"] = {"b0": round(float(fit.params[0]), 5),
                     "b1": round(float(fit.params[1]), 5)}
    out["n"] = int(len(g))
    return out


def predict(model: dict, pos: str, slot: float) -> dict:
    """Public helper — the same math emit_bundle uses.

    The slot is CLIPPED to the range actually observed in the training
    cohorts. A log-link curve extrapolated below its support explodes: the
    earliest historical rookie RB was pick 6, and extrapolating to pick 1
    produced 1.6 TD/g — above the all-time record. Never predict outside the
    data.
    """
    lo = float((model.get("support") or {}).get(pos) or 1.0)
    slot = max(float(slot), lo)
    ls = float(np.log(max(min(slot, UNDRAFTED_SLOT), 1.0)))
    rate_c = model["rate"].get(pos)
    games_c = model["games"].get(pos)
    yard_c = (model["yardage"] or {}).get(pos) or {}

    lam = float(np.exp(rate_c["b0"] + rate_c["b1"] * ls)) if rate_c else 0.05
    games = float(games_c["b0"] + games_c["b1"] * ls) if games_c else 4.0
    games = float(np.clip(games, 0.5, MAX_GAMES))

    yards = {}
    for cat in ("rush", "rec"):
        c = yard_c.get(cat)
        yards[cat] = float(np.expm1(c["b0"] + c["b1"] * ls)) if c else 0.0
        yards[cat] = max(yards[cat], 0.0)
    res = {"lambda": round(lam, 4), "games": round(games, 1),
           "rush_ypg": round(yards["rush"], 1), "rec_ypg": round(yards["rec"], 1),
           "pass_td_pg": 0.0, "int_pg": 0.0, "pass_ypg": 0.0}
    pc = model.get("passing")
    if pos == "QB" and pc:
        if pc.get("pass_td"):
            res["pass_td_pg"] = round(float(np.exp(pc["pass_td"]["b0"] + pc["pass_td"]["b1"] * ls)), 4)
        if pc.get("int"):
            res["int_pg"] = round(float(np.exp(pc["int"]["b0"] + pc["int"]["b1"] * ls)), 4)
        res["pass_ypg"] = round(float(np.expm1(pc["pass_y"]["b0"] + pc["pass_y"]["b1"] * ls)), 1)
    return res


def main():
    d = build_history()
    print(f"[rookie] history: {len(d)} rookie skill-player seasons "
          f"({int(d['draft_number'].notna().sum())} drafted) over {COHORTS}")

    support = {}
    for pos in SKILL:
        g = d[(d["position"] == pos) & d["draft_number"].notna()]
        support[pos] = float(g["draft_number"].min()) if len(g) else 1.0

    model = {
        "support": support,
        "rate": fit_rate_curve(d),
        "games": fit_games_curve(d),
        "yardage": fit_yardage(d),
        "passing": fit_passing(d),
        "undrafted_slot": UNDRAFTED_SLOT,
        "cohorts": COHORTS,
    }
    INTERIM.mkdir(parents=True, exist_ok=True)
    (INTERIM / "rookie_model.json").write_text(json.dumps(model, indent=1))

    print("[rookie] earliest observed draft slot per position (predictions "
          "are clipped here, never extrapolated): "
          + ", ".join(f"{k} {int(v)}" for k, v in sorted(support.items())))
    print("[rookie] fitted curve (TD/g, games, rush+rec yds/g):")
    for pos in SKILL:
        line = []
        for label, slot in (("R1 (pick 10)", 10), ("R2 (45)", 45),
                            ("R4 (115)", 115), ("UDFA", UNDRAFTED_SLOT)):
            p = predict(model, pos, slot)
            extra = f"/{p['pass_td_pg']:.2f}pTD" if pos == "QB" else ""
            line.append(f"{label} {p['lambda']:.3f}/{p['games']:.1f}g/"
                        f"{p['rush_ypg'] + p['rec_ypg']:.0f}y{extra}")
        print(f"  {pos}: " + "   ".join(line))
    print(f"[rookie] wrote {(INTERIM / 'rookie_model.json').name}")


if __name__ == "__main__":
    main()
