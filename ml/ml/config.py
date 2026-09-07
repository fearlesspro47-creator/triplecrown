"""Shared configuration for the ML pipeline."""

from __future__ import annotations

import os
from pathlib import Path

# Repo-relative data dir (gitignored — parquet caches can be large).
SERVICE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = SERVICE_DIR / "data"
ARTIFACTS_DIR = SERVICE_DIR / "artifacts"
DATA_DIR.mkdir(parents=True, exist_ok=True)
ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)

# Seasons pulled for training. 2025 is held out for temporal validation.
# fit = TRAIN_SEASONS[:-1] (2022-2023), calibrate on TRAIN_SEASONS[-1] (2024),
# validate on VALID_SEASONS (2025).
TRAIN_SEASONS = [2022, 2023, 2024]
VALID_SEASONS = [2025]
ALL_SEASONS = TRAIN_SEASONS + VALID_SEASONS

# Regular-season-ish window per year (pybaseball returns only games that exist).
SEASON_START_MMDD = (3, 15)
SEASON_END_MMDD = (11, 5)

# Event classification (Statcast `events` column, populated on the last pitch of a PA).
HR_EVENTS = {"home_run"}
K_EVENTS = {"strikeout", "strikeout_double_play"}
BB_EVENTS = {"walk"}
# A plate appearance is any row where `events` is non-null.

# Batted-ball thresholds.
HARD_HIT_MIN_EV = 95.0  # mph, MLB's hard-hit definition
BARREL_LAUNCH_SPEED_ANGLE = 6  # Statcast launch_speed_angle bucket 6 == barrel

# Columns we retain from the raw pitch-level Statcast pull (PA-level rows).
PA_COLUMNS = [
    "game_date",
    "game_pk",
    "batter",
    "pitcher",
    "stand",
    "p_throws",
    "home_team",
    "away_team",
    "inning",
    "inning_topbot",
    "at_bat_number",
    "events",
    "type",
    "bb_type",
    "launch_speed",
    "launch_angle",
    "launch_speed_angle",
    "estimated_ba_using_speedangle",
    "estimated_woba_using_speedangle",
]


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return url
