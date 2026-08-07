import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
INTERIM = ROOT / "data" / "interim"

PBP_COLS = [
    "season", "week", "season_type", "game_id", "posteam", "defteam", "drive",
    "play_type", "rush_attempt", "pass_attempt", "qb_scramble",
    "rusher_player_id", "receiver_player_id", "passer_player_id",
    "yardline_100", "air_yards", "touchdown", "rush_touchdown", "pass_touchdown",
    "td_player_id", "two_point_attempt",
]


def load_pbp(season: int) -> pd.DataFrame:
    df = pd.read_parquet(RAW / f"pbp_{season}.parquet", columns=PBP_COLS)
    df = df[df["season_type"] == "REG"].copy()
    return df


def player_usage(pbp: pd.DataFrame, season: int) -> pd.DataFrame:
    rush = pbp[(pbp["rush_attempt"] == 1) & pbp["rusher_player_id"].notna()].copy()
    tgt = pbp[(pbp["pass_attempt"] == 1) & pbp["receiver_player_id"].notna()].copy()

    r = rush.groupby("rusher_player_id").agg(
        carries=("rush_attempt", "size"),
        gl_carries=("yardline_100", lambda s: (s <= 5).sum()),
        rz10_carries=("yardline_100", lambda s: (s <= 10).sum()),
        rz20_carries=("yardline_100", lambda s: (s <= 20).sum()),
        rush_weeks=("week", "nunique"),
    )
    r.index.name = "gsis_id"

    tgt["ez_target"] = (tgt["air_yards"] >= tgt["yardline_100"]).fillna(False)
    t = tgt.groupby("receiver_player_id").agg(
        targets=("pass_attempt", "size"),
        rz20_targets=("yardline_100", lambda s: (s <= 20).sum()),
        ez_targets=("ez_target", "sum"),
        air_yards=("air_yards", "sum"),
        tgt_weeks=("week", "nunique"),
    )
    t.index.name = "gsis_id"

    # team totals for shares (secondary metrics — stored, not driving)
    team_targets = tgt.groupby("posteam")["pass_attempt"].size().rename("team_targets")
    team_air = tgt.groupby("posteam")["air_yards"].sum().rename("team_air_yards")
    player_team = pd.concat([
        rush.groupby("rusher_player_id")["posteam"].agg(lambda s: s.mode().iat[0]),
        tgt.groupby("receiver_player_id")["posteam"].agg(lambda s: s.mode().iat[0]),
    ])
    player_team = player_team.groupby(level=0).first().rename("team")
    player_team.index.name = "gsis_id"

    u = r.join(t, how="outer").join(player_team, how="left").fillna(0)
    u = u.merge(team_targets, left_on="team", right_index=True, how="left")
    u = u.merge(team_air, left_on="team", right_index=True, how="left")
    u["target_share"] = (u["targets"] / u["team_targets"]).fillna(0.0)
    u["air_yards_share"] = (u["air_yards"] / u["team_air_yards"]).fillna(0.0)
    u["wopr"] = 1.5 * u["target_share"] + 0.7 * u["air_yards_share"]
    u["season"] = season
    return u.reset_index()


def team_environment(pbp: pd.DataFrame, season: int) -> pd.DataFrame:
    off = pbp[pbp["posteam"].notna() & pbp["play_type"].isin(["run", "pass"])].copy()
    games = off.groupby("posteam")["game_id"].nunique().rename("games")
    plays = off.groupby("posteam").size().rename("plays")

    # A red-zone trip = a drive with at least one snap at yardline_100 <= 20.
    rz = off[off["yardline_100"] <= 20]
    trips = rz.groupby(["posteam", "game_id", "drive"]).size().reset_index()
    rz_trips = trips.groupby("posteam").size().rename("rz_trips")
    # TD on those drives
    drive_td = off.groupby(["posteam", "game_id", "drive"])["touchdown"].max().reset_index()
    rz_drives = trips[["posteam", "game_id", "drive"]].merge(drive_td, on=["posteam", "game_id", "drive"])
    rz_td = rz_drives.groupby("posteam")["touchdown"].sum().rename("rz_tds")

    off_td = off.groupby("posteam")["touchdown"].sum().rename("off_tds")

    env = pd.concat([games, plays, rz_trips, rz_td, off_td], axis=1).fillna(0)
    env["plays_pg"] = env["plays"] / env["games"]
    env["rz_trips_pg"] = env["rz_trips"] / env["games"]
    env["rz_td_rate"] = env["rz_tds"] / env["rz_trips"].replace(0, pd.NA)
    env["off_td_pg"] = env["off_tds"] / env["games"]
    env["season"] = season
    env.index.name = "team"
    return env.reset_index()


def player_week_tds(season: int) -> pd.DataFrame:
    ps = pd.read_parquet(RAW / f"player_stats_{season}.parquet")
    ps = ps[ps["season_type"] == "REG"].copy()
    # nflverse renamed columns between release generations — normalize here
    ps = ps.rename(columns={
        "recent_team": "team",
        "interceptions": "passing_interceptions",
    })
    ps["tds"] = ps["rushing_tds"].fillna(0) + ps["receiving_tds"].fillna(0)
    out = ps[["player_id", "player_display_name", "position", "team", "season", "week",
              "tds", "rushing_yards", "receiving_yards", "rushing_tds", "receiving_tds",
              "passing_yards", "passing_tds", "passing_interceptions", "receptions",
              "carries", "targets"]].rename(columns={"player_id": "gsis_id"})
    return out


def main(seasons):
    INTERIM.mkdir(parents=True, exist_ok=True)
    usages, envs, weeks = [], [], []
    for season in seasons:
        print(f"[features] season {season}")
        pbp = load_pbp(season)
        usages.append(player_usage(pbp, season))
        envs.append(team_environment(pbp, season))
        weeks.append(player_week_tds(season))
    pd.concat(usages).to_parquet(INTERIM / "player_usage.parquet", index=False)
    pd.concat(envs).to_parquet(INTERIM / "team_env.parquet", index=False)
    pd.concat(weeks).to_parquet(INTERIM / "player_weeks.parquet", index=False)
    print("[features] wrote player_usage, team_env, player_weeks to data/interim/")


if __name__ == "__main__":
    seasons = [int(a) for a in sys.argv[1:]] or [2023, 2024, 2025]
    main(seasons)
