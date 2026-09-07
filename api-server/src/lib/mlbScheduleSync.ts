import {
  db,
  gamesTable,
  weatherTable,
  oddsTable,
  predictionsTable,
  playersTable,
  statcastTable,
  gameLogsTable,
  batterVsPitcherTable,
  batterPitchMixTable,
  pitcherArsenalTable,
  pitcherPlatoonSplitsTable,
  appMetaTable,
  pitchersTable,
  type InsertPrediction,
  type InsertPitcher,
  type InsertWeather,
  type InsertOdds,
  type InsertBatterVsPitcher,
  type InsertPitcherPlatoonSplit,
} from "@workspace/db";
import { eq, inArray, and, notInArray, desc } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { todayEastern } from "./dates";
import { fetchGameWeather } from "./weather";
import {
  parkFactorFor,
  hasPlatoonAdvantage,
  computeHitProbability,
  computeHrProbability,
  computeHrScore,
} from "./probability";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const SCHEDULE_SYNC_KEY = "mlb_schedule_last_sync";

// ---- MLB schedule types (only the fields we consume) ----
interface ScheduleTeam {
  team?: { id?: number; name?: string; abbreviation?: string };
  score?: number;
  probablePitcher?: { id?: number; fullName?: string; pitchHand?: { code?: string } };
}
interface ScheduleGame {
  gamePk?: number;
  gameDate?: string;
  status?: { abstractGameState?: string; detailedState?: string };
  venue?: { name?: string };
  teams?: { home?: ScheduleTeam; away?: ScheduleTeam };
  linescore?: { currentInning?: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchSchedule(date: string, attempts = 3): Promise<ScheduleGame[]> {
  const url = `${MLB_API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team,linescore`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error(`MLB schedule API ${res.status} for ${date}`);
      const json = (await res.json()) as { dates?: Array<{ games?: ScheduleGame[] }> };
      return json.dates?.[0]?.games ?? [];
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(attempt * 750);
    }
  }
  throw lastErr;
}

// Confirmed starting lineups (batting order) per game, keyed by gamePk. A side only appears
// once its team posts the lineup (typically a few hours pre-game); sides without a posted
// lineup are simply absent so callers can fall back to the active roster. Real data only —
// no invented lineups. Non-fatal: on total failure returns an empty map (full fallback).
async function fetchLineups(
  date: string,
  attempts = 3,
): Promise<Map<number, { home: Set<number>; away: Set<number> }>> {
  const url = `${MLB_API}/schedule?sportId=1&date=${date}&hydrate=lineups`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error(`MLB lineups API ${res.status} for ${date}`);
      const json = (await res.json()) as {
        dates?: Array<{
          games?: Array<{
            gamePk?: number;
            lineups?: { homePlayers?: Array<{ id?: number }>; awayPlayers?: Array<{ id?: number }> };
          }>;
        }>;
      };
      const map = new Map<number, { home: Set<number>; away: Set<number> }>();
      for (const g of json.dates?.[0]?.games ?? []) {
        if (g.gamePk == null) continue;
        const home = new Set<number>();
        const away = new Set<number>();
        for (const pl of g.lineups?.homePlayers ?? []) if (pl.id != null) home.add(pl.id);
        for (const pl of g.lineups?.awayPlayers ?? []) if (pl.id != null) away.add(pl.id);
        map.set(g.gamePk, { home, away });
      }
      return map;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(attempt * 750);
    }
  }
  logger.warn({ err: lastErr, date }, "Failed to fetch lineups; predictions fall back to active rosters");
  return new Map();
}

// The schedule feed's probablePitcher only carries id + name, so batch-fetch throwing hand
// from the people endpoint. Degrades gracefully: on failure hands stay null (no platoon edge).
async function fetchPitcherHands(ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return map;
  try {
    const res = await fetch(`${MLB_API}/people?personIds=${unique.join(",")}`, {
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`MLB people API ${res.status}`);
    const json = (await res.json()) as { people?: Array<{ id?: number; pitchHand?: { code?: string } }> };
    for (const p of json.people ?? []) {
      if (p.id && p.pitchHand?.code) map.set(p.id, p.pitchHand.code);
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch probable pitcher handedness; predictions will omit platoon edge");
  }
  return map;
}

interface PitcherSeasonStats {
  games: number | null;
  gamesStarted: number | null;
  inningsPitched: string | null;
  strikeouts: number | null;
  era: string | null;
  whip: string | null;
  k9: string | null;
  hr9: string | null;
  wins: number | null;
  losses: number | null;
  avgAgainst: string | null;
}

function intOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : null;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function decOrNull(v: unknown, scale: number): string | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n.toFixed(scale) : null;
}

// Batch-fetch each probable pitcher's season pitching line (per-pitcher endpoint; low concurrency).
// Degrades gracefully: a pitcher missing from the map keeps null stats (neutral in HR Score) and, on
// upsert, preserves any previously-synced DB stats instead of overwriting them with nulls.
async function fetchPitcherSeasonStats(ids: number[], season: number): Promise<Map<number, PitcherSeasonStats>> {
  const map = new Map<number, PitcherSeasonStats>();
  const unique = [...new Set(ids)].filter((x) => typeof x === "number");
  const CONCURRENCY = 5;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (id) => {
        try {
          const res = await fetch(`${MLB_API}/people/${id}/stats?stats=season&group=pitching&season=${season}`, {
            signal: AbortSignal.timeout(20000),
          });
          if (!res.ok) return;
          const json = (await res.json()) as {
            stats?: Array<{ splits?: Array<{ stat?: Record<string, unknown> }> }>;
          };
          const stat = json.stats?.[0]?.splits?.[0]?.stat;
          if (!stat) return;
          map.set(id, {
            games: intOrNull(stat.gamesPlayed),
            gamesStarted: intOrNull(stat.gamesStarted),
            inningsPitched: typeof stat.inningsPitched === "string" ? stat.inningsPitched : null,
            strikeouts: intOrNull(stat.strikeOuts),
            era: decOrNull(stat.era, 2),
            whip: decOrNull(stat.whip, 2),
            k9: decOrNull(stat.strikeoutsPer9Inn, 2),
            hr9: decOrNull(stat.homeRunsPer9, 2),
            wins: intOrNull(stat.wins),
            losses: intOrNull(stat.losses),
            avgAgainst: decOrNull(stat.avg, 3),
          });
        } catch {
          // graceful: leave this pitcher's stats unset (existing DB row preserved on upsert)
        }
      }),
    );
    if (i + CONCURRENCY < unique.length) await sleep(200);
  }
  return map;
}

interface PlatoonSplitResult {
  batSide: "L" | "R";
  battersFaced: number;
  atBats: number;
  hits: number;
  homeRuns: number;
  airOuts: number;
  groundOuts: number;
  avg: string | null;
  slg: string | null;
}

// Batch-fetch each probable pitcher's season line split by the BATTER SIDE faced (vs L / vs R)
// from the free MLB stat-splits endpoint (sitCodes vl,vr). Used to grade + explain how homer-prone
// the starter is against a given hitter's handedness. Degrades gracefully: a per-pitcher failure
// leaves that pitcher out of the map (its DB rows, if any, are preserved on upsert).
async function fetchPitcherPlatoonSplits(
  ids: number[],
  season: number,
): Promise<Map<number, PlatoonSplitResult[]>> {
  const map = new Map<number, PlatoonSplitResult[]>();
  const unique = [...new Set(ids)].filter((x) => typeof x === "number");
  const CONCURRENCY = 5;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (id) => {
        try {
          const res = await fetch(
            `${MLB_API}/people/${id}/stats?stats=statSplits&group=pitching&sitCodes=vl,vr&season=${season}`,
            { signal: AbortSignal.timeout(20000) },
          );
          if (!res.ok) return;
          const json = (await res.json()) as {
            stats?: Array<{ splits?: Array<{ split?: { code?: string }; stat?: Record<string, unknown> }> }>;
          };
          // A traded pitcher's split feed returns one row per team stint PLUS a combined
          // season total (flagged numTeams>1, and always the largest battersFaced). Dedupe
          // to a single row per bat side — keeping the max-battersFaced row — so the upsert
          // never hits the same (pitcher, season, batSide) conflict target twice in one batch.
          const bySide = new Map<string, PlatoonSplitResult>();
          for (const sp of json.stats?.[0]?.splits ?? []) {
            const code = sp.split?.code;
            const side = code === "vl" ? "L" : code === "vr" ? "R" : null;
            if (!side) continue;
            const st = sp.stat ?? {};
            const row: PlatoonSplitResult = {
              batSide: side,
              battersFaced: intOrNull(st.battersFaced) ?? 0,
              atBats: intOrNull(st.atBats) ?? 0,
              hits: intOrNull(st.hits) ?? 0,
              homeRuns: intOrNull(st.homeRuns) ?? 0,
              airOuts: intOrNull(st.airOuts) ?? 0,
              groundOuts: intOrNull(st.groundOuts) ?? 0,
              avg: decOrNull(st.avg, 3),
              slg: decOrNull(st.slg, 3),
            };
            const prev = bySide.get(side);
            if (!prev || row.battersFaced > prev.battersFaced) bySide.set(side, row);
          }
          const out = [...bySide.values()];
          if (out.length) map.set(id, out);
        } catch {
          // graceful: leave this pitcher's splits unset (existing DB rows preserved on upsert)
        }
      }),
    );
    if (i + CONCURRENCY < unique.length) await sleep(200);
  }
  return map;
}

interface BvPResult {
  seasonAb: number;
  seasonHr: number;
  seasonHits: number;
  seasonDoubles: number;
  seasonTriples: number;
  seasonStrikeouts: number;
  careerAb: number;
  careerHr: number;
  careerHits: number;
  careerDoubles: number;
  careerTriples: number;
  careerStrikeouts: number;
}

// Batter-vs-pitcher: at-bats + HR this season and career (career - season = previous years).
// One request returns both the per-season splits and the career total (vsPlayerTotal).
async function fetchBvP(batterMlbId: number, pitcherMlbId: number, season: number): Promise<BvPResult | null> {
  try {
    const url =
      `${MLB_API}/people/${batterMlbId}/stats` +
      `?stats=vsPlayer,vsPlayerTotal&group=hitting&opposingPlayerId=${pitcherMlbId}&season=${season}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    type BvpStat = {
      atBats?: number;
      homeRuns?: number;
      hits?: number;
      doubles?: number;
      triples?: number;
      strikeOuts?: number;
    };
    const json = (await res.json()) as {
      stats?: Array<{
        type?: { displayName?: string };
        splits?: Array<{ season?: string; stat?: BvpStat }>;
      }>;
    };
    const result: BvPResult = {
      seasonAb: 0,
      seasonHr: 0,
      seasonHits: 0,
      seasonDoubles: 0,
      seasonTriples: 0,
      seasonStrikeouts: 0,
      careerAb: 0,
      careerHr: 0,
      careerHits: 0,
      careerDoubles: 0,
      careerTriples: 0,
      careerStrikeouts: 0,
    };
    for (const group of json.stats ?? []) {
      const type = group.type?.displayName;
      if (type === "vsPlayerTotal") {
        const st = group.splits?.[0]?.stat;
        result.careerAb = st?.atBats ?? 0;
        result.careerHr = st?.homeRuns ?? 0;
        result.careerHits = st?.hits ?? 0;
        result.careerDoubles = st?.doubles ?? 0;
        result.careerTriples = st?.triples ?? 0;
        result.careerStrikeouts = st?.strikeOuts ?? 0;
      } else if (type === "vsPlayer") {
        const split = (group.splits ?? []).find((s) => s.season === String(season));
        if (split) {
          result.seasonAb = split.stat?.atBats ?? 0;
          result.seasonHr = split.stat?.homeRuns ?? 0;
          result.seasonHits = split.stat?.hits ?? 0;
          result.seasonDoubles = split.stat?.doubles ?? 0;
          result.seasonTriples = split.stat?.triples ?? 0;
          result.seasonStrikeouts = split.stat?.strikeOuts ?? 0;
        }
      }
    }
    return result;
  } catch {
    return null;
  }
}

function mapStatus(s?: ScheduleGame["status"]): string {
  const a = s?.abstractGameState;
  if (a === "Live") return "live";
  if (a === "Final") return "final";
  return "scheduled";
}

// ---- Deterministic modeled weather + odds (kept stable per game via its gamePk) ----
function seeded(n: number): number {
  let t = (n + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const BOOKMAKERS = ["DraftKings", "FanDuel", "BetMGM"];
function americanFromProb(p: number): number {
  const c = Math.max(0.05, Math.min(0.95, p));
  return c > 0.5 ? -Math.round((c / (1 - c)) * 100) : Math.round(((1 - c) / c) * 100);
}
function modelOdds(gamePk: number, gameId: number): InsertOdds[] {
  const baseHomeProb = 0.4 + seeded(gamePk * 7 + 11) * 0.22; // 0.40-0.62
  const ou = 7.5 + Math.floor(seeded(gamePk * 7 + 3) * 7) * 0.5; // 7.5-10.5
  const homeSpread = baseHomeProb >= 0.5 ? -1.5 : 1.5;
  return BOOKMAKERS.map((bookmaker, i) => {
    const noise = (seeded(gamePk * 7 + 20 + i) - 0.5) * 0.02;
    const hp = Math.max(0.05, Math.min(0.95, baseHomeProb + noise));
    return {
      gameId,
      bookmaker,
      homeML: americanFromProb(hp).toFixed(1),
      awayML: americanFromProb(1 - hp).toFixed(1),
      overUnder: (ou + (i - 1) * 0.5).toFixed(1),
      spread: homeSpread.toFixed(1),
    };
  });
}

export interface ScheduleSyncResult {
  games: number;
  predictions: number;
  errors: number;
  date: string;
}

let scheduleSyncInProgress = false;

// Fetch today's real MLB schedule, upsert games (idempotent on mlb_game_pk), refresh real
// forecast weather (+ modeled odds), then recompute per-player daily hit/HR predictions.
export async function syncDailySchedule(date = todayEastern()): Promise<ScheduleSyncResult> {
  if (scheduleSyncInProgress) {
    logger.info("Schedule sync already in progress, skipping duplicate run");
    return { games: 0, predictions: 0, errors: 0, date };
  }
  scheduleSyncInProgress = true;
  try {
    const games = await syncMlbSchedule(date);
    const predictions = await syncDailyPredictions(date);
    const now = new Date().toISOString();
    await db
      .insert(appMetaTable)
      .values({ key: SCHEDULE_SYNC_KEY, value: now })
      .onConflictDoUpdate({ target: appMetaTable.key, set: { value: now, updatedAt: new Date() } });
    logger.info({ date, games, predictions }, "Daily schedule + prediction sync complete");
    return { games, predictions, errors: 0, date };
  } catch (err) {
    logger.error({ err, date }, "Daily schedule sync failed");
    return { games: 0, predictions: 0, errors: 1, date };
  } finally {
    scheduleSyncInProgress = false;
  }
}

export async function syncMlbSchedule(date = todayEastern()): Promise<number> {
  const raw = await fetchSchedule(date);
  const valid = raw.filter((g) => g.gamePk && g.teams?.home?.team && g.teams?.away?.team);
  if (valid.length === 0) {
    logger.warn({ date }, "MLB schedule returned no games for date");
    return 0;
  }

  const pitcherIds = valid.flatMap((g) =>
    [g.teams?.home?.probablePitcher?.id, g.teams?.away?.probablePitcher?.id].filter(
      (x): x is number => typeof x === "number",
    ),
  );
  const handById = await fetchPitcherHands(pitcherIds);
  const handOf = (t: ScheduleTeam): string | null =>
    t.probablePitcher?.pitchHand?.code ??
    (t.probablePitcher?.id ? handById.get(t.probablePitcher.id) ?? null : null);

  const season = parseInt(date.slice(0, 4), 10);
  const statsById = await fetchPitcherSeasonStats(pitcherIds, season);
  const platoonById = await fetchPitcherPlatoonSplits(pitcherIds, season);
  const hr9Of = (t: ScheduleTeam): string | null => {
    const id = t.probablePitcher?.id;
    return (id != null ? statsById.get(id)?.hr9 : null) ?? null;
  };
  const mlbIdOf = (t: ScheduleTeam): number | null => t.probablePitcher?.id ?? null;

  // Collect probable-pitcher rows to upsert into the pitchers table (deduped by MLB id).
  const pitcherRows = new Map<number, InsertPitcher>();
  const addPitcher = (t: ScheduleTeam, teamAbbr: string) => {
    const id = t.probablePitcher?.id;
    if (id == null) return;
    const s = statsById.get(id);
    pitcherRows.set(id, {
      mlbId: id,
      name: t.probablePitcher?.fullName ?? `#${id}`,
      team: teamAbbr || null,
      hand: t.probablePitcher?.pitchHand?.code ?? handById.get(id) ?? null,
      games: s?.games ?? null,
      gamesStarted: s?.gamesStarted ?? null,
      inningsPitched: s?.inningsPitched ?? null,
      strikeouts: s?.strikeouts ?? null,
      era: s?.era ?? null,
      whip: s?.whip ?? null,
      k9: s?.k9 ?? null,
      hr9: s?.hr9 ?? null,
      wins: s?.wins ?? null,
      losses: s?.losses ?? null,
      avgAgainst: s?.avgAgainst ?? null,
    });
  };

  const saved: Array<{
    id: number;
    gamePk: number;
    venue: string;
    homeTeam: string;
    homeTeamAbbr: string;
    gameTime: string;
  }> = [];
  for (const g of valid) {
    const home = g.teams!.home!;
    const away = g.teams!.away!;
    const row = {
      mlbGamePk: g.gamePk!,
      homeTeam: home.team!.name ?? "",
      homeTeamAbbr: home.team!.abbreviation ?? "",
      awayTeam: away.team!.name ?? "",
      awayTeamAbbr: away.team!.abbreviation ?? "",
      gameTime: g.gameDate ?? date,
      gameDate: date,
      status: mapStatus(g.status),
      venue: g.venue?.name ?? "",
      homeScore: home.score ?? null,
      awayScore: away.score ?? null,
      inning: g.linescore?.currentInning ?? null,
      homePitcher: home.probablePitcher?.fullName ?? null,
      awayPitcher: away.probablePitcher?.fullName ?? null,
      homePitcherHand: handOf(home),
      awayPitcherHand: handOf(away),
      homePitcherMlbId: mlbIdOf(home),
      awayPitcherMlbId: mlbIdOf(away),
      homePitcherHr9: hr9Of(home),
      awayPitcherHr9: hr9Of(away),
    };
    addPitcher(home, row.homeTeamAbbr);
    addPitcher(away, row.awayTeamAbbr);
    const [ins] = await db
      .insert(gamesTable)
      .values(row)
      .onConflictDoUpdate({
        target: gamesTable.mlbGamePk,
        set: {
          gameDate: row.gameDate,
          gameTime: row.gameTime,
          status: row.status,
          venue: row.venue,
          homeScore: row.homeScore,
          awayScore: row.awayScore,
          inning: row.inning,
          homePitcher: row.homePitcher,
          awayPitcher: row.awayPitcher,
          homePitcherHand: row.homePitcherHand,
          awayPitcherHand: row.awayPitcherHand,
          homePitcherMlbId: row.homePitcherMlbId,
          awayPitcherMlbId: row.awayPitcherMlbId,
          homePitcherHr9: row.homePitcherHr9,
          awayPitcherHr9: row.awayPitcherHr9,
        },
      })
      .returning({ id: gamesTable.id });
    if (ins)
      saved.push({
        id: ins.id,
        gamePk: g.gamePk!,
        venue: row.venue,
        homeTeam: row.homeTeam,
        homeTeamAbbr: row.homeTeamAbbr,
        gameTime: row.gameTime,
      });
  }

  // Upsert probable pitchers. Non-fatal: a failure here never fails the schedule sync.
  // Stat columns are only overwritten when this run actually fetched stats, so a transient
  // MLB stats outage preserves previously-synced pitcher lines instead of nulling them.
  try {
    for (const [id, prow] of pitcherRows) {
      const set: Record<string, unknown> = { name: prow.name, team: prow.team, hand: prow.hand };
      if (statsById.has(id)) {
        Object.assign(set, {
          games: prow.games,
          gamesStarted: prow.gamesStarted,
          inningsPitched: prow.inningsPitched,
          strikeouts: prow.strikeouts,
          era: prow.era,
          whip: prow.whip,
          k9: prow.k9,
          hr9: prow.hr9,
          wins: prow.wins,
          losses: prow.losses,
          avgAgainst: prow.avgAgainst,
        });
      }
      await db.insert(pitchersTable).values(prow).onConflictDoUpdate({ target: pitchersTable.mlbId, set });
    }
  } catch (err) {
    logger.warn({ err }, "Failed to upsert pitcher season stats");
  }

  // Upsert probable pitchers' batter-side (vs L / vs R) splits. Non-fatal: a failure here never
  // fails the schedule sync. Only sides actually fetched this run are written (real-or-nothing);
  // upsert (not delete) preserves the other side if only one side came back.
  try {
    const platoonRows: InsertPitcherPlatoonSplit[] = [];
    for (const [id, splits] of platoonById) {
      for (const s of splits) {
        platoonRows.push({
          pitcherMlbId: id,
          season,
          batSide: s.batSide,
          battersFaced: s.battersFaced,
          atBats: s.atBats,
          hits: s.hits,
          homeRuns: s.homeRuns,
          airOuts: s.airOuts,
          groundOuts: s.groundOuts,
          avg: s.avg,
          slg: s.slg,
        });
      }
    }
    if (platoonRows.length) {
      await db
        .insert(pitcherPlatoonSplitsTable)
        .values(platoonRows)
        .onConflictDoUpdate({
          target: [
            pitcherPlatoonSplitsTable.pitcherMlbId,
            pitcherPlatoonSplitsTable.season,
            pitcherPlatoonSplitsTable.batSide,
          ],
          set: {
            battersFaced: sql`excluded.batters_faced`,
            atBats: sql`excluded.at_bats`,
            hits: sql`excluded.hits`,
            homeRuns: sql`excluded.home_runs`,
            airOuts: sql`excluded.air_outs`,
            groundOuts: sql`excluded.ground_outs`,
            avg: sql`excluded.avg`,
            slg: sql`excluded.slg`,
            updatedAt: new Date(),
          },
        });
    }
  } catch (err) {
    logger.warn({ err }, "Failed to upsert pitcher platoon splits");
  }

  await backfillWeatherAndOdds(saved);
  return saved.length;
}

// Real forecast weather (Open-Meteo) is refreshed on every schedule sync so it tracks the day's
// changing forecast; odds stay modeled and are created once so live re-syncs don't churn them.
async function backfillWeatherAndOdds(
  games: Array<{
    id: number;
    gamePk: number;
    venue: string;
    homeTeam: string;
    homeTeamAbbr: string;
    gameTime: string;
  }>,
): Promise<void> {
  if (games.length === 0) return;
  const ids = games.map((g) => g.id);

  // Fetch real forecast weather per game with bounded concurrency. A failed/unknown-park fetch
  // returns null and that game simply gets no weather row (real-or-nothing, never fabricated).
  const WEATHER_CONCURRENCY = 5;
  const weatherRows: InsertWeather[] = [];
  for (let i = 0; i < games.length; i += WEATHER_CONCURRENCY) {
    const batch = games.slice(i, i + WEATHER_CONCURRENCY);
    const results = await Promise.all(batch.map((g) => fetchGameWeather(g)));
    for (const w of results) if (w) weatherRows.push(w);
    if (i + WEATHER_CONCURRENCY < games.length) await sleep(150);
  }
  if (weatherRows.length) {
    await db
      .insert(weatherTable)
      .values(weatherRows)
      .onConflictDoUpdate({
        target: weatherTable.gameId,
        set: {
          stadium: sql`excluded.stadium`,
          city: sql`excluded.city`,
          temperature: sql`excluded.temperature`,
          feelsLike: sql`excluded.feels_like`,
          humidity: sql`excluded.humidity`,
          windSpeed: sql`excluded.wind_speed`,
          windDirection: sql`excluded.wind_direction`,
          windDeg: sql`excluded.wind_deg`,
          condition: sql`excluded.condition`,
          conditionIcon: sql`excluded.condition_icon`,
          hrBoostFactor: sql`excluded.hr_boost_factor`,
          rainProbability: sql`excluded.rain_probability`,
          updatedAt: new Date(),
        },
      });
  }

  const existingOdds = await db
    .select({ gameId: oddsTable.gameId })
    .from(oddsTable)
    .where(inArray(oddsTable.gameId, ids));
  const haveOdds = new Set(existingOdds.map((o) => o.gameId));
  const oddsRows = games.filter((g) => !haveOdds.has(g.id)).flatMap((g) => modelOdds(g.gamePk, g.id));
  if (oddsRows.length) {
    await db.insert(oddsTable).values(oddsRows);
  }
}

const clampConfidence = (x: number) => Math.max(0.05, Math.min(0.98, x));

// For each tracked (active) player whose team plays on `date`, compute today's hit and HR
// probabilities vs the real opposing probable pitcher + ballpark + modeled weather, and upsert
// them. Players whose team is off get no prediction row for the day (removed if stale).
export async function syncDailyPredictions(date = todayEastern()): Promise<number> {
  const players = await db.select().from(playersTable).where(eq(playersTable.isActive, true));
  const games = await db.select().from(gamesTable).where(eq(gamesTable.gameDate, date));
  const lineups = await fetchLineups(date);
  const weatherRows = await db.select().from(weatherTable);
  const weatherByGame = new Map(weatherRows.map((w) => [w.gameId, w]));

  const activeIds = players.map((p) => p.id);
  const season = parseInt(date.slice(0, 4), 10);

  // Statcast quality-of-contact per player (numeric columns come back as strings).
  const statcastByPlayer = new Map<
    number,
    { barrelRate: number | null; hardHitRate: number | null; xslg: number | null }
  >();
  if (activeIds.length) {
    const scRows = await db.select().from(statcastTable).where(inArray(statcastTable.playerId, activeIds));
    for (const s of scRows) {
      statcastByPlayer.set(s.playerId, {
        barrelRate: s.barrelRate != null ? parseFloat(s.barrelRate) : null,
        hardHitRate: s.hardHitRate != null ? parseFloat(s.hardHitRate) : null,
        xslg: s.xslg != null ? parseFloat(s.xslg) : null,
      });
    }
  }

  // Real inputs for the two v2 HR-Score matchup components. All keyed for O(1) lookup in the loop.
  const pitcherMlbIds = [
    ...new Set(
      games.flatMap((g) => [g.homePitcherMlbId, g.awayPitcherMlbId].filter((x): x is number => x != null)),
    ),
  ];
  // Batter power by pitch family (season) → AB-weighted ISO vs the starter's go-to pitches.
  const pitchMixByPlayer = new Map<number, { pitchType: string; iso: number | null; atBats: number }[]>();
  if (activeIds.length) {
    const rows = await db
      .select({
        playerId: batterPitchMixTable.playerId,
        pitchType: batterPitchMixTable.pitchType,
        iso: batterPitchMixTable.iso,
        atBats: batterPitchMixTable.atBats,
      })
      .from(batterPitchMixTable)
      .where(and(eq(batterPitchMixTable.season, season), inArray(batterPitchMixTable.playerId, activeIds)));
    for (const r of rows) {
      const arr = pitchMixByPlayer.get(r.playerId) ?? [];
      arr.push({ pitchType: r.pitchType, iso: r.iso != null ? parseFloat(r.iso) : null, atBats: r.atBats });
      pitchMixByPlayer.set(r.playerId, arr);
    }
  }
  // Each starter's go-to (usage >= 20%) pitch families.
  const arsenalTopByPitcher = new Map<number, Set<string>>();
  if (pitcherMlbIds.length) {
    const rows = await db
      .select({
        pitcherMlbId: pitcherArsenalTable.pitcherMlbId,
        pitchType: pitcherArsenalTable.pitchType,
        usage: pitcherArsenalTable.usage,
      })
      .from(pitcherArsenalTable)
      .where(and(eq(pitcherArsenalTable.season, season), inArray(pitcherArsenalTable.pitcherMlbId, pitcherMlbIds)));
    for (const r of rows) {
      if (parseFloat(r.usage) < 0.2) continue;
      const set = arsenalTopByPitcher.get(r.pitcherMlbId) ?? new Set<string>();
      set.add(r.pitchType);
      arsenalTopByPitcher.set(r.pitcherMlbId, set);
    }
  }
  // Each starter's season HR + AB allowed by batter side (vs L / vs R).
  const platoonByPitcher = new Map<number, Map<string, { homeRuns: number; atBats: number }>>();
  if (pitcherMlbIds.length) {
    const rows = await db
      .select()
      .from(pitcherPlatoonSplitsTable)
      .where(
        and(
          eq(pitcherPlatoonSplitsTable.season, season),
          inArray(pitcherPlatoonSplitsTable.pitcherMlbId, pitcherMlbIds),
        ),
      );
    for (const r of rows) {
      const m = platoonByPitcher.get(r.pitcherMlbId) ?? new Map<string, { homeRuns: number; atBats: number }>();
      m.set(r.batSide, { homeRuns: r.homeRuns, atBats: r.atBats });
      platoonByPitcher.set(r.pitcherMlbId, m);
    }
  }

  // Recent form (0-1) from the last 10 game-days: 70% hit-rate + 30% HR-rate. Left unset
  // (neutral in the HR Score) for players with fewer than 5 recent game logs.
  const recentFormByPlayer = new Map<number, number>();
  if (activeIds.length) {
    const logs = await db
      .select()
      .from(gameLogsTable)
      .where(inArray(gameLogsTable.playerId, activeIds))
      .orderBy(desc(gameLogsTable.gameDate));
    const byPlayer = new Map<number, typeof logs>();
    for (const l of logs) {
      const arr = byPlayer.get(l.playerId) ?? [];
      if (arr.length < 10) {
        arr.push(l);
        byPlayer.set(l.playerId, arr);
      }
    }
    const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
    for (const [pid, recent] of byPlayer) {
      if (recent.length < 5) continue;
      const hitGames = recent.filter((l) => l.hadHit).length;
      const ab = recent.reduce((s, l) => s + l.atBats, 0);
      const hr = recent.reduce((s, l) => s + l.homeRuns, 0);
      const hitRate = hitGames / recent.length;
      const hrPerAb = ab > 0 ? hr / ab : 0;
      const normHit = clamp01((hitRate - 0.15) / (0.45 - 0.15));
      const normHr = clamp01(hrPerAb / 0.09);
      recentFormByPlayer.set(pid, 0.7 * normHit + 0.3 * normHr);
    }
  }

  const rows: InsertPrediction[] = [];
  const playersWithGame: number[] = [];
  const bvpTasks: Array<{
    playerId: number;
    playerMlbId: number;
    gameId: number;
    pitcherMlbId: number;
    pitcherName: string | null;
  }> = [];

  for (const p of players) {
    const game = games.find((g) => g.homeTeamAbbr === p.teamAbbr || g.awayTeamAbbr === p.teamAbbr);
    if (!game) continue; // off day
    const isHome = game.homeTeamAbbr === p.teamAbbr;

    // "Actually playing today": if this game side's lineup is posted, only the confirmed
    // starting nine get predictions; if it isn't posted yet, fall back to the active roster
    // so boards are never empty. Injured players (off the active roster) were already excluded.
    const lu = game.mlbGamePk != null ? lineups.get(game.mlbGamePk) : undefined;
    const sideLineup = lu ? (isHome ? lu.home : lu.away) : undefined;
    if (sideLineup && sideLineup.size > 0 && (p.mlbId == null || !sideLineup.has(p.mlbId))) continue;

    const oppPitcherHand = isHome ? game.awayPitcherHand : game.homePitcherHand;
    const oppPitcherName = isHome ? game.awayPitcher : game.homePitcher;
    const oppPitcherMlbId = isHome ? game.awayPitcherMlbId : game.homePitcherMlbId;
    const oppPitcherHr9Raw = isHome ? game.awayPitcherHr9 : game.homePitcherHr9;
    const oppPitcherHr9 = oppPitcherHr9Raw != null ? parseFloat(oppPitcherHr9Raw) : null;
    const opponentAbbr = isHome ? game.awayTeamAbbr : game.homeTeamAbbr;
    const park = parkFactorFor(game.homeTeamAbbr);
    const weather = weatherByGame.get(game.id);
    const weatherHrBoost = weather ? parseFloat(weather.hrBoostFactor) : 1;

    const battingAvg = p.battingAvg ? parseFloat(p.battingAvg) : 0.26;
    const hrRate = p.hrRate ? parseFloat(p.hrRate) : 0.04;
    const hitProb = computeHitProbability({
      battingAvg,
      batterHand: p.handedness,
      pitcherHand: oppPitcherHand,
      parkFactor: park,
      weatherHrBoost,
    });
    const hrProb = computeHrProbability({ hrRate, parkFactor: park, weatherHrBoost });
    const platoon = hasPlatoonAdvantage(p.handedness, oppPitcherHand);

    const baseFactors = [
      `${isHome ? "vs" : "@"} ${opponentAbbr}`,
      oppPitcherName ? `Opp SP: ${oppPitcherName} (${oppPitcherHand ?? "?"}HP)` : "Opp SP: TBD",
      `Park factor ${park.toFixed(2)}x`,
      weather ? `Wind ${weather.windDirection}, ${Math.round(parseFloat(weather.temperature))}°F` : "",
      platoon ? "Platoon edge" : "",
    ].filter(Boolean);

    const dataConf = oppPitcherHand ? 0.12 : 0;
    playersWithGame.push(p.id);
    rows.push({
      playerId: p.id,
      playerName: p.name,
      team: p.team,
      gameId: game.id,
      predictionType: "hit",
      value: hitProb.toFixed(3),
      confidence: clampConfidence(0.55 + dataConf + Math.min(0.2, (battingAvg - 0.25) * 2)).toFixed(3),
      date,
      factors: [...baseFactors, `Season BA .${Math.round(battingAvg * 1000)}`],
    });
    rows.push({
      playerId: p.id,
      playerName: p.name,
      team: p.team,
      gameId: game.id,
      predictionType: "hr",
      value: hrProb.toFixed(3),
      confidence: clampConfidence(0.45 + dataConf + Math.min(0.2, (hrRate - 0.03) * 4)).toFixed(3),
      date,
      factors: [...baseFactors, `Season HR rate ${(hrRate * 100).toFixed(1)}%`],
    });

    // Pitch-matchup ISO: AB-weighted ISO over the starter's go-to (usage>=20%) families the hitter
    // has faced (>=15 AB). Null (dropped + renormalized) when no qualifying pitch-mix/arsenal data.
    let pitchMatchupIso: number | null = null;
    if (oppPitcherMlbId != null) {
      const topFams = arsenalTopByPitcher.get(oppPitcherMlbId);
      const mix = pitchMixByPlayer.get(p.id);
      if (topFams && topFams.size && mix) {
        let abSum = 0;
        let isoAb = 0;
        for (const m of mix) {
          if (!topFams.has(m.pitchType) || m.iso == null || m.atBats <= 0) continue;
          abSum += m.atBats;
          isoAb += m.iso * m.atBats;
        }
        if (abSum >= 15) pitchMatchupIso = isoAb / abSum;
      }
    }
    // Platoon HR: the starter's season HR-per-AB vs the hitter's batting side (switch hitters bat
    // opposite the pitcher's hand). Null (neutral 0.5) when the side has <40 AB of sample.
    let platoonHrPerAb: number | null = null;
    if (oppPitcherMlbId != null) {
      const bh = (p.handedness ?? "").toUpperCase();
      const ph = (oppPitcherHand ?? "").toUpperCase();
      const effSide =
        bh === "L" ? "L" : bh === "R" ? "R" : bh === "S" ? (ph === "R" ? "L" : ph === "L" ? "R" : null) : null;
      if (effSide) {
        const ps = platoonByPitcher.get(oppPitcherMlbId)?.get(effSide);
        if (ps && ps.atBats >= 40) platoonHrPerAb = ps.homeRuns / ps.atBats;
      }
    }

    // Composite HR Score (0-100): weighted quality-of-contact + matchup + context.
    const sc = statcastByPlayer.get(p.id);
    const hrScore = computeHrScore({
      barrelRate: sc?.barrelRate ?? null,
      hardHitRate: sc?.hardHitRate ?? null,
      xslg: sc?.xslg ?? null,
      pitchMatchupIso,
      pitcherHr9: oppPitcherHr9,
      platoonHrPerAb,
      parkFactor: park,
      weatherHrBoost,
      recentForm: recentFormByPlayer.get(p.id) ?? null,
    });
    rows.push({
      playerId: p.id,
      playerName: p.name,
      team: p.team,
      gameId: game.id,
      predictionType: "hr_score",
      value: hrScore.score.toFixed(3), // 0-100, NOT a probability
      confidence: clampConfidence(0.4 + hrScore.components.filter((c) => c.available).length * 0.08).toFixed(3),
      date,
      factors: hrScore.components
        .filter((c) => c.available)
        .map((c) => `${c.label} ${Math.round(c.normalized * 100)}`),
      meta: hrScore,
    });

    // Batter-vs-pitcher matchup (requires both the hitter's and pitcher's MLB ids).
    if (p.mlbId != null && oppPitcherMlbId != null) {
      bvpTasks.push({
        playerId: p.id,
        playerMlbId: p.mlbId,
        gameId: game.id,
        pitcherMlbId: oppPitcherMlbId,
        pitcherName: oppPitcherName,
      });
    }
  }

  if (rows.length) {
    await db
      .insert(predictionsTable)
      .values(rows)
      .onConflictDoUpdate({
        target: [predictionsTable.playerId, predictionsTable.date, predictionsTable.predictionType],
        set: {
          value: sql`excluded.value`,
          confidence: sql`excluded.confidence`,
          gameId: sql`excluded.game_id`,
          factors: sql`excluded.factors`,
          playerName: sql`excluded.player_name`,
          team: sql`excluded.team`,
          meta: sql`excluded.meta`,
        },
      });
  }

  // Batter-vs-pitcher: fetch from the MLB API with low concurrency, then upsert on (player, game).
  const bvpRows: InsertBatterVsPitcher[] = [];
  const BVP_CONCURRENCY = 5;
  for (let i = 0; i < bvpTasks.length; i += BVP_CONCURRENCY) {
    const batch = bvpTasks.slice(i, i + BVP_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (t) => ({ t, r: await fetchBvP(t.playerMlbId, t.pitcherMlbId, season) })),
    );
    for (const { t, r } of results) {
      if (!r) continue;
      bvpRows.push({
        playerId: t.playerId,
        gameId: t.gameId,
        date,
        pitcherMlbId: t.pitcherMlbId,
        pitcherName: t.pitcherName,
        season,
        seasonAb: r.seasonAb,
        seasonHr: r.seasonHr,
        seasonHits: r.seasonHits,
        seasonDoubles: r.seasonDoubles,
        seasonTriples: r.seasonTriples,
        seasonStrikeouts: r.seasonStrikeouts,
        careerAb: r.careerAb,
        careerHr: r.careerHr,
        careerHits: r.careerHits,
        careerDoubles: r.careerDoubles,
        careerTriples: r.careerTriples,
        careerStrikeouts: r.careerStrikeouts,
      });
    }
    if (i + BVP_CONCURRENCY < bvpTasks.length) await sleep(200);
  }
  if (bvpRows.length) {
    await db
      .insert(batterVsPitcherTable)
      .values(bvpRows)
      .onConflictDoUpdate({
        target: [batterVsPitcherTable.playerId, batterVsPitcherTable.gameId],
        set: {
          date: sql`excluded.date`,
          pitcherMlbId: sql`excluded.pitcher_mlb_id`,
          pitcherName: sql`excluded.pitcher_name`,
          season: sql`excluded.season`,
          seasonAb: sql`excluded.season_ab`,
          seasonHr: sql`excluded.season_hr`,
          seasonHits: sql`excluded.season_hits`,
          seasonDoubles: sql`excluded.season_doubles`,
          seasonTriples: sql`excluded.season_triples`,
          seasonStrikeouts: sql`excluded.season_strikeouts`,
          careerAb: sql`excluded.career_ab`,
          careerHr: sql`excluded.career_hr`,
          careerHits: sql`excluded.career_hits`,
          careerDoubles: sql`excluded.career_doubles`,
          careerTriples: sql`excluded.career_triples`,
          careerStrikeouts: sql`excluded.career_strikeouts`,
        },
      });
  }

  // Drop stale predictions + BvP for this date whose player no longer has a game (e.g.
  // postponed). Scoped to the prediction types this pipeline owns so other types are untouched.
  const ownedTypes = ["hit", "hr", "hr_score"];
  if (playersWithGame.length) {
    await db
      .delete(predictionsTable)
      .where(
        and(
          eq(predictionsTable.date, date),
          inArray(predictionsTable.predictionType, ownedTypes),
          notInArray(predictionsTable.playerId, playersWithGame),
        ),
      );
  } else {
    await db
      .delete(predictionsTable)
      .where(and(eq(predictionsTable.date, date), inArray(predictionsTable.predictionType, ownedTypes)));
  }

  // BvP: keep only rows that match a currently-intended (player, game, pitcher) matchup for this
  // date. This drops rows for postponed games, scratched/removed probable pitchers, and the case
  // where the probable pitcher changed but the fresh fetch failed — surfacing nothing beats showing
  // stale matchup history for the wrong pitcher (mirrors the Games API's "no misleading data" rule).
  const intendedBvpKeys = new Set(bvpTasks.map((t) => `${t.playerId}:${t.gameId}:${t.pitcherMlbId}`));
  const existingBvp = await db
    .select({
      id: batterVsPitcherTable.id,
      playerId: batterVsPitcherTable.playerId,
      gameId: batterVsPitcherTable.gameId,
      pitcherMlbId: batterVsPitcherTable.pitcherMlbId,
    })
    .from(batterVsPitcherTable)
    .where(eq(batterVsPitcherTable.date, date));
  const staleBvpIds = existingBvp
    .filter((r) => !intendedBvpKeys.has(`${r.playerId}:${r.gameId}:${r.pitcherMlbId}`))
    .map((r) => r.id);
  if (staleBvpIds.length) {
    await db.delete(batterVsPitcherTable).where(inArray(batterVsPitcherTable.id, staleBvpIds));
  }

  return rows.length;
}
