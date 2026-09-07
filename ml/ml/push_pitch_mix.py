"""Push batter pitch-mix rows to the production API's secured ingest endpoint.

`batter_pitch_mix` is produced only by the offline Python job (`python -m ml.pitch_mix`)
against the DEV database. Production runs no Python and has its own separate database, so
(exactly like `ml.push` does for the ML Crown Scores) this reads the dev rows for a season,
joins them to the NATURAL key (players.mlb_id) so the receiver can remap to its own serial
ids, and POSTs them in size-bounded chunks to the pitch-mix ingest route with the
shared-secret header.

Env:
  DATABASE_URL     source DB to read from (the dev DB where the pitch-mix job wrote)
  ML_INGEST_URL    the Crown-Score ingest URL, e.g. https://<app>/api/ml/ingest — the
                   pitch-mix endpoint is derived from it (.../ingest -> .../ingest-pitch-mix)
  ML_INGEST_TOKEN  shared secret matching the server's ML_INGEST_TOKEN

Usage:
  uv run --extra ml python -m ml.push_pitch_mix                 # current season (UTC year)
  uv run --extra ml python -m ml.push_pitch_mix --season 2026
  uv run --extra ml python -m ml.push_pitch_mix --url http://localhost:80/api/ml/ingest-pitch-mix
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
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
        m.season        AS season,
        m.pitch_type, m.pitch_name, m.raw_pitch_types,
        m.pitches_seen, m.plate_appearances, m.at_bats, m.hits,
        m.singles, m.doubles, m.triples, m.home_runs, m.strikeouts, m.walks,
        m.pitch_usage, m.avg, m.slg, m.iso, m.k_rate, m.whiff_rate,
        m.barrel_rate, m.hard_hit_rate, m.avg_exit_velocity
    FROM batter_pitch_mix m
    JOIN players p ON p.id = m.player_id
    WHERE m.season = %(season)s
      AND p.mlb_id IS NOT NULL
    ORDER BY p.mlb_id, m.pitch_type
"""


def _num(v) -> str | None:
    """Numeric columns come back as Decimal; the API stores them as strings."""
    if v is None:
        return None
    if isinstance(v, Decimal):
        return format(v, "f")
    return str(v)


def _int(v) -> int:
    return int(v) if v is not None else 0


def _payload_row(r: dict) -> dict:
    return {
        "playerMlbId": int(r["player_mlb_id"]),
        "season": int(r["season"]),
        "pitchType": r["pitch_type"],
        "pitchName": r["pitch_name"],
        "rawPitchTypes": r["raw_pitch_types"],
        "pitchesSeen": _int(r["pitches_seen"]),
        "plateAppearances": _int(r["plate_appearances"]),
        "atBats": _int(r["at_bats"]),
        "hits": _int(r["hits"]),
        "singles": _int(r["singles"]),
        "doubles": _int(r["doubles"]),
        "triples": _int(r["triples"]),
        "homeRuns": _int(r["home_runs"]),
        "strikeouts": _int(r["strikeouts"]),
        "walks": _int(r["walks"]),
        "pitchUsage": _num(r["pitch_usage"]),
        "avg": _num(r["avg"]),
        "slg": _num(r["slg"]),
        "iso": _num(r["iso"]),
        "kRate": _num(r["k_rate"]),
        "whiffRate": _num(r["whiff_rate"]),
        "barrelRate": _num(r["barrel_rate"]),
        "hardHitRate": _num(r["hard_hit_rate"]),
        "avgExitVelocity": _num(r["avg_exit_velocity"]),
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


def _pitch_mix_url(explicit: str | None, base: str | None) -> str | None:
    """Resolve the pitch-mix endpoint. An explicit --url wins; otherwise derive it from the
    Crown-Score ML_INGEST_URL by swapping the trailing /ingest for /ingest-pitch-mix."""
    if explicit:
        return explicit
    if not base:
        return None
    if base.endswith("/ingest"):
        return base[: -len("/ingest")] + "/ingest-pitch-mix"
    return base.rstrip("/") + "/ingest-pitch-mix"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, help="Season year (default: UTC current year)")
    ap.add_argument("--url", type=str, help="Full pitch-mix ingest URL (default: derived from ML_INGEST_URL)")
    args = ap.parse_args()

    season = args.season or datetime.now(timezone.utc).year
    url = _pitch_mix_url(args.url, os.environ.get("ML_INGEST_URL"))
    token = os.environ.get("ML_INGEST_TOKEN")
    if not url:
        raise SystemExit("ML_INGEST_URL not set (or pass --url)")
    if not token:
        raise SystemExit("ML_INGEST_TOKEN not set")

    with psycopg.connect(database_url(), row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(SELECT_ROWS, {"season": season})
            db_rows = cur.fetchall()

    if not db_rows:
        print(f"no batter_pitch_mix rows for season {season}; nothing to push")
        return 0

    rows = [_payload_row(r) for r in db_rows]
    headers = {"X-ML-Ingest-Token": token, "Content-Type": "application/json"}
    totals = {"received": 0, "upserted": 0, "skippedUnknownPlayer": 0}
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
        f"pushed {len(rows)} rows for season {season} in {n_chunks} request(s) -> {url}\n"
        f"  upserted={totals['upserted']} "
        f"skippedUnknownPlayer={totals['skippedUnknownPlayer']}"
    )
    if totals["skippedUnknownPlayer"]:
        print(
            "  NOTE: some players were unknown to the target DB (roster not yet synced there) "
            "and were skipped."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
