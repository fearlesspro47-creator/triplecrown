import { db, nearMissesTable, playersTable, appMetaTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { logger } from "./logger";
import { todayEastern } from "./dates";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const NEAR_MISS_LAST_SYNC_KEY = "near_miss_last_sync";
const NEAR_MISS_DATE_KEY = "near_miss_date";

// A "near miss" is a hard-hit ball in the home-run launch window that stayed in the park:
// 100+ mph exit velocity, launch angle in the HR window, and NOT a home run.
const MIN_EXIT_VELOCITY = 100; // mph
const HR_WINDOW_MIN_LA = 20; // degrees
const HR_WINDOW_MAX_LA = 40; // degrees
const WARNING_TRACK_FT = 350; // a caught fly this deep = "warning-track flyout"

// How many days back from yesterday we'll look for a slate of finished games.
const MAX_LOOKBACK_DAYS = 4;

export interface NearMissSyncResult {
  date: string | null;
  gamesScanned: number;
  nearMissesFound: number;
  playersStored: number;
  skipped?: boolean;
}

let nearMissSyncInProgress = false;

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0]!;
}

// Statcast "barrel" classification from exit velocity + launch angle. Anchored at the real
// 98 mph / 26-30deg barrel zone and widened as EV rises (the zone expands with velocity).
// Used only for the `isBarrel` flag/label; the near-miss filter itself is the simpler
// 100+ mph in the HR launch window rule above.
function isBarrel(ev: number, la: number): boolean {
  if (ev < 98) return false;
  if (ev < 99) return la >= 26 && la <= 30;
  const step = ev - 98;
  const lower = Math.max(8, 26 - step); // ~ -1 deg per mph
  const upper = Math.min(50, 30 + step * 1.5); // zone opens up faster on the high side
  return la >= lower && la <= upper;
}

const OUT_EVENTS = new Set([
  "field_out",
  "force_out",
  "grounded_into_double_play",
  "double_play",
  "triple_play",
  "sac_fly",
  "sac_fly_double_play",
  "sac_bunt",
  "fielders_choice",
  "fielders_choice_out",
]);

// Bucket a near-miss into a human category + badge label based on how it ended.
function categorize(
  eventType: string | null,
  distance: number | null,
  barrel: boolean,
): { category: string; label: string } {
  if (eventType === "double" || eventType === "triple") {
    return { category: "extra_base_barrel", label: "Extra-base barrel" };
  }
  if (eventType === "single") {
    return { category: "hard_single", label: "Hard single — just missed" };
  }
  if (eventType === "field_error") {
    return { category: "reached_error", label: "Smoked — reached on error" };
  }
  if (eventType && OUT_EVENTS.has(eventType)) {
    if (distance != null && distance >= WARNING_TRACK_FT) {
      return { category: "warning_track_flyout", label: "Warning-track flyout" };
    }
    return { category: "loud_out", label: "Loud out" };
  }
  return { category: barrel ? "barrel" : "hard_hit", label: barrel ? "Barreled up" : "Just missed" };
}

interface ScheduleGame {
  gamePk: number;
  homeId: number;
  awayId: number;
  abstractState: string;
  detailedState: string;
}

// A game that's postponed/cancelled/suspended will never produce more play data, so it doesn't
// block a slate from being "complete" — but it isn't a real Final we'd scan for batted balls.
const NOT_PLAYED_RE = /postponed|cancel|suspend/i;
function isFinal(g: ScheduleGame): boolean {
  return g.abstractState === "Final" && !NOT_PLAYED_RE.test(g.detailedState);
}
function isTerminal(g: ScheduleGame): boolean {
  return g.abstractState === "Final" || NOT_PLAYED_RE.test(g.detailedState);
}

async function fetchSchedule(date: string): Promise<ScheduleGame[]> {
  const res = await fetch(`${MLB_API}/schedule?sportId=1&date=${date}`);
  if (!res.ok) throw new Error(`MLB schedule ${res.status} for ${date}`);
  const j = (await res.json()) as {
    dates?: Array<{
      games?: Array<{
        gamePk: number;
        status?: { abstractGameState?: string; detailedState?: string };
        teams?: { home?: { team?: { id?: number } }; away?: { team?: { id?: number } } };
      }>;
    }>;
  };
  const games = j.dates?.[0]?.games ?? [];
  return games.map((g) => ({
    gamePk: g.gamePk,
    homeId: g.teams?.home?.team?.id ?? 0,
    awayId: g.teams?.away?.team?.id ?? 0,
    abstractState: g.status?.abstractGameState ?? "",
    detailedState: g.status?.detailedState ?? "",
  }));
}

// Walk back from yesterday to the most recent COMPLETE slate. A slate is only accepted once
// every game is terminal (all Final/postponed) with at least one truly Final — otherwise, since
// yesterday's ET slate can still be in progress around midnight (west-coast games), we'd wipe a
// full prior slate and replace it with a partial (early games Final, west-coast games still live).
async function resolveRecentFinalDate(): Promise<{ date: string; games: ScheduleGame[] } | null> {
  const anchor = new Date(`${todayEastern()}T00:00:00Z`);
  for (let back = 1; back <= MAX_LOOKBACK_DAYS; back++) {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() - back);
    const date = isoDate(d);
    try {
      const all = await fetchSchedule(date);
      const finals = all.filter(isFinal);
      const complete = all.length > 0 && finals.length > 0 && all.every(isTerminal);
      if (complete) return { date, games: finals };
    } catch (err) {
      logger.warn({ err, date }, "Near-miss sync: schedule fetch failed, trying previous day");
    }
  }
  return null;
}

async function fetchTeamAbbrById(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const res = await fetch(`${MLB_API}/teams?sportId=1`);
    if (!res.ok) return map;
    const j = (await res.json()) as { teams?: Array<{ id?: number; abbreviation?: string }> };
    for (const t of j.teams ?? []) {
      if (t.id != null && t.abbreviation) map.set(t.id, t.abbreviation);
    }
  } catch {
    /* opponent abbreviation is best-effort; missing it just omits the "vs XXX" label */
  }
  return map;
}

interface RawNearMiss {
  batterMlbId: number;
  exitVelocity: number;
  launchAngle: number;
  distance: number | null;
  eventType: string | null;
  eventLabel: string | null;
  trajectory: string | null;
  barrel: boolean;
  opponentAbbr: string | null;
}

async function fetchGameNearMisses(
  game: ScheduleGame,
  teamAbbrById: Map<number, string>,
): Promise<RawNearMiss[]> {
  const res = await fetch(`${MLB_API}/game/${game.gamePk}/playByPlay`);
  if (!res.ok) throw new Error(`MLB playByPlay ${res.status} for game ${game.gamePk}`);
  const j = (await res.json()) as {
    allPlays?: Array<{
      result?: { eventType?: string; event?: string };
      about?: { halfInning?: string };
      matchup?: { batter?: { id?: number } };
      playEvents?: Array<{
        hitData?: { launchSpeed?: number; launchAngle?: number; totalDistance?: number; trajectory?: string };
      }>;
    }>;
  };

  const out: RawNearMiss[] = [];
  for (const play of j.allPlays ?? []) {
    // The batted-ball metrics live on the play's contact event.
    let hit: { launchSpeed?: number; launchAngle?: number; totalDistance?: number; trajectory?: string } | null = null;
    for (const ev of play.playEvents ?? []) {
      if (ev.hitData && ev.hitData.launchSpeed != null) hit = ev.hitData;
    }
    if (!hit || hit.launchSpeed == null || hit.launchAngle == null) continue;

    const ev = hit.launchSpeed;
    const la = hit.launchAngle;
    const eventType = play.result?.eventType ?? null;

    if (ev < MIN_EXIT_VELOCITY) continue;
    if (la < HR_WINDOW_MIN_LA || la > HR_WINDOW_MAX_LA) continue;
    if (eventType === "home_run") continue;

    const batterMlbId = play.matchup?.batter?.id;
    if (batterMlbId == null) continue;

    // Top of the inning = away team batting -> opponent is home, and vice versa.
    const opponentId = play.about?.halfInning === "top" ? game.homeId : game.awayId;
    const opponentAbbr = teamAbbrById.get(opponentId) ?? null;
    const distance = hit.totalDistance != null ? Math.round(hit.totalDistance) : null;

    out.push({
      batterMlbId,
      exitVelocity: ev,
      launchAngle: la,
      distance,
      eventType,
      eventLabel: play.result?.event ?? null,
      trajectory: hit.trajectory ?? null,
      barrel: isBarrel(ev, la),
      opponentAbbr,
    });
  }
  return out;
}

// Refresh the near-misses table for the most recent finished slate. Real-or-nothing: if the
// MLB API yields nothing, existing rows are left untouched (we only replace on a good fetch).
export async function syncNearMisses(): Promise<NearMissSyncResult> {
  if (nearMissSyncInProgress) {
    logger.info("Near-miss sync already in progress, skipping duplicate run");
    return { date: null, gamesScanned: 0, nearMissesFound: 0, playersStored: 0, skipped: true };
  }
  nearMissSyncInProgress = true;
  try {
    return await runNearMissSync();
  } finally {
    nearMissSyncInProgress = false;
  }
}

async function runNearMissSync(): Promise<NearMissSyncResult> {
  const resolved = await resolveRecentFinalDate();
  if (!resolved) {
    logger.warn("Near-miss sync: no finished games in lookback window; leaving existing rows");
    return { date: null, gamesScanned: 0, nearMissesFound: 0, playersStored: 0 };
  }
  const { date, games } = resolved;
  const teamAbbrById = await fetchTeamAbbrById();

  // Collect every qualifying batted ball across the slate (per-game failures are non-fatal).
  const raw: RawNearMiss[] = [];
  for (const g of games) {
    try {
      raw.push(...(await fetchGameNearMisses(g, teamAbbrById)));
    } catch (err) {
      logger.warn({ err, gamePk: g.gamePk }, "Near-miss sync: play-by-play fetch failed for game");
    }
  }

  if (raw.length === 0) {
    logger.warn({ date }, "Near-miss sync: no qualifying batted balls found; leaving existing rows");
    return { date, gamesScanned: games.length, nearMissesFound: 0, playersStored: 0 };
  }

  // Reduce to one entry per batter: keep their hardest-hit near miss + a total count.
  const best = new Map<number, { best: RawNearMiss; count: number }>();
  for (const nm of raw) {
    const cur = best.get(nm.batterMlbId);
    if (!cur) {
      best.set(nm.batterMlbId, { best: nm, count: 1 });
    } else {
      cur.count += 1;
      if (nm.exitVelocity > cur.best.exitVelocity) cur.best = nm;
    }
  }

  // Only keep batters we actually track (so the board can join name/team/headshot).
  const mlbIds = [...best.keys()];
  const players = await db
    .select({ id: playersTable.id, mlbId: playersTable.mlbId })
    .from(playersTable)
    .where(inArray(playersTable.mlbId, mlbIds));
  const idByMlbId = new Map(players.map((p) => [p.mlbId!, p.id]));

  const rows = [...best.entries()]
    .map(([mlbId, { best: nm, count }]) => {
      const playerId = idByMlbId.get(mlbId);
      if (playerId == null) return null;
      const { category, label } = categorize(nm.eventType, nm.distance, nm.barrel);
      return {
        playerId,
        gameDate: date,
        exitVelocity: nm.exitVelocity.toFixed(2),
        launchAngle: nm.launchAngle.toFixed(2),
        distance: nm.distance,
        eventType: nm.eventType,
        eventLabel: label, // store our badge label (human category), not the raw MLB event
        trajectory: nm.trajectory,
        category,
        isBarrel: nm.barrel,
        count,
        opponentAbbr: nm.opponentAbbr,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);

  // Replace the whole table in a transaction so the board only ever shows one clean slate
  // (yesterday) and there's no empty window mid-sync.
  await db.transaction(async (tx) => {
    await tx.delete(nearMissesTable);
    if (rows.length > 0) await tx.insert(nearMissesTable).values(rows);
  });

  const now = new Date().toISOString();
  await db
    .insert(appMetaTable)
    .values({ key: NEAR_MISS_LAST_SYNC_KEY, value: now })
    .onConflictDoUpdate({ target: appMetaTable.key, set: { value: now, updatedAt: new Date() } });
  await db
    .insert(appMetaTable)
    .values({ key: NEAR_MISS_DATE_KEY, value: date })
    .onConflictDoUpdate({ target: appMetaTable.key, set: { value: date, updatedAt: new Date() } });

  logger.info(
    { date, gamesScanned: games.length, nearMissesFound: raw.length, playersStored: rows.length },
    "Near-miss sync complete",
  );
  return { date, gamesScanned: games.length, nearMissesFound: raw.length, playersStored: rows.length };
}
