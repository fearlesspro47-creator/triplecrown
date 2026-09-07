"""Batter pitch-mix aggregation job.

Pulls REAL pitch-by-pitch Statcast (Baseball Savant via pybaseball) for the current
season, one month at a time (resumable/cached like the ingest pipeline), and aggregates
each active hitter's performance split by the pitch FAMILY they saw:

  - usage% (share of pitches seen), AVG, SLG, ISO, K% (K per PA)
  - HR / 1B / 2B / 3B / hits / strikeouts / walks counts
  - whiff%, barrel%, hard-hit%, avg exit velocity (from real batted-ball data)

Writes one row per (player_id, season, pitch_family) to `batter_pitch_mix`. REAL data
only: a family with no batted balls surfaces NULL rates (UI shows "—"), never a
fabricated 0. Rates that are percentages are stored as 0-1 decimals (repo convention);
avg/slg/iso are ratio stats stored as-is.

The Node/Express app reads this table over Postgres — the TS side never imports Python.

Usage:
    uv run python -m ml.pitch_mix                 # current season, through today
    uv run python -m ml.pitch_mix --season 2026
    uv run python -m ml.pitch_mix --skip-ingest   # reuse cached month parquet (dev)
"""

from __future__ import annotations

import argparse
import warnings
from datetime import date, datetime, timezone

import pandas as pd
import psycopg

from . import db
from .config import DATA_DIR
from .ingest import _month_windows

warnings.filterwarnings("ignore")

PM_DIR = DATA_DIR / "pitchmix"
PM_DIR.mkdir(parents=True, exist_ok=True)

MIN_FAMILY_PITCHES = 15  # hide ultra-rare / misclassified pitch types from the board

# Pitch-level columns retained from the raw Statcast pull (kept small so month caches
# stay light — unlike the ML ingest we keep ALL pitches, not just PA-ending rows).
PM_COLUMNS = [
    "game_date",
    "batter",
    "pitch_type",
    "events",
    "description",
    "type",
    "launch_speed",
    "launch_speed_angle",
]

# Raw Statcast pitch_type code -> (family code, family label). Unknown/eephus -> Other.
FAMILY: dict[str, tuple[str, str]] = {
    "FF": ("FF", "Four-Seam"),
    "FA": ("FF", "Four-Seam"),
    "SI": ("SI", "Sinker"),
    "FT": ("SI", "Sinker"),
    "FC": ("FC", "Cutter"),
    "SL": ("SL", "Slider"),
    "ST": ("SL", "Slider"),
    "SV": ("SL", "Slider"),
    "CU": ("CU", "Curveball"),
    "KC": ("CU", "Curveball"),
    "CS": ("CU", "Curveball"),
    "SC": ("CU", "Curveball"),
    "CH": ("CH", "Changeup"),
    "FS": ("FS", "Splitter"),
    "FO": ("FS", "Splitter"),
    "KN": ("KN", "Knuckleball"),
    "EP": ("OT", "Other"),
}
FAMILY_ORDER = ["FF", "SI", "FC", "SL", "CU", "CH", "FS", "KN", "OT"]

# Event classification (Statcast `events`, populated on the last pitch of a PA).
HIT_EVENTS = {"single", "double", "triple", "home_run"}
K_EVENTS = {"strikeout", "strikeout_double_play"}
BB_EVENTS = {"walk", "intent_walk"}
# A plate appearance that is NOT an at-bat (walks, HBP, sacrifices, interference, aborted).
NON_AB_EVENTS = {
    "walk",
    "intent_walk",
    "hit_by_pitch",
    "sac_fly",
    "sac_bunt",
    "sac_fly_double_play",
    "sac_bunt_double_play",
    "catcher_interf",
    "truncated_pa",
}

# Swing / whiff classification (Statcast `description`).
SWING_DESC = {
    "swinging_strike",
    "swinging_strike_blocked",
    "foul",
    "foul_tip",
    "hit_into_play",
    "foul_bunt",
    "missed_bunt",
    "bunt_foul_tip",
}
WHIFF_DESC = {"swinging_strike", "swinging_strike_blocked", "missed_bunt"}


# --------------------------------------------------------------------------------------
# Statcast pull (pitch-level, cached per month)
# --------------------------------------------------------------------------------------
def pull_pitch_window(start: str, end: str) -> pd.DataFrame:
    from pybaseball import statcast

    raw = statcast(start_dt=start, end_dt=end, verbose=False)
    if raw is None or len(raw) == 0:
        return pd.DataFrame(columns=PM_COLUMNS)
    cols = [c for c in PM_COLUMNS if c in raw.columns]
    return raw[cols].copy()


def load_season_pitches(season: int, through: date, skip_ingest: bool = False) -> tuple[pd.DataFrame, bool]:
    """Load current-season pitch-level Statcast up to `through`.

    A month is only cached to `pm_{y}_{mm}.parquet` once it has FULLY elapsed (its last
    day <= `through`); that persistent file is then reused every run. The in-progress
    (current) month is re-pulled fresh into memory every run and never persisted — so a
    partial month can never be frozen into the cache and later mistaken for a complete
    month once the calendar advances (which would silently drop that month's late days).
    Returns (frame, complete) — complete is False if any month that should exist is missing
    or failed to pull, so the caller can withhold the freshness marker (retry next run).
    """
    frames: list[pd.DataFrame] = []
    complete = True
    for (y, m, s, e) in _month_windows(season):
        if date.fromisoformat(s) > through:
            break
        chunk = PM_DIR / f"pm_{y}_{m:02d}.parquet"
        month_ended = date.fromisoformat(e) <= through
        if month_ended:
            # Fully-elapsed month: pull the full window once, then serve from cache.
            if not skip_ingest and not chunk.exists():
                try:
                    pull_pitch_window(s, e).to_parquet(chunk, index=False)
                except Exception as err:  # noqa: BLE001
                    print(f"  pitch pull {s}..{e} FAILED: {err}", flush=True)
                    complete = False
            if chunk.exists():
                frames.append(pd.read_parquet(chunk))
            else:
                complete = False
        else:
            # In-progress month: always re-pull fresh, never persist a partial cache.
            if skip_ingest:
                continue
            if chunk.exists():
                chunk.unlink()  # drop any stale partial written by an older code version
            end = through.isoformat()
            try:
                frames.append(pull_pitch_window(s, end))
            except Exception as err:  # noqa: BLE001
                print(f"  pitch pull {s}..{end} FAILED: {err}", flush=True)
                complete = False

    if not frames:
        return pd.DataFrame(columns=PM_COLUMNS), complete
    out = pd.concat(frames, ignore_index=True)
    return out, complete


# --------------------------------------------------------------------------------------
# Aggregation
# --------------------------------------------------------------------------------------
def _round(x, nd) -> float | None:
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return round(f, nd) if f == f else None  # f==f filters NaN


def aggregate(pitches: pd.DataFrame, id_map: dict[int, int], season: int) -> list[dict]:
    """Aggregate pitch-level rows into per (player, family) stat dicts ready for upsert."""
    if pitches.empty:
        return []
    df = pitches.copy()
    df["batter"] = pd.to_numeric(df["batter"], errors="coerce").astype("Int64")
    df = df[df["batter"].isin(id_map.keys())]
    if df.empty:
        return []

    df["fam"] = df["pitch_type"].map(lambda c: FAMILY.get(c, ("OT", "Other"))[0])
    ev = df["events"]
    desc = df["description"]
    ls = pd.to_numeric(df["launch_speed"], errors="coerce")
    lsa = pd.to_numeric(df["launch_speed_angle"], errors="coerce")
    is_bip = df["type"].eq("X")

    df["_pa"] = ev.notna().astype(int)
    df["_ab"] = (ev.notna() & ~ev.isin(NON_AB_EVENTS)).astype(int)
    df["_1b"] = ev.eq("single").astype(int)
    df["_2b"] = ev.eq("double").astype(int)
    df["_3b"] = ev.eq("triple").astype(int)
    df["_hr"] = ev.eq("home_run").astype(int)
    df["_hit"] = ev.isin(HIT_EVENTS).astype(int)
    df["_k"] = ev.isin(K_EVENTS).astype(int)
    df["_bb"] = ev.isin(BB_EVENTS).astype(int)
    df["_swing"] = desc.isin(SWING_DESC).astype(int)
    df["_whiff"] = desc.isin(WHIFF_DESC).astype(int)
    df["_bip_ev"] = (is_bip & ls.notna()).astype(int)
    df["_ev_sum"] = (ls.where(is_bip & ls.notna())).fillna(0.0)
    df["_hardhit"] = (is_bip & ls.notna() & (ls >= 95.0)).astype(int)
    df["_barrel"] = (is_bip & (lsa == 6)).astype(int)

    total_by_batter = df.groupby("batter").size()

    grouped = df.groupby(["batter", "fam"]).agg(
        pitches_seen=("_pa", "size"),
        plate_appearances=("_pa", "sum"),
        at_bats=("_ab", "sum"),
        singles=("_1b", "sum"),
        doubles=("_2b", "sum"),
        triples=("_3b", "sum"),
        home_runs=("_hr", "sum"),
        hits=("_hit", "sum"),
        strikeouts=("_k", "sum"),
        walks=("_bb", "sum"),
        swings=("_swing", "sum"),
        whiffs=("_whiff", "sum"),
        bip_ev=("_bip_ev", "sum"),
        ev_sum=("_ev_sum", "sum"),
        hardhit=("_hardhit", "sum"),
        barrels=("_barrel", "sum"),
    )

    rows: list[dict] = []
    for (batter, fam), r in grouped.iterrows():
        fam = str(fam)
        pitches_seen = int(r["pitches_seen"])
        if fam == "OT" or pitches_seen < MIN_FAMILY_PITCHES:
            continue
        ab = int(r["at_bats"])
        hits = int(r["hits"])
        tb = int(r["singles"]) + 2 * int(r["doubles"]) + 3 * int(r["triples"]) + 4 * int(r["home_runs"])
        pa = int(r["plate_appearances"])
        swings = int(r["swings"])
        bip_ev = int(r["bip_ev"])
        barrel_bbe = int(r["bip_ev"])  # barrel% denominator = batted balls with tracked EV
        avg = hits / ab if ab > 0 else None
        slg = tb / ab if ab > 0 else None
        iso = (slg - avg) if (avg is not None and slg is not None) else None
        total = int(total_by_batter.get(batter, 0)) or 1
        rows.append(
            {
                "player_id": id_map[int(batter)],
                "season": season,
                "pitch_type": fam,
                "pitch_name": _fam_name(fam),
                "raw_pitch_types": _raw_codes(fam),
                "pitches_seen": pitches_seen,
                "plate_appearances": pa,
                "at_bats": ab,
                "hits": hits,
                "singles": int(r["singles"]),
                "doubles": int(r["doubles"]),
                "triples": int(r["triples"]),
                "home_runs": int(r["home_runs"]),
                "strikeouts": int(r["strikeouts"]),
                "walks": int(r["walks"]),
                "pitch_usage": _round(pitches_seen / total, 4),
                "avg": _round(avg, 3),
                "slg": _round(slg, 3),
                "iso": _round(iso, 3),
                "k_rate": _round(int(r["strikeouts"]) / pa, 4) if pa > 0 else None,
                "whiff_rate": _round(int(r["whiffs"]) / swings, 4) if swings > 0 else None,
                "barrel_rate": _round(int(r["barrels"]) / barrel_bbe, 4) if barrel_bbe > 0 else None,
                "hard_hit_rate": _round(int(r["hardhit"]) / bip_ev, 4) if bip_ev > 0 else None,
                "avg_exit_velocity": _round(r["ev_sum"] / bip_ev, 2) if bip_ev > 0 else None,
            }
        )
    return rows


def _fam_name(fam: str) -> str:
    for code, name in FAMILY.values():
        if code == fam:
            return name
    return fam


def _raw_codes(fam: str) -> str:
    return ",".join(sorted(k for k, v in FAMILY.items() if v[0] == fam))


# --------------------------------------------------------------------------------------
# DB
# --------------------------------------------------------------------------------------
def load_active_hitters(conn: psycopg.Connection) -> dict[int, int]:
    """mlb_id -> player_id for every active hitter with an mlb_id."""
    with conn.cursor() as cur:
        cur.execute("SELECT id, mlb_id FROM players WHERE is_active = TRUE AND mlb_id IS NOT NULL")
        return {int(mlb_id): int(pid) for (pid, mlb_id) in cur.fetchall()}


UPSERT_COLS = [
    "player_id", "season", "pitch_type", "pitch_name", "raw_pitch_types",
    "pitches_seen", "plate_appearances", "at_bats", "hits", "singles", "doubles",
    "triples", "home_runs", "strikeouts", "walks", "pitch_usage", "avg", "slg",
    "iso", "k_rate", "whiff_rate", "barrel_rate", "hard_hit_rate", "avg_exit_velocity",
]


def write_rows(conn: psycopg.Connection, rows: list[dict], season: int) -> int:
    """Replace each processed player's season rows atomically (delete-then-insert).

    Players with no computed rows this run are left untouched, so a partial pull never
    nulls out previously-good data (real-or-nothing).
    """
    if not rows:
        return 0
    processed = sorted({r["player_id"] for r in rows})
    placeholders = ", ".join(f"%({c})s" for c in UPSERT_COLS)
    collist = ", ".join(UPSERT_COLS)
    insert_sql = f"INSERT INTO batter_pitch_mix ({collist}) VALUES ({placeholders})"
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM batter_pitch_mix WHERE season = %s AND player_id = ANY(%s)",
            (season, processed),
        )
        cur.executemany(insert_sql, rows)
    conn.commit()
    return len(rows)


def write_freshness(conn: psycopg.Connection) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO app_meta (key, value, updated_at) VALUES ('pitch_mix_last_sync', %s, now())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
            """,
            (now,),
        )
    conn.commit()


# --------------------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------------------
def run(season: int, through: date, skip_ingest: bool = False) -> int:
    with db.connect() as conn:
        id_map = load_active_hitters(conn)
        print(f"active hitters: {len(id_map)}", flush=True)
        pitches, complete = load_season_pitches(season, through, skip_ingest=skip_ingest)
        print(f"pitch rows loaded: {len(pitches)} (complete={complete})", flush=True)
        rows = aggregate(pitches, id_map, season)
        players = len({r["player_id"] for r in rows})
        written = write_rows(conn, rows, season)
        print(f"pitch-mix rows written: {written} across {players} hitters", flush=True)
        if complete and written:
            write_freshness(conn)
            print("wrote app_meta.pitch_mix_last_sync", flush=True)
        else:
            print("partial run — freshness marker withheld", flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, help="Season year (default: today's year)")
    ap.add_argument("--through", type=str, help="Aggregate through this date (YYYY-MM-DD)")
    ap.add_argument("--skip-ingest", action="store_true", help="Reuse cached month parquet")
    args = ap.parse_args()

    through = date.fromisoformat(args.through) if args.through else date.today()
    season = args.season or through.year
    return run(season, through, skip_ingest=args.skip_ingest)


if __name__ == "__main__":
    raise SystemExit(main())
