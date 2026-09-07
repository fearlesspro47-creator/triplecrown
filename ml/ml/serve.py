"""Daily ML HR scorer.

Builds today's leakage-safe feature vectors for the exact hitter slate the Node daily
sync intends to show, scores the trained + calibrated XGBoost model, and writes rich
per-hitter output to Postgres:

  - HR Probability (calibrated, decimal 0-1)
  - Crown Score (0-100): 40% HR prob + 20% contact + 15% matchup + 10% weather
    + 10% ballpark + 5% recent form
  - Confidence grade (A+..D) from a Monte Carlo interval + data completeness + sample size
  - SHAP reasons (top +/- contributors mapped to human labels)

Train/serve PARITY is guaranteed by reusing the *identical* prior-window feature helpers
from features.py: we load the current-season PA data (through yesterday), append synthetic
"today" batter-game / pitcher-game rows (aggregates = 0, real context), run the same
add_batter_features / add_pitcher_features, then select the synthetic rows.

REAL data only: a hitter with no season data yet gets NaN features (XGBoost handles NaN
natively) and a low confidence grade — never a fabricated feature.

Usage:
    uv run python -m ml.serve                 # score server-today's slate
    uv run python -m ml.serve --date 2026-07-01
    uv run python -m ml.serve --skip-ingest   # reuse cached season parquet (dev/testing)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import date, datetime
from zoneinfo import ZoneInfo
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import psycopg
from psycopg.types.json import Jsonb

from . import db
from .config import ARTIFACTS_DIR, PA_COLUMNS
from .features import (
    BATTER_AGG_COLUMNS,
    FEATURE_COLUMNS,
    PITCHER_AGG_COLUMNS,
    add_batter_features,
    add_pitcher_features,
    batter_game_aggregates,
    pitcher_game_aggregates,
)
from .ingest import _chunk_path, _month_windows, pull_window

MODEL_VERSION = "ml-hr-v1"
TRAINED_THROUGH = "2024"  # last season the model learned from (fit 2022-23, calibrated 2024)
EXPECTED_PA = 4.0  # mirrors train.py; expected plate appearances per game

MODEL_PATH = ARTIFACTS_DIR / "hr_model.joblib"
SCHEMA_PATH = ARTIFACTS_DIR / "feature_schema.json"
METRICS_PATH = ARTIFACTS_DIR / "metrics.json"

# Human-readable labels for features (SHAP reasons + Crown breakdown).
FEATURE_LABELS: dict[str, str] = {
    "b_pa_std": "Season plate appearances",
    "b_hr_per_pa_std": "Season HR rate",
    "b_k_rate_std": "Strikeout rate",
    "b_bb_rate_std": "Walk rate",
    "b_iso_std": "Isolated power (ISO)",
    "b_barrel_rate_40": "Barrel rate (last 40 BBE)",
    "b_hardhit_rate_40": "Hard-hit rate (last 40 BBE)",
    "b_mean_ev_40": "Exit velocity (last 40 BBE)",
    "b_mean_la_40": "Launch angle (last 40 BBE)",
    "b_xwoba_con_40": "xwOBA on contact (last 40 BBE)",
    "b_recent_hr_15": "Recent HR form (last 15 G)",
    "p_bf_std": "Pitcher batters faced",
    "p_hr_per_bf_std": "Pitcher HR rate allowed",
    "p_k_per_bf_std": "Pitcher strikeout rate",
    "p_bb_per_bf_std": "Pitcher walk rate",
    "park_hr_factor": "Ballpark HR factor",
    "platoon_adv": "Platoon advantage",
}


# --------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------
def _sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _norm_hand(value) -> str | None:
    """Normalize a handedness/throws value to L / R / S (first letter, uppercased)."""
    if value is None:
        return None
    s = str(value).strip().upper()
    return s[0] if s else None


def _clip01(x: float) -> float:
    return float(min(1.0, max(0.0, x)))


def _finite(x) -> float | None:
    """Return a JSON-safe float, or None for NaN/inf/None."""
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


# --------------------------------------------------------------------------------------
# Season data (current season PA, through yesterday)
# --------------------------------------------------------------------------------------
def load_season_pa(season: int, through: date, skip_ingest: bool = False) -> pd.DataFrame:
    """Load current-season PA-level Statcast up to (and including) `through`.

    Prior completed months are served from cache; the in-progress month is re-pulled each
    run so yesterday's games are included. The caller filters to game_date < today, so
    features are always computed as of pre-first-pitch.
    """
    frames: list[pd.DataFrame] = []
    for (y, m, s, e) in _month_windows(season):
        if date.fromisoformat(s) > through:
            break  # future months of the season
        chunk = _chunk_path(y, m)
        is_current = m == through.month
        if not skip_ingest and (is_current or not chunk.exists()):
            end = min(e, through.isoformat())
            try:
                pull_window(s, end).to_parquet(chunk, index=False)
            except Exception as err:  # noqa: BLE001
                print(f"  season pull {s}..{end} FAILED: {err}", flush=True)
        if chunk.exists():
            frames.append(pd.read_parquet(chunk))

    if not frames:
        return pd.DataFrame(columns=PA_COLUMNS + ["season"])
    out = pd.concat(frames, ignore_index=True)
    out["game_date"] = pd.to_datetime(out["game_date"])
    out["season"] = out["game_date"].dt.year
    return out


# --------------------------------------------------------------------------------------
# Today's slate (read from Postgres — the Node sync is the source of the intended set)
# --------------------------------------------------------------------------------------
def load_slate(conn: psycopg.Connection, target: date) -> pd.DataFrame:
    """Read the exact hitter slate the Node sync intends for `target` + matchup context.

    The intended set = players with an 'hr' prediction for the date (lineup-driven upstream).
    Joins players for identity/handedness and games for the opposing starter + park, and
    weather for the HR-boost snapshot. Only active hitters with an mlb_id are returned.
    """
    sql = """
        SELECT
            pl.id                AS player_id,
            pl.mlb_id            AS batter_mlb_id,
            pl.name              AS player_name,
            pl.team_abbr         AS team_abbr,
            pl.handedness        AS stand,
            g.id                 AS game_id,
            g.mlb_game_pk        AS game_pk,
            g.home_team_abbr     AS home_abbr,
            g.away_team_abbr     AS away_abbr,
            g.home_pitcher_mlb_id AS home_pitcher_id,
            g.away_pitcher_mlb_id AS away_pitcher_id,
            g.home_pitcher_hand  AS home_pitcher_hand,
            g.away_pitcher_hand  AS away_pitcher_hand,
            w.temperature        AS wx_temp,
            w.wind_speed         AS wx_wind_speed,
            w.wind_direction     AS wx_wind_dir,
            w.condition          AS wx_condition,
            w.hr_boost_factor    AS wx_hr_boost
        FROM predictions p
        JOIN players pl ON pl.id = p.player_id
        JOIN games   g  ON g.id = p.game_id
        LEFT JOIN weather w ON w.game_id = g.id
        WHERE p.date = %s
          AND p.prediction_type = 'hr'
          AND pl.is_active = TRUE
          AND pl.mlb_id IS NOT NULL
    """
    with conn.cursor() as cur:
        cur.execute(sql, (target,))
        cols = [d.name for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    slate = pd.DataFrame(rows)
    if slate.empty:
        return slate

    # Resolve the opposing STARTER + park from the hitter's side.
    is_home = slate["team_abbr"] == slate["home_abbr"]
    slate["home_team"] = slate["home_abbr"]  # park (Statcast == DB abbr scheme)
    slate["starter_id"] = np.where(is_home, slate["away_pitcher_id"], slate["home_pitcher_id"])
    slate["starter_throws"] = np.where(
        is_home, slate["away_pitcher_hand"], slate["home_pitcher_hand"]
    )
    slate["stand"] = slate["stand"].map(_norm_hand)
    slate["starter_throws"] = slate["starter_throws"].map(_norm_hand)
    slate["batter_mlb_id"] = slate["batter_mlb_id"].astype("Int64")
    slate["starter_id"] = pd.to_numeric(slate["starter_id"], errors="coerce").astype("Int64")
    slate["game_pk"] = pd.to_numeric(slate["game_pk"], errors="coerce").astype("Int64")
    return slate


# --------------------------------------------------------------------------------------
# Feature assembly (synthetic "today" rows -> exact train parity)
# --------------------------------------------------------------------------------------
def _empty_batter_agg_row(r: pd.Series, season: int, game_date: pd.Timestamp) -> dict:
    row = {c: 0 for c in BATTER_AGG_COLUMNS}
    row.update(
        batter=int(r["batter_mlb_id"]),
        game_pk=int(r["game_pk"]),
        game_date=game_date,
        season=season,
        stand=r["stand"],
        starter_throws=r["starter_throws"],
        starter_id=int(r["starter_id"]) if pd.notna(r["starter_id"]) else -1,
        home_team=r["home_team"],
        away_team=r["away_abbr"],
        inning_topbot="Top" if r["team_abbr"] == r["away_abbr"] else "Bot",
    )
    return row


def _empty_pitcher_agg_row(pitcher_id: int, game_pk: int, season: int, game_date) -> dict:
    row = {c: 0 for c in PITCHER_AGG_COLUMNS}
    row.update(pitcher=int(pitcher_id), game_pk=int(game_pk), game_date=game_date, season=season)
    return row


def build_today_features(slate: pd.DataFrame, season_pa: pd.DataFrame, target: date) -> pd.DataFrame:
    """Return the slate with the 17 FEATURE_COLUMNS attached (train/serve parity)."""
    today_ts = pd.Timestamp(target)
    season = target.year

    # Only PA strictly before today -> features are "as of pre-first-pitch".
    prior = season_pa[season_pa["game_date"] < today_ts] if len(season_pa) else season_pa

    # ---- Batter features -------------------------------------------------------------
    bg_real = batter_game_aggregates(prior) if len(prior) else pd.DataFrame(columns=BATTER_AGG_COLUMNS)
    synth_b = pd.DataFrame(
        [_empty_batter_agg_row(r, season, today_ts) for _, r in slate.iterrows()]
    )
    bg_all = pd.concat([bg_real.reindex(columns=BATTER_AGG_COLUMNS), synth_b], ignore_index=True)
    bg_all = add_batter_features(bg_all)
    b_today = bg_all[(bg_all["game_pk"].isin(synth_b["game_pk"])) & (bg_all["game_date"] == today_ts)]
    b_today = b_today.drop_duplicates(subset=["batter", "game_pk"], keep="last")

    # ---- Pitcher features ------------------------------------------------------------
    pg_real = pitcher_game_aggregates(prior) if len(prior) else pd.DataFrame(columns=PITCHER_AGG_COLUMNS)
    starters = slate.dropna(subset=["starter_id"])[["starter_id", "game_pk"]].drop_duplicates()
    synth_p = pd.DataFrame(
        [
            _empty_pitcher_agg_row(int(s.starter_id), int(s.game_pk), season, today_ts)
            for s in starters.itertuples()
        ]
    )
    if len(synth_p):
        pg_all = pd.concat([pg_real.reindex(columns=PITCHER_AGG_COLUMNS), synth_p], ignore_index=True)
        pg_all = add_pitcher_features(pg_all)
        p_today = pg_all[(pg_all["game_pk"].isin(synth_p["game_pk"])) & (pg_all["game_date"] == today_ts)]
        p_today = p_today.drop_duplicates(subset=["pitcher", "game_pk"], keep="last")
    else:
        p_today = pd.DataFrame(columns=["pitcher", "game_pk", "p_bf_std", "p_hr_per_bf_std",
                                        "p_k_per_bf_std", "p_bb_per_bf_std"])

    # ---- Join batter + pitcher features onto the slate -------------------------------
    b_cols = ["batter", "game_pk"] + [c for c in FEATURE_COLUMNS if c.startswith("b_") or c in ("park_hr_factor", "platoon_adv")]
    out = slate.merge(
        b_today[b_cols], left_on=["batter_mlb_id", "game_pk"], right_on=["batter", "game_pk"], how="left"
    )
    p_cols = ["pitcher", "game_pk"] + [c for c in FEATURE_COLUMNS if c.startswith("p_")]
    out = out.merge(
        p_today[p_cols], left_on=["starter_id", "game_pk"], right_on=["pitcher", "game_pk"], how="left"
    )
    for c in FEATURE_COLUMNS:
        if c not in out.columns:
            out[c] = np.nan
    return out


# --------------------------------------------------------------------------------------
# Model + SHAP
# --------------------------------------------------------------------------------------
def _unwrap_xgb(model):
    """Drill through CalibratedClassifierCV / FrozenEstimator to the raw XGBClassifier.

    FrozenEstimator forwards attribute access to the wrapped estimator, so `hasattr(...,
    "get_booster")` is True even on the wrapper — TreeExplainer still rejects it by concrete
    type. Unwrap by class name until we reach the real XGBClassifier.
    """
    est = model.calibrated_classifiers_[0].estimator
    seen = 0
    while est is not None and type(est).__name__ != "XGBClassifier" and seen < 6:
        est = getattr(est, "estimator", None)
        seen += 1
    if est is None or type(est).__name__ != "XGBClassifier":
        raise RuntimeError("could not unwrap XGBClassifier from calibrated model for SHAP")
    return est


def shap_reasons(explainer, X_row: pd.DataFrame, feature_row: pd.Series, top_k: int = 5) -> list[dict]:
    """Top +/- SHAP contributors for one row, mapped to human labels."""
    vals = explainer.shap_values(X_row)
    vals = np.asarray(vals)
    if vals.ndim == 2:
        vals = vals[0]
    order = np.argsort(-np.abs(vals))[:top_k]
    reasons = []
    for i in order:
        feat = FEATURE_COLUMNS[i]
        contrib = float(vals[i])
        if not math.isfinite(contrib) or contrib == 0.0:
            continue
        reasons.append(
            {
                "feature": feat,
                "label": FEATURE_LABELS.get(feat, feat),
                "direction": "positive" if contrib > 0 else "negative",
                "impact": round(contrib, 4),
            }
        )
    return reasons


# --------------------------------------------------------------------------------------
# Monte Carlo confidence + Crown Score
# --------------------------------------------------------------------------------------
def monte_carlo_ci(p: float, batter_id: int, n: int = 3000) -> tuple[float, float]:
    """Interval on the game HR probability driven by plate-appearance uncertainty.

    Convert the calibrated game prob to a per-PA HR rate, then simulate a realistic PA
    count per game (lineup slot / extra innings uncertainty) and take the 10th/90th pct.
    """
    p = float(min(1 - 1e-6, max(1e-6, p)))
    q = 1 - (1 - p) ** (1 / EXPECTED_PA)  # per-PA HR probability
    rng = np.random.default_rng(int(batter_id) % (2**32))
    pa_choices = np.array([3, 4, 5, 6])
    pa_probs = np.array([0.15, 0.45, 0.30, 0.10])
    pas = rng.choice(pa_choices, size=n, p=pa_probs)
    game_probs = 1 - (1 - q) ** pas
    return float(np.percentile(game_probs, 10)), float(np.percentile(game_probs, 90))


def confidence(completeness: float, b_pa_std, ci_low: float, ci_high: float) -> tuple[float, str]:
    """Blend data completeness, sample size, and MC interval width into a grade."""
    sample = _clip01((float(b_pa_std) if b_pa_std and math.isfinite(float(b_pa_std)) else 0.0) / 200.0)
    width_factor = _clip01(1.0 - (ci_high - ci_low) / 0.15)
    score = 0.45 * completeness + 0.35 * sample + 0.20 * width_factor
    for threshold, grade in [
        (0.85, "A+"), (0.75, "A"), (0.65, "B+"),
        (0.55, "B"), (0.45, "C+"), (0.35, "C"),
    ]:
        if score >= threshold:
            return round(score, 4), grade
    return round(score, 4), "D"


def _component(key: str, label: str, weight: float, value01, available: bool) -> dict:
    return {
        "key": key,
        "label": label,
        "weight": weight,
        "value01": None if value01 is None else round(float(value01), 4),
        "available": available,
    }


def crown_score(p: float, f: pd.Series, wx_hr_boost) -> tuple[float, list[dict]]:
    """Composite 0-100 Crown Score + per-component breakdown.

    40% HR prob + 20% contact + 15% matchup + 10% weather + 10% ballpark + 5% recent form.
    Weights renormalize over the components that have real data.
    """
    comps: list[dict] = []

    # HR probability (always available).
    hr01 = _clip01((p - 0.03) / (0.22 - 0.03))
    comps.append(_component("hr_probability", "HR Probability", 0.40, hr01, True))

    # Contact quality (barrel / hard-hit / xwOBA-on-contact, last 40 BBE).
    parts = []
    barrel, hardhit, xwoba = f.get("b_barrel_rate_40"), f.get("b_hardhit_rate_40"), f.get("b_xwoba_con_40")
    if pd.notna(barrel):
        parts.append(_clip01(float(barrel) / 0.15))
    if pd.notna(hardhit):
        parts.append(_clip01((float(hardhit) - 0.25) / (0.55 - 0.25)))
    if pd.notna(xwoba):
        parts.append(_clip01((float(xwoba) - 0.25) / (0.55 - 0.25)))
    contact_avail = len(parts) > 0
    contact01 = float(np.mean(parts)) if contact_avail else 0.5
    comps.append(_component("contact", "Contact Quality", 0.20, contact01, contact_avail))

    # Matchup (opposing pitcher HR rate + platoon advantage).
    p_hr = f.get("p_hr_per_bf_std")
    platoon = f.get("platoon_adv")
    m_parts, m_avail = [], False
    if pd.notna(p_hr):
        m_parts.append((_clip01(float(p_hr) / 0.06), 0.7))
        m_avail = True
    if pd.notna(platoon):
        m_parts.append((float(platoon), 0.3))
        m_avail = True
    if m_parts:
        wsum = sum(w for _, w in m_parts)
        matchup01 = sum(v * w for v, w in m_parts) / wsum
    else:
        matchup01 = 0.5
    comps.append(_component("matchup", "Pitcher Matchup", 0.15, matchup01, m_avail))

    # Weather (HR-boost factor centered on 1.0, clamped 0.9-1.12).
    wx_avail = wx_hr_boost is not None and pd.notna(wx_hr_boost)
    weather01 = _clip01((float(wx_hr_boost) - 0.9) / (1.12 - 0.9)) if wx_avail else 0.5
    comps.append(_component("weather", "Weather", 0.10, weather01, wx_avail))

    # Ballpark (park HR factor).
    pf = f.get("park_hr_factor")
    park_avail = pd.notna(pf)
    park01 = _clip01((float(pf) - 0.92) / (1.15 - 0.92)) if park_avail else 0.5
    comps.append(_component("park", "Ballpark", 0.10, park01, park_avail))

    # Recent form (HR in last 15 games).
    rf = f.get("b_recent_hr_15")
    rf_avail = pd.notna(rf)
    form01 = _clip01(float(rf) / 5.0) if rf_avail else 0.5
    comps.append(_component("recent_form", "Recent Form", 0.05, form01, rf_avail))

    # Renormalize weights over available components, then award points.
    eff_total = sum(c["weight"] for c in comps if c["available"]) or 1.0
    total = 0.0
    for c in comps:
        eff = (c["weight"] / eff_total) if c["available"] else 0.0
        pts = (c["value01"] or 0.0) * eff * 100.0
        c["effectiveWeight"] = round(eff, 4)
        c["points"] = round(pts, 2)
        total += pts
    return round(total, 2), comps


# --------------------------------------------------------------------------------------
# DB writes
# --------------------------------------------------------------------------------------
def _start_run(conn: psycopg.Connection, target: date, artifact_hash, schema_hash) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ml_model_runs
                (model_version, scored_date, status, artifact_hash, feature_schema_hash,
                 trained_through, started_at)
            VALUES (%s, %s, 'running', %s, %s, %s, now())
            RETURNING id
            """,
            (MODEL_VERSION, target, artifact_hash, schema_hash, TRAINED_THROUGH),
        )
        run_id = cur.fetchone()[0]
    conn.commit()
    return str(run_id)


def _finish_run(conn, run_id, status, players_scored, games_scored, metrics, errors=None):
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE ml_model_runs
               SET status = %s, players_scored = %s, games_scored = %s, errors_count = %s,
                   metrics = %s, errors = %s, finished_at = now()
             WHERE id = %s
            """,
            (
                status,
                players_scored,
                games_scored,
                len(errors) if errors else 0,
                Jsonb(metrics) if metrics else None,
                Jsonb(errors) if errors else None,
                run_id,
            ),
        )
    conn.commit()


DETAIL_UPSERT = """
    INSERT INTO hr_prediction_details
        (player_id, game_id, date, model_run_id, model_version, hr_probability, crown_score,
         confidence_score, confidence_grade, ci_low, ci_high, data_completeness,
         feature_vector, shap_reasons, crown_components, weather_snapshot, value_edge)
    VALUES
        (%(player_id)s, %(game_id)s, %(date)s, %(model_run_id)s, %(model_version)s,
         %(hr_probability)s, %(crown_score)s, %(confidence_score)s, %(confidence_grade)s,
         %(ci_low)s, %(ci_high)s, %(data_completeness)s, %(feature_vector)s, %(shap_reasons)s,
         %(crown_components)s, %(weather_snapshot)s, %(value_edge)s)
    ON CONFLICT (player_id, date, model_version) DO UPDATE SET
        game_id = EXCLUDED.game_id,
        model_run_id = EXCLUDED.model_run_id,
        hr_probability = EXCLUDED.hr_probability,
        crown_score = EXCLUDED.crown_score,
        confidence_score = EXCLUDED.confidence_score,
        confidence_grade = EXCLUDED.confidence_grade,
        ci_low = EXCLUDED.ci_low,
        ci_high = EXCLUDED.ci_high,
        data_completeness = EXCLUDED.data_completeness,
        feature_vector = EXCLUDED.feature_vector,
        shap_reasons = EXCLUDED.shap_reasons,
        crown_components = EXCLUDED.crown_components,
        weather_snapshot = EXCLUDED.weather_snapshot,
        value_edge = EXCLUDED.value_edge
"""


# --------------------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------------------
def run(target: date, skip_ingest: bool = False) -> int:
    if not MODEL_PATH.exists():
        raise RuntimeError(f"model artifact not found: {MODEL_PATH} (train first)")
    model = joblib.load(MODEL_PATH)
    base_xgb = _unwrap_xgb(model)
    import shap

    explainer = shap.TreeExplainer(base_xgb)
    artifact_hash = _sha256(MODEL_PATH)
    schema_hash = _sha256(SCHEMA_PATH)

    with db.connect() as conn:
        slate = load_slate(conn, target)
        run_id = _start_run(conn, target, artifact_hash, schema_hash)
        if slate.empty:
            print(f"no hitter slate for {target}; nothing to score")
            _finish_run(conn, run_id, "success", 0, 0, {"note": "empty slate"})
            return 0

        print(f"slate: {len(slate)} hitters for {target}")
        games_scored = int(slate["game_id"].nunique())
        try:
            season_pa = load_season_pa(target.year, target, skip_ingest=skip_ingest)
        except Exception as err:  # noqa: BLE001
            _finish_run(conn, run_id, "failed", 0, games_scored, None, errors=[f"season load: {err}"])
            raise
        print(f"season PA rows loaded: {len(season_pa)}")
        feats = build_today_features(slate, season_pa, target)

        X = feats[FEATURE_COLUMNS].astype(float)
        probs = model.predict_proba(X)[:, 1]

        written, rows = 0, []
        for idx, (_, r) in enumerate(feats.iterrows()):
            p = float(probs[idx])
            frow = r[FEATURE_COLUMNS]
            completeness = float(frow.notna().sum()) / len(FEATURE_COLUMNS)
            ci_low, ci_high = monte_carlo_ci(p, int(r["batter_mlb_id"]))
            conf_score, conf_grade = confidence(completeness, r.get("b_pa_std"), ci_low, ci_high)
            cscore, comps = crown_score(p, frow, r.get("wx_hr_boost"))
            reasons = shap_reasons(explainer, X.iloc[[idx]], frow)

            feature_vector = {c: _finite(frow.get(c)) for c in FEATURE_COLUMNS}
            weather_snapshot = None
            if r.get("wx_hr_boost") is not None and pd.notna(r.get("wx_hr_boost")):
                weather_snapshot = {
                    "temperature": _finite(r.get("wx_temp")),
                    "windSpeed": _finite(r.get("wx_wind_speed")),
                    "windDirection": (None if pd.isna(r.get("wx_wind_dir")) else str(r.get("wx_wind_dir"))),
                    "condition": (None if pd.isna(r.get("wx_condition")) else str(r.get("wx_condition"))),
                    "hrBoostFactor": _finite(r.get("wx_hr_boost")),
                }

            rows.append(
                {
                    "player_id": int(r["player_id"]),
                    "game_id": int(r["game_id"]),
                    "date": target,
                    "model_run_id": run_id,
                    "model_version": MODEL_VERSION,
                    "hr_probability": round(p, 6),
                    "crown_score": cscore,
                    "confidence_score": conf_score,
                    "confidence_grade": conf_grade,
                    "ci_low": round(ci_low, 6),
                    "ci_high": round(ci_high, 6),
                    "data_completeness": round(completeness, 4),
                    "feature_vector": Jsonb(feature_vector),
                    "shap_reasons": Jsonb(reasons),
                    "crown_components": Jsonb(comps),
                    "weather_snapshot": Jsonb(weather_snapshot) if weather_snapshot else None,
                    "value_edge": None,  # requires real odds; hidden until wired
                }
            )

        with conn.cursor() as cur:
            cur.executemany(DETAIL_UPSERT, rows)
            written = len(rows)
        conn.commit()

        summary = {
            "hitters": len(slate),
            "written": written,
            "hr_prob_min": round(float(np.min(probs)), 4),
            "hr_prob_max": round(float(np.max(probs)), 4),
            "hr_prob_mean": round(float(np.mean(probs)), 4),
            "mean_completeness": round(float(np.mean([x["data_completeness"] for x in rows])), 4),
        }
        _finish_run(conn, run_id, "success", len(slate), games_scored, summary)
        print(f"wrote {written} predictions; summary={json.dumps(summary)}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", type=str, help="Target date YYYY-MM-DD (default: US Eastern today)")
    ap.add_argument("--skip-ingest", action="store_true", help="Reuse cached season parquet only")
    args = ap.parse_args()
    # MLB slates are anchored to the US date, and the app now serves the US Eastern day
    # (see todayEastern in the api-server) — default to Eastern so a post-8pm-ET run scores
    # tonight's slate, not tomorrow's.
    target = date.fromisoformat(args.date) if args.date else datetime.now(ZoneInfo("America/New_York")).date()
    try:
        return run(target, skip_ingest=args.skip_ingest)
    except Exception as err:  # noqa: BLE001
        print(f"scorer FAILED: {err}", flush=True)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
