"""Build a leakage-safe batter-game training frame from PA-level parquet.

Every feature is knowable BEFORE the target game's first pitch: batter rolling
form and season-to-date rates are computed with a prior-only (shifted) window
that EXCLUDES the target game; the opposing starter's stats are that pitcher's
season-to-date line as of the same date. The label is did_homer for the game.

Usage:
    uv run python -m ml.features --years 2021 2022 2023 2024 2025 --out train_frame.parquet
    uv run python -m ml.features --input sample.parquet --out sample_train.parquet
"""

from __future__ import annotations

import argparse
import warnings

import numpy as np
import pandas as pd

from .ballparks import park_factor_for
from .config import (
    BARREL_LAUNCH_SPEED_ANGLE,
    BB_EVENTS,
    DATA_DIR,
    HARD_HIT_MIN_EV,
    HR_EVENTS,
    K_EVENTS,
)

warnings.filterwarnings("ignore")

SINGLE = {"single"}
DOUBLE = {"double"}
TRIPLE = {"triple"}


def _load(years: list[int] | None, input_path: str | None) -> pd.DataFrame:
    frames = []
    if input_path:
        p = DATA_DIR / input_path if not input_path.startswith("/") else input_path
        frames.append(pd.read_parquet(p))
    if years:
        for y in years:
            p = DATA_DIR / f"pa_events_{y}.parquet"
            if p.exists():
                frames.append(pd.read_parquet(p))
            else:
                print(f"  (missing {p}, skipping)")
    if not frames:
        raise SystemExit("no input data found")
    df = pd.concat(frames, ignore_index=True)
    df["game_date"] = pd.to_datetime(df["game_date"])
    df["season"] = df["game_date"].dt.year
    return df


def _num(s: pd.Series) -> pd.Series:
    """Coerce to plain numpy float64 (pd.NA -> np.nan) so comparisons stay non-nullable."""
    return pd.to_numeric(s, errors="coerce").astype("float64")


def _flag(mask: pd.Series) -> pd.Series:
    """Boolean mask -> int, treating NA as False."""
    return mask.fillna(False).astype(int)


def _pa_flags(df: pd.DataFrame) -> pd.DataFrame:
    ev = df["events"].astype("string")
    ls = _num(df["launch_speed"])
    lsa = _num(df["launch_speed_angle"])
    df = df.assign(
        is_hr=_flag(ev.isin(HR_EVENTS)),
        is_k=_flag(ev.isin(K_EVENTS)),
        is_bb=_flag(ev.isin(BB_EVENTS)),
        is_single=_flag(ev.isin(SINGLE)),
        is_double=_flag(ev.isin(DOUBLE)),
        is_triple=_flag(ev.isin(TRIPLE)),
        is_bbe=_flag(df["type"].astype("string") == "X"),
        is_barrel=_flag(lsa == BARREL_LAUNCH_SPEED_ANGLE),
        is_hardhit=_flag(ls >= HARD_HIT_MIN_EV),
        ev_val=ls,
        la_val=_num(df["launch_angle"]),
        xwoba_val=_num(df["estimated_woba_using_speedangle"]),
    )
    return df


def _prior_cumsum(df: pd.DataFrame, by: list[str], col: str) -> pd.Series:
    """Cumulative sum of prior rows within group (excludes current row)."""
    return df.groupby(by)[col].cumsum() - df[col]


def _prior_roll_sum(df: pd.DataFrame, by: list[str], col: str, n: int) -> pd.Series:
    """Rolling sum of the prior n rows within group (excludes current row)."""
    return df.groupby(by)[col].transform(
        lambda s: s.shift(1).rolling(n, min_periods=1).sum()
    )


def _safe_div(a: pd.Series, b: pd.Series) -> pd.Series:
    out = a / b
    return out.replace([np.inf, -np.inf], np.nan)


# Columns produced by batter_game_aggregates (context + additive per-game aggregates).
# The scorer appends synthetic "today" rows carrying the same columns (aggregates = 0) so the
# prior-only window helpers below compute identical season-to-date / rolling features at serve time.
BATTER_AGG_COLUMNS = [
    "batter", "game_pk", "game_date", "season", "stand", "starter_throws",
    "starter_id", "home_team", "away_team", "inning_topbot",
    "pa", "hr", "k", "bb", "singles", "doubles", "triples", "bbe", "barrels",
    "hardhits", "ev_sum", "ev_n", "la_sum", "la_n", "xwoba_sum", "xwoba_n",
    "hits", "tb", "ab",
]
PITCHER_AGG_COLUMNS = [
    "pitcher", "game_pk", "game_date", "season", "bf", "hr_allowed", "k", "bb",
]


def batter_game_aggregates(df: pd.DataFrame) -> pd.DataFrame:
    """PA-level Statcast -> one additive-aggregate row per batter-game (no features yet).

    Split out from feature computation so the daily scorer can append synthetic "today"
    batter-game rows before the prior-window features are computed (exact train/serve parity).
    """
    df = _pa_flags(df)

    # First PA of each batter-game -> opposing STARTER + handedness context.
    df_sorted = df.sort_values(["game_pk", "batter", "at_bat_number"])
    first_pa = (
        df_sorted.groupby(["batter", "game_pk"], as_index=False)
        .first()[
            ["batter", "game_pk", "game_date", "season", "stand", "p_throws",
             "pitcher", "home_team", "away_team", "inning_topbot"]
        ]
        .rename(columns={"pitcher": "starter_id", "p_throws": "starter_throws"})
    )

    # Batter-game additive aggregates.
    agg = (
        df.groupby(["batter", "game_pk"], as_index=False)
        .agg(
            pa=("events", "size"),
            hr=("is_hr", "sum"),
            k=("is_k", "sum"),
            bb=("is_bb", "sum"),
            singles=("is_single", "sum"),
            doubles=("is_double", "sum"),
            triples=("is_triple", "sum"),
            bbe=("is_bbe", "sum"),
            barrels=("is_barrel", "sum"),
            hardhits=("is_hardhit", "sum"),
            ev_sum=("ev_val", "sum"),
            ev_n=("ev_val", "count"),
            la_sum=("la_val", "sum"),
            la_n=("la_val", "count"),
            xwoba_sum=("xwoba_val", "sum"),
            xwoba_n=("xwoba_val", "count"),
        )
    )
    bg = first_pa.merge(agg, on=["batter", "game_pk"], how="left")
    bg["hits"] = bg["singles"] + bg["doubles"] + bg["triples"] + bg["hr"]
    bg["tb"] = bg["singles"] + 2 * bg["doubles"] + 3 * bg["triples"] + 4 * bg["hr"]
    bg["ab"] = (bg["pa"] - bg["bb"]).clip(lower=0)
    return bg


def add_batter_features(bg: pd.DataFrame) -> pd.DataFrame:
    """Add the prior-only (leakage-safe) batter features + context to a batter-game frame."""
    bg = bg.sort_values(["batter", "season", "game_date", "game_pk"]).reset_index(drop=True)

    by = ["batter", "season"]
    # Season-to-date (prior only) rates.
    pa_std = _prior_cumsum(bg, by, "pa")
    bg["b_pa_std"] = pa_std
    bg["b_hr_per_pa_std"] = _safe_div(_prior_cumsum(bg, by, "hr"), pa_std)
    bg["b_k_rate_std"] = _safe_div(_prior_cumsum(bg, by, "k"), pa_std)
    bg["b_bb_rate_std"] = _safe_div(_prior_cumsum(bg, by, "bb"), pa_std)
    bg["b_iso_std"] = _safe_div(
        _prior_cumsum(bg, by, "tb") - _prior_cumsum(bg, by, "hits"),
        _prior_cumsum(bg, by, "ab"),
    )
    # Rolling recent-form (prior only).
    bbe40 = _prior_roll_sum(bg, by, "bbe", 40)
    bg["b_barrel_rate_40"] = _safe_div(_prior_roll_sum(bg, by, "barrels", 40), bbe40)
    bg["b_hardhit_rate_40"] = _safe_div(_prior_roll_sum(bg, by, "hardhits", 40), bbe40)
    bg["b_mean_ev_40"] = _safe_div(
        _prior_roll_sum(bg, by, "ev_sum", 40), _prior_roll_sum(bg, by, "ev_n", 40)
    )
    bg["b_mean_la_40"] = _safe_div(
        _prior_roll_sum(bg, by, "la_sum", 40), _prior_roll_sum(bg, by, "la_n", 40)
    )
    bg["b_xwoba_con_40"] = _safe_div(
        _prior_roll_sum(bg, by, "xwoba_sum", 40), _prior_roll_sum(bg, by, "xwoba_n", 40)
    )
    bg["b_recent_hr_15"] = _prior_roll_sum(bg, by, "hr", 15)

    # Context features.
    bg["park_hr_factor"] = bg["home_team"].map(park_factor_for)
    stand = bg["stand"].astype("string").str.upper()
    thr = bg["starter_throws"].astype("string").str.upper()
    bg["platoon_adv"] = (
        (stand == "S")
        | ((stand == "L") & (thr == "R"))
        | ((stand == "R") & (thr == "L"))
    ).astype(int)

    bg["did_homer"] = (bg["hr"] >= 1).astype(int)
    return bg


def build_batter_game(df: pd.DataFrame) -> pd.DataFrame:
    return add_batter_features(batter_game_aggregates(df))


def pitcher_game_aggregates(df: pd.DataFrame) -> pd.DataFrame:
    """PA-level Statcast -> one additive-aggregate row per pitcher-game (no features yet)."""
    df = _pa_flags(df)
    return (
        df.groupby(["pitcher", "game_pk"], as_index=False)
        .agg(
            game_date=("game_date", "first"),
            season=("season", "first"),
            bf=("events", "size"),
            hr_allowed=("is_hr", "sum"),
            k=("is_k", "sum"),
            bb=("is_bb", "sum"),
        )
    )


def add_pitcher_features(pg: pd.DataFrame) -> pd.DataFrame:
    """Add the prior-only pitcher season-to-date features to a pitcher-game frame."""
    pg = pg.sort_values(["pitcher", "season", "game_date", "game_pk"]).reset_index(drop=True)
    by = ["pitcher", "season"]
    bf_std = _prior_cumsum(pg, by, "bf")
    pg["p_bf_std"] = bf_std
    pg["p_hr_per_bf_std"] = _safe_div(_prior_cumsum(pg, by, "hr_allowed"), bf_std)
    pg["p_k_per_bf_std"] = _safe_div(_prior_cumsum(pg, by, "k"), bf_std)
    pg["p_bb_per_bf_std"] = _safe_div(_prior_cumsum(pg, by, "bb"), bf_std)
    return pg


def build_pitcher_std(df: pd.DataFrame) -> pd.DataFrame:
    pg = add_pitcher_features(pitcher_game_aggregates(df))
    return pg[["pitcher", "game_pk", "p_bf_std", "p_hr_per_bf_std",
               "p_k_per_bf_std", "p_bb_per_bf_std"]]


FEATURE_COLUMNS = [
    "b_pa_std", "b_hr_per_pa_std", "b_k_rate_std", "b_bb_rate_std", "b_iso_std",
    "b_barrel_rate_40", "b_hardhit_rate_40", "b_mean_ev_40", "b_mean_la_40",
    "b_xwoba_con_40", "b_recent_hr_15",
    "p_bf_std", "p_hr_per_bf_std", "p_k_per_bf_std", "p_bb_per_bf_std",
    "park_hr_factor", "platoon_adv",
]


def build_training_frame(df: pd.DataFrame) -> pd.DataFrame:
    bg = build_batter_game(df)
    pstd = build_pitcher_std(df)
    out = bg.merge(
        pstd, left_on=["starter_id", "game_pk"], right_on=["pitcher", "game_pk"],
        how="left",
    )
    keep = (
        ["batter", "game_pk", "game_date", "season", "starter_id", "home_team",
         "pa", "hr", "did_homer"]
        + FEATURE_COLUMNS
    )
    return out[keep]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=int, nargs="*", help="Season years to load")
    ap.add_argument("--input", type=str, help="Ad hoc PA parquet to load")
    ap.add_argument("--out", type=str, default="train_frame.parquet")
    args = ap.parse_args()

    df = _load(args.years, args.input)
    print(f"loaded {len(df)} PA rows across seasons {sorted(df['season'].unique())}")
    frame = build_training_frame(df)
    out_path = DATA_DIR / args.out if not args.out.startswith("/") else args.out
    frame.to_parquet(out_path, index=False)
    hr_rate = frame["did_homer"].mean()
    print(f"batter-games={len(frame)}  HR base rate={hr_rate:.4f}")
    print(f"non-null feature coverage:")
    for c in FEATURE_COLUMNS:
        print(f"  {c}: {frame[c].notna().mean():.2%}")
    print(f"-> wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
