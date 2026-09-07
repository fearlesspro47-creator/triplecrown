"""Push ML output rows to the production API's secured ingest endpoint.

Production runs no Python (Node-only deploy) and has its own separate database, so the
offline scorer (which writes to the DEV database) cannot reach prod directly. This reads
the rich per-hitter rows the scorer wrote (`hr_prediction_details`) for a date, joins them
to the NATURAL keys (players.mlb_id + games.mlb_game_pk) so the receiver can remap to its
own serial ids, and POSTs them in size-bounded chunks to POST {ML_INGEST_URL} with the
shared-secret header.

Env:
  DATABASE_URL     source DB to read from (the dev DB where the scorer wrote)
  ML_INGEST_URL    full ingest endpoint, e.g. https://<app>.replit.app/api/ml/ingest
  ML_INGEST_TOKEN  shared secret matching the server's ML_INGEST_TOKEN

Usage:
  uv run --extra ml python -m ml.push               # today (UTC)
  uv run --extra ml python -m ml.push --date 2026-07-02
  uv run --extra ml python -m ml.push --url http://localhost:80/api/ml/ingest  # local test
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import date, datetime
from zoneinfo import ZoneInfo
from decimal import Decimal

import psycopg
import requests
from psycopg.rows import dict_row

from .config import database_url

# Keep each request comfortably under Express's default 100kb json body limit.
MAX_CHUNK_BYTES = 80_000

SELECT_ROWS = """
    SELECT
        p.mlb_id        AS player_mlb_id,
        g.mlb_game_pk   AS game_mlb_pk,
        d.date          AS date,
        d.model_run_id  AS model_run_id,
        d.model_version AS model_version,
        d.hr_probability, d.crown_score, d.confidence_score, d.confidence_grade,
        d.ci_low, d.ci_high, d.data_completeness,
        d.feature_vector, d.shap_reasons, d.crown_components, d.weather_snapshot, d.value_edge
    FROM hr_prediction_details d
    JOIN players p ON p.id = d.player_id
    LEFT JOIN games g ON g.id = d.game_id
    WHERE d.date = %(date)s
      AND p.mlb_id IS NOT NULL
    ORDER BY d.crown_score DESC
"""


def _num(v) -> str | None:
    """Numeric columns come back as Decimal; the API stores them as strings."""
    if v is None:
        return None
    if isinstance(v, Decimal):
        return format(v, "f")
    return str(v)


def _payload_row(r: dict) -> dict:
    return {
        "playerMlbId": int(r["player_mlb_id"]),
        "gameMlbPk": int(r["game_mlb_pk"]) if r["game_mlb_pk"] is not None else None,
        "date": str(r["date"]),
        "modelRunId": str(r["model_run_id"]) if r["model_run_id"] is not None else None,
        "modelVersion": r["model_version"],
        "hrProbability": _num(r["hr_probability"]),
        "crownScore": _num(r["crown_score"]),
        "confidenceScore": _num(r["confidence_score"]),
        "confidenceGrade": r["confidence_grade"],
        "ciLow": _num(r["ci_low"]),
        "ciHigh": _num(r["ci_high"]),
        "dataCompleteness": _num(r["data_completeness"]),
        "featureVector": r["feature_vector"],
        "shapReasons": r["shap_reasons"],
        "crownComponents": r["crown_components"],
        "weatherSnapshot": r["weather_snapshot"],
        "valueEdge": _num(r["value_edge"]),
    }


def _chunks(rows: list[dict]):
    """Yield size-bounded batches so no single request exceeds the server body limit."""
    batch: list[dict] = []
    size = 2  # for the enclosing {"rows":[]}
    for row in rows:
        rb = len(json.dumps(row)) + 1
        if batch and size + rb > MAX_CHUNK_BYTES:
            yield batch
            batch, size = [], 2
        batch.append(row)
        size += rb
    if batch:
        yield batch


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", type=str, help="Target date YYYY-MM-DD (default: US Eastern today)")
    ap.add_argument("--url", type=str, help="Ingest endpoint URL (default: env ML_INGEST_URL)")
    args = ap.parse_args()

    # Match the app's US Eastern day boundary (see todayEastern in the api-server + serve.py) so
    # the pushed Crown Scores land on the same date the app reads for "today".
    target = date.fromisoformat(args.date) if args.date else datetime.now(ZoneInfo("America/New_York")).date()
    url = args.url or os.environ.get("ML_INGEST_URL")
    token = os.environ.get("ML_INGEST_TOKEN")
    if not url:
        raise SystemExit("ML_INGEST_URL not set (or pass --url)")
    if not token:
        raise SystemExit("ML_INGEST_TOKEN not set")

    with psycopg.connect(database_url(), row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(SELECT_ROWS, {"date": target})
            db_rows = cur.fetchall()

    if not db_rows:
        print(f"no hr_prediction_details rows for {target}; nothing to push")
        return 0

    rows = [_payload_row(r) for r in db_rows]
    headers = {"X-ML-Ingest-Token": token, "Content-Type": "application/json"}
    totals = {"received": 0, "upserted": 0, "skippedUnknownPlayer": 0, "skippedUnknownGame": 0}
    n_chunks = 0
    for batch in _chunks(rows):
        resp = requests.post(url, json={"rows": batch}, headers=headers, timeout=90)
        if resp.status_code != 200:
            raise SystemExit(f"ingest failed [{resp.status_code}]: {resp.text[:500]}")
        body = resp.json()
        for k in totals:
            totals[k] += int(body.get(k, 0))
        n_chunks += 1

    print(
        f"pushed {len(rows)} rows for {target} in {n_chunks} request(s) -> {url}\n"
        f"  upserted={totals['upserted']} "
        f"skippedUnknownPlayer={totals['skippedUnknownPlayer']} "
        f"skippedUnknownGame={totals['skippedUnknownGame']}"
    )
    if totals["skippedUnknownPlayer"]:
        print(
            "  NOTE: some players were unknown to the target DB (roster not yet synced there) "
            "and were skipped."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
