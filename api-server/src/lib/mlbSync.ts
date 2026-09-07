import { db, playersTable, gameLogsTable, appMetaTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "./logger";
import { syncDailySchedule } from "./mlbScheduleSync";
import { syncStatcast } from "./statcastSync";
import { syncPitcherArsenal } from "./pitcherArsenalSync";
import { syncRosters } from "./rosterSync";
import { syncNearMisses } from "./nearMissSync";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const LAST_SYNC_KEY = "mlb_last_sync";
// How many most-recent games we keep per player (covers the 30-day window with headroom).
const MAX_GAMES_PER_PLAYER = 40;

interface MlbSplitStat {
  hits?: number;
  atBats?: number;
  homeRuns?: number;
  rbi?: number;
}
interface MlbSplit {
  date?: string;
  opponent?: { abbreviation?: string; name?: string };
  stat?: MlbSplitStat;
}

function currentSeason(): number {
  return new Date().getUTCFullYear();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchGameLog(mlbId: number, season: number, attempts = 3): Promise<MlbSplit[]> {
  const url = `${MLB_API}/people/${mlbId}/stats?stats=gameLog&group=hitting&season=${season}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) {
        throw new Error(`MLB API ${res.status} for player ${mlbId}`);
      }
      const json = (await res.json()) as {
        stats?: Array<{ splits?: MlbSplit[] }>;
      };
      return json.stats?.[0]?.splits ?? [];
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(attempt * 750);
    }
  }
  throw lastErr;
}

// The real season hitting line from the MLB Stats API. Rate stats (avg/obp/slg/ops)
// come back as strings like ".248"; counting stats are numbers.
interface MlbSeasonStat {
  homeRuns?: number;
  rbi?: number;
  avg?: string;
  obp?: string;
  slg?: string;
  ops?: string;
  atBats?: number;
  hits?: number;
  doubles?: number;
  triples?: number;
  plateAppearances?: number;
  strikeOuts?: number;
  baseOnBalls?: number;
  stolenBases?: number;
  caughtStealing?: number;
  gamesPlayed?: number;
}

async function fetchSeasonStats(
  mlbId: number,
  season: number,
  attempts = 3,
): Promise<MlbSeasonStat | null> {
  const url = `${MLB_API}/people/${mlbId}/stats?stats=season&group=hitting&season=${season}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) {
        throw new Error(`MLB API ${res.status} for season stats ${mlbId}`);
      }
      const json = (await res.json()) as {
        stats?: Array<{ splits?: Array<{ stat?: MlbSeasonStat }> }>;
      };
      return json.stats?.[0]?.splits?.[0]?.stat ?? null;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(attempt * 750);
    }
  }
  throw lastErr;
}

// MLB returns rate stats as strings like ".248" (or ".---" when undefined). Normalize
// to a 3-decimal numeric string for the DB, or null when it isn't a real value.
function parseRate(v: string | undefined): string | null {
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n.toFixed(3) : null;
}

function ratio(numerator: number | undefined, denominator: number): string | null {
  if (numerator == null || denominator <= 0) return null;
  return (numerator / denominator).toFixed(3);
}

// Run a batch of async tasks with bounded concurrency to be polite to the API.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface SyncResult {
  playersSynced: number;
  gamesUpserted: number;
  errors: number;
  statsUpdated?: number;
  statErrors?: number;
  skipped?: boolean;
}

let syncInProgress = false;

// Fetch each mapped player's recent game log from the MLB Stats API and upsert
// the most recent games into game_logs. Idempotent via the (player_id, game_date) unique key.
// Guarded so a manual trigger and the scheduler can't run overlapping syncs on one instance.
export async function syncMlbGameLogs(): Promise<SyncResult> {
  if (syncInProgress) {
    logger.info("MLB sync already in progress, skipping duplicate run");
    return { playersSynced: 0, gamesUpserted: 0, errors: 0, skipped: true };
  }
  syncInProgress = true;
  try {
    return await runSync();
  } finally {
    syncInProgress = false;
  }
}

async function runSync(): Promise<SyncResult> {
  const season = currentSeason();
  const players = await db
    .select({ id: playersTable.id, mlbId: playersTable.mlbId, name: playersTable.name })
    .from(playersTable)
    .where(and(eq(playersTable.isActive, true), sql`${playersTable.mlbId} IS NOT NULL`));

  let gamesUpserted = 0;
  let errors = 0;
  let playersSynced = 0;
  let statsUpdated = 0;
  let statErrors = 0;

  await mapWithConcurrency(players, 3, async (player) => {
    if (player.mlbId == null) return;
    try {
      let splits = await fetchGameLog(player.mlbId, season);
      // Fall back to the previous season if the current one has no games yet.
      if (splits.length === 0) {
        splits = await fetchGameLog(player.mlbId, season - 1);
      }
      // Merge same-date splits (doubleheaders) into one calendar-game-day row. The
      // (player_id, game_date) unique key can't hold two rows for the same date, and a
      // single batch upsert can't touch the same conflict target twice, so we combine them.
      const byDate = new Map<
        string,
        { hits: number; atBats: number; homeRuns: number; rbi: number; opponentAbbr: string | null }
      >();
      for (const s of splits) {
        if (!s.date) continue;
        const cur = byDate.get(s.date) ?? {
          hits: 0,
          atBats: 0,
          homeRuns: 0,
          rbi: 0,
          opponentAbbr: null as string | null,
        };
        cur.hits += s.stat?.hits ?? 0;
        cur.atBats += s.stat?.atBats ?? 0;
        cur.homeRuns += s.stat?.homeRuns ?? 0;
        cur.rbi += s.stat?.rbi ?? 0;
        cur.opponentAbbr = cur.opponentAbbr ?? s.opponent?.abbreviation ?? null;
        byDate.set(s.date, cur);
      }
      // Keep the most recent N game days.
      const recentDates = [...byDate.keys()].sort().slice(-MAX_GAMES_PER_PLAYER);
      if (recentDates.length === 0) return;

      const rows = recentDates.map((date) => {
        const d = byDate.get(date)!;
        return {
          playerId: player.id,
          gameDate: date,
          hits: d.hits,
          atBats: d.atBats,
          homeRuns: d.homeRuns,
          rbi: d.rbi,
          opponentAbbr: d.opponentAbbr,
          hadHit: d.hits >= 1,
        };
      });

      await db
        .insert(gameLogsTable)
        .values(rows)
        .onConflictDoUpdate({
          target: [gameLogsTable.playerId, gameLogsTable.gameDate],
          set: {
            hits: sql`excluded.hits`,
            atBats: sql`excluded.at_bats`,
            homeRuns: sql`excluded.home_runs`,
            rbi: sql`excluded.rbi`,
            opponentAbbr: sql`excluded.opponent_abbr`,
            hadHit: sql`excluded.had_hit`,
            updatedAt: new Date(),
          },
        });

      gamesUpserted += rows.length;
      playersSynced += 1;
    } catch (err) {
      errors += 1;
      logger.warn({ err, player: player.name }, "MLB game log sync failed for player");
    }

    // Refresh the player's real current-season line (HR, AVG, OBP, SLG, OPS, RBI, rates)
    // from the MLB Stats API so the players table reflects this season instead of stale
    // seed values. Kept in its own try/catch — a stat fetch failure must never fail the
    // game-log sync or mark data stale (same "never fail the whole sync" rule as BvP).
    try {
      let stat = await fetchSeasonStats(player.mlbId, season);
      // Fall back to the previous season if the current one has no plate appearances yet.
      if (!stat || (stat.plateAppearances ?? 0) === 0) {
        stat = await fetchSeasonStats(player.mlbId, season - 1);
      }
      if (stat) {
        const ab = stat.atBats ?? 0;
        const pa = stat.plateAppearances ?? 0;
        await db
          .update(playersTable)
          .set({
            homeRuns: stat.homeRuns ?? null,
            atBats: stat.atBats ?? null,
            hits: stat.hits ?? null,
            doubles: stat.doubles ?? null,
            triples: stat.triples ?? null,
            rbi: stat.rbi ?? null,
            stolenBases: stat.stolenBases ?? null,
            caughtStealing: stat.caughtStealing ?? null,
            gamesPlayed: stat.gamesPlayed ?? null,
            battingAvg: parseRate(stat.avg),
            obp: parseRate(stat.obp),
            slg: parseRate(stat.slg),
            ops: parseRate(stat.ops),
            strikeoutRate: ratio(stat.strikeOuts, pa),
            walkRate: ratio(stat.baseOnBalls, pa),
            hrRate: ratio(stat.homeRuns, ab),
            updatedAt: new Date(),
          })
          .where(eq(playersTable.id, player.id));
        statsUpdated += 1;
      }
    } catch (err) {
      statErrors += 1;
      logger.warn({ err, player: player.name }, "MLB season stats sync failed for player");
    }
  });

  // Mark data fresh when the run mostly succeeded. Across ~400 hitters a couple of transient
  // per-player MLB API failures are expected, and failures preserve each player's prior logs
  // (the upsert only touches players that fetched), so gating on errors===0 would leave the
  // marker perpetually stale and re-run the whole sync every boot. Tolerate up to a 5% error
  // rate; above that, leave it stale so the scheduler retries instead of masquerading old data.
  const errorRate = players.length > 0 ? errors / players.length : 0;
  if (errorRate <= 0.05) {
    const now = new Date().toISOString();
    await db
      .insert(appMetaTable)
      .values({ key: LAST_SYNC_KEY, value: now })
      .onConflictDoUpdate({
        target: appMetaTable.key,
        set: { value: now, updatedAt: new Date() },
      });
  } else {
    logger.warn(
      { errors, errorRate, total: players.length },
      "MLB sync error rate above threshold; leaving last-sync marker stale to force a retry",
    );
  }

  if (statErrors > 0) {
    logger.warn({ statErrors, statsUpdated }, "Some player season-stat refreshes failed");
  }

  logger.info(
    { playersSynced, gamesUpserted, statsUpdated, statErrors, errors, season },
    "MLB game log sync complete",
  );
  return { playersSynced, gamesUpserted, statsUpdated, statErrors, errors };
}

export async function getLastSyncTime(): Promise<Date | null> {
  const [row] = await db
    .select()
    .from(appMetaTable)
    .where(eq(appMetaTable.key, LAST_SYNC_KEY))
    .limit(1);
  return row ? new Date(row.value) : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 20 * 60 * 60 * 1000; // consider data stale after 20h

// Sync on startup if we've never synced or data is stale, then schedule a daily refresh.
export function startMlbSyncScheduler(): void {
  const runIfNeeded = async () => {
    try {
      const last = await getLastSyncTime();
      const age = last ? Date.now() - last.getTime() : Infinity;
      if (age >= STALE_MS) {
        logger.info({ lastSync: last?.toISOString() ?? null }, "Running MLB game log sync");
        await syncMlbGameLogs();
      } else {
        logger.info({ lastSync: last?.toISOString() }, "MLB game logs fresh, skipping sync");
      }
    } catch (err) {
      logger.error({ err }, "MLB sync scheduler run failed");
    }
  };

  // Populate/refresh the full active-roster player set (all 30 clubs) and deactivate anyone
  // no longer on an active roster (injured/IL/optioned). Everything else depends on this set,
  // so it runs first. Idempotent upserts, non-fatal.
  const runRoster = async () => {
    try {
      await syncRosters();
    } catch (err) {
      logger.error({ err }, "Roster sync scheduler run failed");
    }
  };

  // Real Baseball Savant Statcast + advanced metrics (ISO / BABIP / wRC+ est.), then today's
  // real MLB schedule + per-player daily predictions. Statcast MUST run before the schedule
  // sync because the HR Score computed there consumes fresh Statcast quality-of-contact.
  // Idempotent upserts, so we run on every boot and once a day thereafter.
  const runStatcastThenSchedule = async () => {
    try {
      await syncStatcast();
    } catch (err) {
      logger.error({ err }, "Statcast sync scheduler run failed");
    }
    // Probable starters' real pitch-usage arsenals (Baseball Savant). Feeds the "why the model
    // likes this matchup" insight (pitcher usage × hitter SLG-by-pitch). Season-level like
    // Statcast, non-fatal, so it rides the same 24h + boot cadence.
    try {
      await syncPitcherArsenal();
    } catch (err) {
      logger.error({ err }, "Pitcher arsenal sync scheduler run failed");
    }
    try {
      await syncDailySchedule();
    } catch (err) {
      logger.error({ err }, "Daily schedule sync scheduler run failed");
    }
  };

  // Yesterday's HR "near misses" (hardest-hit balls that stayed in the park). Independent of
  // the roster/statcast/schedule chain — keyed off the most recent finished slate — so it runs
  // in the background on boot and once daily. Real-or-nothing: leaves prior rows on a bad fetch.
  const runNearMisses = async () => {
    try {
      await syncNearMisses();
    } catch (err) {
      logger.error({ err }, "Near-miss sync scheduler run failed");
    }
  };

  // Boot order: roster first (defines the active player set), then Statcast + schedule +
  // predictions, then game logs in the background. First-boot predictions use fallback season
  // stats; waiting for the full ~400-player game-log sync would needlessly delay the boards.
  const bootstrap = async () => {
    await runRoster();
    void runStatcastThenSchedule();
    // Run the game-log / season-line sync unconditionally on boot (not gated on the 20h
    // staleness marker). This sync iterates the active-roster set that runRoster() above
    // finalizes, so a boot right after the roster grows (e.g. the first full 30-team roster
    // sync) must refresh those new players' season line — including stolen bases — even if the
    // last-sync marker was written earlier the same day against a smaller roster. On the
    // intended always-on VM boots are infrequent; the syncInProgress guard + idempotent upserts
    // make repeat boots safe, and it's backgrounded so it never blocks startup or the health
    // probe. The 20h-gated runIfNeeded still drives the steady-state daily interval below.
    void syncMlbGameLogs().catch((err) =>
      logger.error({ err }, "Boot MLB game log sync failed"),
    );
    void runNearMisses();
  };

  // MLB lineups post progressively through the day (a few hours before each first pitch). Re-run
  // just the schedule/prediction sync on a short cadence so games move off the active-roster
  // fallback onto their confirmed starters as lineups drop — keeping the boards to "who's actually
  // playing today". syncDailySchedule is idempotent (weather/odds modeled once per new game) and
  // its stale-cleanup deletes the now-benched fallback predictions. Statcast/roster stay daily.
  const LINEUP_REFRESH_MS = 20 * 60 * 1000; // 20 minutes
  const runLineupRefresh = async () => {
    try {
      await syncDailySchedule();
    } catch (err) {
      logger.error({ err }, "Intra-day lineup refresh failed");
    }
  };

  // Kick off shortly after boot so it doesn't block server startup.
  setTimeout(bootstrap, 3000);
  // Nightly refresh: roster before Statcast+schedule; game logs on their own cadence.
  setInterval(async () => {
    await runRoster();
    await runStatcastThenSchedule();
    await runNearMisses();
  }, DAY_MS);
  setInterval(runIfNeeded, DAY_MS);
  // Intra-day: narrow fallback predictions to confirmed starters as lineups post.
  setInterval(runLineupRefresh, LINEUP_REFRESH_MS);
}
