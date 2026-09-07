"""Postgres access for the ML serving layer (psycopg 3).

The Python ML service hands off to the Node/Express app strictly through Postgres:
it READS today's intended hitters + matchups + weather that the Node daily sync wrote,
and WRITES rich per-hitter ML output (Crown Score, confidence, SHAP reasons). The TS
side never imports Python — Postgres is the only contract.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

import psycopg

from .config import database_url


@contextmanager
def connect() -> Iterator[psycopg.Connection]:
    conn = psycopg.connect(database_url(), autocommit=False)
    try:
        yield conn
    finally:
        conn.close()
