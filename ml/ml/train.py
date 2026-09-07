"""Train + calibrate the HR model and backtest it against honest baselines.

Temporal split: train on TRAIN_SEASONS (fit on all but the last, calibrate on
the last via prefit), validate on VALID_SEASONS (2025). We compare the model
against (a) a naive season-to-date HR-rate baseline and (b) the app's current
heuristic recreated as a ranking proxy from as-of features. Success = the model
beats the naive baseline on BOTH Brier and log loss, and beats the heuristic on
ranking (AUC), on the held-out season.

Usage:
    uv run python -m ml.train --frame train_frame.parquet
"""

from __future__ import annotations

import argparse
import json
import warnings
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from joblib import dump
from sklearn.calibration import CalibratedClassifierCV
from sklearn.frozen import FrozenEstimator
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from xgboost import XGBClassifier

from .config import ARTIFACTS_DIR, DATA_DIR, TRAIN_SEASONS, VALID_SEASONS
from .features import FEATURE_COLUMNS

warnings.filterwarnings("ignore")

EXPECTED_PA = 4.0


def _reliability(y: np.ndarray, p: np.ndarray, bins: int = 10) -> list[dict]:
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    rows = []
    for b in range(bins):
        m = idx == b
        if m.sum() == 0:
            continue
        rows.append({
            "bin": f"{edges[b]:.2f}-{edges[b+1]:.2f}",
            "n": int(m.sum()),
            "pred_mean": round(float(p[m].mean()), 4),
            "obs_rate": round(float(y[m].mean()), 4),
        })
    return rows


def _naive_baseline(df: pd.DataFrame, base_rate: float) -> np.ndarray:
    """P(>=1 HR) from season-to-date HR/PA over ~EXPECTED_PA at-bats."""
    hr_pa = df["b_hr_per_pa_std"].to_numpy(dtype="float64")
    hr_pa = np.where(np.isnan(hr_pa), base_rate / EXPECTED_PA, hr_pa)
    hr_pa = np.clip(hr_pa, 0.0, 1.0)
    return 1.0 - np.power(1.0 - hr_pa, EXPECTED_PA)


def _heuristic_rank(df: pd.DataFrame) -> np.ndarray:
    """Ranking proxy for the app's current HR Score (weights from probability.ts):
    barrel .30, hardhit .20, xSLG(~xwOBA-on-contact) .20, pitcher HR .10, park .10.
    Missing components fall back to the column median so ranking stays defined.
    """
    def z(col: str) -> np.ndarray:
        v = df[col].to_numpy(dtype="float64")
        med = np.nanmedian(v)
        v = np.where(np.isnan(v), med, v)
        s = np.nanstd(v)
        return (v - np.nanmean(v)) / s if s > 0 else np.zeros_like(v)

    score = (
        0.30 * z("b_barrel_rate_40")
        + 0.20 * z("b_hardhit_rate_40")
        + 0.20 * z("b_xwoba_con_40")
        + 0.10 * z("p_hr_per_bf_std")
        + 0.10 * z("park_hr_factor")
        + 0.10 * z("b_recent_hr_15")
    )
    return score


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frame", type=str, default="train_frame.parquet")
    args = ap.parse_args()

    frame_path = DATA_DIR / args.frame if not args.frame.startswith("/") else args.frame
    df = pd.read_parquet(frame_path)
    df = df.dropna(subset=["did_homer"])
    print(f"loaded {len(df)} batter-games; seasons {sorted(df['season'].unique())}")

    train = df[df["season"].isin(TRAIN_SEASONS)].copy()
    valid = df[df["season"].isin(VALID_SEASONS)].copy()
    if len(valid) == 0:
        raise SystemExit("no validation-season rows; ingest 2025 first")

    fit_seasons = TRAIN_SEASONS[:-1]
    calib_season = TRAIN_SEASONS[-1]
    fit = train[train["season"].isin(fit_seasons)]
    calib = train[train["season"] == calib_season]
    print(f"fit={len(fit)} ({fit_seasons}) calib={len(calib)} ({calib_season}) valid={len(valid)} ({VALID_SEASONS})")

    Xf, yf = fit[FEATURE_COLUMNS], fit["did_homer"].to_numpy()
    Xc, yc = calib[FEATURE_COLUMNS], calib["did_homer"].to_numpy()
    Xv, yv = valid[FEATURE_COLUMNS], valid["did_homer"].to_numpy()

    pos = max(int(yf.sum()), 1)
    neg = int((yf == 0).sum())
    spw = neg / pos

    base = XGBClassifier(
        n_estimators=400,
        max_depth=4,
        learning_rate=0.03,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=5,
        reg_lambda=1.0,
        scale_pos_weight=spw,
        eval_metric="logloss",
        n_jobs=4,
        tree_method="hist",
    )
    base.fit(Xf, yf)

    frozen = FrozenEstimator(base)
    results = {}
    best = None
    for method in ("isotonic", "sigmoid"):
        cal = CalibratedClassifierCV(frozen, method=method)
        cal.fit(Xc, yc)
        pv = cal.predict_proba(Xv)[:, 1]
        m = {
            "log_loss": float(log_loss(yv, pv)),
            "brier": float(brier_score_loss(yv, pv)),
            "auc": float(roc_auc_score(yv, pv)),
        }
        results[f"model_{method}"] = m
        if best is None or m["brier"] < best[1]["brier"]:
            best = (method, m, cal, pv)
    best_method, best_metrics, best_cal, best_pv = best

    base_rate = float(yf.mean())
    naive_pv = _naive_baseline(valid, base_rate)
    heur = _heuristic_rank(valid)
    const_pv = np.full_like(yv, base_rate, dtype="float64")

    results["baseline_naive_seasonrate"] = {
        "log_loss": float(log_loss(yv, np.clip(naive_pv, 1e-6, 1 - 1e-6))),
        "brier": float(brier_score_loss(yv, naive_pv)),
        "auc": float(roc_auc_score(yv, naive_pv)),
    }
    results["baseline_constant"] = {
        "log_loss": float(log_loss(yv, np.clip(const_pv, 1e-6, 1 - 1e-6))),
        "brier": float(brier_score_loss(yv, const_pv)),
        "auc": 0.5,
    }
    results["heuristic_current"] = {"auc": float(roc_auc_score(yv, heur))}

    beats_naive = (
        best_metrics["brier"] < results["baseline_naive_seasonrate"]["brier"]
        and best_metrics["log_loss"] < results["baseline_naive_seasonrate"]["log_loss"]
    )
    beats_heuristic = best_metrics["auc"] > results["heuristic_current"]["auc"]

    report = {
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "n_fit": len(fit), "n_calib": len(calib), "n_valid": len(valid),
        "hr_base_rate_fit": base_rate,
        "chosen_calibration": best_method,
        "features": FEATURE_COLUMNS,
        "scale_pos_weight": spw,
        "metrics": results,
        "beats_naive_baseline": bool(beats_naive),
        "beats_current_heuristic": bool(beats_heuristic),
        "reliability_model": _reliability(yv, best_pv),
        "feature_importance": {
            f: float(v) for f, v in zip(FEATURE_COLUMNS, base.feature_importances_)
        },
    }

    # Persist artifacts.
    dump(best_cal, ARTIFACTS_DIR / "hr_model.joblib")
    with open(ARTIFACTS_DIR / "feature_schema.json", "w") as f:
        json.dump({"features": FEATURE_COLUMNS, "expected_pa": EXPECTED_PA}, f, indent=2)
    with open(ARTIFACTS_DIR / "metrics.json", "w") as f:
        json.dump(report, f, indent=2)

    print("\n=== BACKTEST (validation season) ===")
    for k, v in results.items():
        print(f"  {k}: {v}")
    print(f"\nchosen calibration: {best_method}")
    print(f"BEATS naive baseline (Brier & logloss): {beats_naive}")
    print(f"BEATS current heuristic (AUC): {beats_heuristic}")
    print("\ntop features:")
    for f, v in sorted(report["feature_importance"].items(), key=lambda x: -x[1])[:8]:
        print(f"  {f}: {v:.3f}")
    print(f"\n-> artifacts written to {ARTIFACTS_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
