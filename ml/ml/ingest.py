"""Pull real Statcast (via pybaseball) and reduce to PA-level parquet.

We pull pitch-level Statcast one month at a time, immediately reduce to one row
per plate appearance (rows where `events` is populated), and cache each month to
data/raw/pa_{year}_{mm}.parquet. This makes ingestion RESUMABLE: a run that is
interrupted (or hits a shell timeout) keeps every completed month, and re-running
skips cached months and only pulls what is missing. Once all months of a season
are cached, they are concatenated into data/pa_events_{year}.parquet.

Usage:
    uv run python -m ml.ingest --all          # resumable; run repeatedly until done
    uv run python -m ml.ingest --year 2024
    uv run python -m ml.ingest --start 2024-06-01 --end 2024-06-14 --out data/sample.parquet
"""

from __future__ import annotations

import argparse
import calendar
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date

import pandas as pd

from .config import ALL_SEASONS, DATA_DIR, PA_COLUMNS, SEASON_END_MMDD, SEASON_START_MMDD

warnings.filterwarnings("ignore")

RAW_DIR = DATA_DIR / "raw"
RAW_DIR.mkdir(parents=True, exist_ok=True)


def _month_windows(year: int) -> list[tuple[int, int, str, str]]:
    """(year, month, start, end) date strings covering the season window."""
    windows: list[tuple[int, int, str, str]] = []
    start_m, start_d = SEASON_START_MMDD
    end_m, end_d = SEASON_END_MMDD
    for month in range(start_m, end_m + 1):
        first = start_d if month == start_m else 1
        last = calendar.monthrange(year, month)[1]
        if month == end_m:
            last = min(last, end_d)
        s = date(year, month, first).isoformat()
        e = date(year, month, last).isoformat()
        windows.append((year, month, s, e))
    return windows


def _reduce_to_pa(df: pd.DataFrame) -> pd.DataFrame:
    """Keep one row per plate appearance with only the columns we need."""
    if df is None or len(df) == 0:
        return pd.DataFrame(columns=PA_COLUMNS)
    cols = [c for c in PA_COLUMNS if c in df.columns]
    out = df[cols].copy()
    out = out[out["events"].notna()]  # a PA ends where `events` is populated
    return out


def pull_window(start: str, end: str) -> pd.DataFrame:
    from pybaseball import statcast

    raw = statcast(start_dt=start, end_dt=end, verbose=False)
    return _reduce_to_pa(raw)


def _chunk_path(year: int, month: int):
    return RAW_DIR / f"pa_{year}_{month:02d}.parquet"


def _combine_year(year: int) -> None:
    """If every month chunk exists, concatenate into the season parquet."""
    windows = _month_windows(year)
    if not all(_chunk_path(y, m).exists() for y, m, _, _ in windows):
        return
    frames = [pd.read_parquet(_chunk_path(y, m)) for y, m, _, _ in windows]
    frames = [f for f in frames if len(f)]
    year_df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=PA_COLUMNS)
    out_path = DATA_DIR / f"pa_events_{year}.parquet"
    year_df.to_parquet(out_path, index=False)
    print(f"  -> {out_path.name} ({len(year_df)} rows)")


def ingest_seasons(years: list[int], workers: int) -> None:
    """Pull all missing month chunks across the requested years concurrently.

    Network-bound, so a small thread pool cuts wall time substantially. Each
    completed month is written immediately, so an interrupted run keeps progress.
    """
    all_windows: list[tuple[int, int, str, str]] = []
    for y in years:
        all_windows += _month_windows(y)
    missing = [w for w in all_windows if not _chunk_path(w[0], w[1]).exists()]
    cached = len(all_windows) - len(missing)
    print(f"months: {cached} cached, {len(missing)} to pull ({workers} workers)")

    if missing:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(pull_window, s, e): (y, m, s, e) for (y, m, s, e) in missing}
            for fut in as_completed(futs):
                y, m, s, e = futs[fut]
                try:
                    chunk = fut.result()
                    chunk.to_parquet(_chunk_path(y, m), index=False)
                    print(f"  {s}..{e}: {len(chunk)} PA rows", flush=True)
                except Exception as err:  # noqa: BLE001
                    print(f"  {s}..{e}: FAILED {err}", flush=True)

    for y in years:
        _combine_year(y)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, help="Ingest a single season year")
    ap.add_argument("--all", action="store_true", help="Ingest all configured seasons")
    ap.add_argument("--start", type=str, help="Ad hoc window start (YYYY-MM-DD)")
    ap.add_argument("--end", type=str, help="Ad hoc window end (YYYY-MM-DD)")
    ap.add_argument("--out", type=str, help="Output parquet path for ad hoc window")
    ap.add_argument("--workers", type=int, default=4, help="Concurrent month pulls")
    args = ap.parse_args()

    if args.start and args.end:
        print(f"pulling ad hoc window {args.start}..{args.end}")
        df = pull_window(args.start, args.end)
        print(f"  {len(df)} PA rows")
        if args.out:
            out_path = DATA_DIR / args.out if not args.out.startswith("/") else args.out
            df.to_parquet(out_path, index=False)
            print(f"  -> wrote {out_path}")
        return 0

    years = ALL_SEASONS if args.all else ([args.year] if args.year else [])
    if not years:
        ap.error("provide --year, --all, or --start/--end")
    ingest_seasons(years, args.workers)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
