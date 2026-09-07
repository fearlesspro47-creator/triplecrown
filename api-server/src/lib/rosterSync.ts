import { db, playersTable, appMetaTable } from "@workspace/db";
import { and, inArray, notInArray, isNotNull, sql } from "drizzle-orm";
import { logger } from "./logger";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const ROSTER_LAST_SYNC_KEY = "roster_last_sync";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function currentSeason(): number {
  return new Date().getUTCFullYear();
}

interface TeamInfo {
  id: number;
  name: string;
  abbreviation: string;
}

interface RosterHitter {
  mlbId: number;
  name: string;
  team: string;
  teamAbbr: string;
  position: string;
}

// ---- MLB API fetch helpers (real data, free public endpoints, no key) ----

async function fetchTeams(season: number, attempts = 3): Promise<TeamInfo[]> {
  const url = `${MLB_API}/teams?sportId=1&season=${season}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error(`MLB teams API ${res.status}`);
      const json = (await res.json()) as {
        teams?: Array<{ id?: number; name?: string; abbreviation?: string; sport?: { id?: number } }>;
      };
      return (json.teams ?? [])
        .filter((t) => t.id != null && t.name && t.abbreviation && t.sport?.id === 1)
        .map((t) => ({ id: t.id!, name: t.name!, abbreviation: t.abbreviation! }));
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(attempt * 750);
    }
  }
  throw lastErr;
}

// A team's current active (26-man) roster. Excludes IL/injured players by definition, so a
// player who is hurt (e.g. Aaron Judge on the IL) simply won't appear here.
async function fetchTeamRoster(team: TeamInfo, attempts = 3): Promise<RosterHitter[]> {
  const url = `${MLB_API}/teams/${team.id}/roster?rosterType=active`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error(`MLB roster API ${res.status} for team ${team.abbreviation}`);
      const json = (await res.json()) as {
        roster?: Array<{
          person?: { id?: number; fullName?: string };
          position?: { abbreviation?: string; type?: string };
          jerseyNumber?: string;
        }>;
      };
      const hitters: RosterHitter[] = [];
      for (const entry of json.roster ?? []) {
        const id = entry.person?.id;
        const name = entry.person?.fullName;
        const posAbbr = entry.position?.abbreviation ?? "";
        const posType = entry.position?.type ?? "";
        if (id == null || !name) continue;
        // Keep position players (and two-way bats); drop pure pitchers — pitchers live in the
        // separate `pitchers` table and don't hit under the universal DH.
        if (posType === "Pitcher" && posAbbr !== "TWP") continue;
        hitters.push({
          mlbId: id,
          name,
          team: team.name,
          teamAbbr: team.abbreviation,
          position: posAbbr || "DH",
        });
      }
      return hitters;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(attempt * 750);
    }
  }
  throw lastErr;
}

// Batch-fetch each hitter's batting hand (R/L/S). Chunked to keep URLs small. Degrades
// gracefully: a hitter missing from the map keeps handedness null (neutral platoon edge).
async function fetchBatSides(ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const unique = [...new Set(ids)];
  const CHUNK = 100;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    try {
      const res = await fetch(`${MLB_API}/people?personIds=${chunk.join(",")}`, {
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error(`MLB people API ${res.status}`);
      const json = (await res.json()) as {
        people?: Array<{ id?: number; batSide?: { code?: string } }>;
      };
      for (const p of json.people ?? []) {
        if (p.id != null && p.batSide?.code) map.set(p.id, p.batSide.code.toUpperCase());
      }
    } catch (err) {
      logger.warn({ err }, "Failed to fetch a batSide chunk; those hitters keep null handedness");
    }
    if (i + CHUNK < unique.length) await sleep(150);
  }
  return map;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

export interface RosterSyncResult {
  teamsFetched: number;
  teamsTotal: number;
  hittersUpserted: number;
  deactivated: number;
  complete: boolean;
  skipped?: boolean;
}

let rosterSyncInProgress = false;

// Populate the players table with every active MLB hitter from all 30 clubs' active rosters
// and deactivate anyone no longer on an active roster (injured/IL/optioned). Guarded so a
// manual trigger and the scheduler can't run overlapping syncs on one instance.
export async function syncRosters(): Promise<RosterSyncResult> {
  if (rosterSyncInProgress) {
    logger.info("Roster sync already in progress, skipping duplicate run");
    return { teamsFetched: 0, teamsTotal: 0, hittersUpserted: 0, deactivated: 0, complete: false, skipped: true };
  }
  rosterSyncInProgress = true;
  try {
    return await runRosterSync();
  } finally {
    rosterSyncInProgress = false;
  }
}

async function runRosterSync(): Promise<RosterSyncResult> {
  const season = currentSeason();
  const teams = await fetchTeams(season); // throws if the team list itself can't be fetched

  // Fetch each roster with bounded concurrency. Track which teams actually succeeded so a
  // partial failure can never mass-deactivate players on a team we didn't manage to read.
  const fetchedTeamAbbrs = new Set<string>();
  const hitters: RosterHitter[] = [];
  let teamFailures = 0;
  await mapWithConcurrency(teams, 5, async (team) => {
    try {
      const roster = await fetchTeamRoster(team);
      fetchedTeamAbbrs.add(team.abbreviation);
      hitters.push(...roster);
    } catch (err) {
      teamFailures += 1;
      logger.warn({ err, team: team.abbreviation }, "Failed to fetch team roster; leaving that team's players untouched");
    }
  });

  if (hitters.length === 0) {
    logger.warn("Roster sync fetched no hitters; leaving players table untouched");
    return { teamsFetched: fetchedTeamAbbrs.size, teamsTotal: teams.length, hittersUpserted: 0, deactivated: 0, complete: false };
  }

  // Dedupe by MLB id (defensive against a player appearing on two rosters mid-transaction).
  const byMlbId = new Map<number, RosterHitter>();
  for (const h of hitters) byMlbId.set(h.mlbId, h);
  const uniqueHitters = [...byMlbId.values()];

  const batSides = await fetchBatSides(uniqueHitters.map((h) => h.mlbId));

  // Upsert identity/availability only — never touch stat columns, which are owned by the
  // game-log / statcast syncs. New players get null stats until those syncs populate them.
  const rows = uniqueHitters.map((h) => ({
    mlbId: h.mlbId,
    name: h.name,
    team: h.team,
    teamAbbr: h.teamAbbr,
    position: h.position,
    handedness: batSides.get(h.mlbId) ?? null,
    isActive: true,
  }));

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    await db
      .insert(playersTable)
      .values(batch)
      .onConflictDoUpdate({
        target: playersTable.mlbId,
        set: {
          name: sql`excluded.name`,
          team: sql`excluded.team`,
          teamAbbr: sql`excluded.team_abbr`,
          position: sql`excluded.position`,
          handedness: sql`coalesce(excluded.handedness, ${playersTable.handedness})`,
          isActive: sql`true`,
          updatedAt: new Date(),
        },
      });
  }

  // Deactivate players who belong to a team we successfully read but are no longer on its
  // active roster (injured/IL/optioned/released) — e.g. Aaron Judge while on the IL. Scoped
  // to fetched teams and to rows that have an mlb_id, so partial failures and any manually
  // added (mlb_id-less) players are never touched.
  const activeIds = uniqueHitters.map((h) => h.mlbId);
  let deactivated = 0;
  if (fetchedTeamAbbrs.size > 0 && activeIds.length > 0) {
    const res = await db
      .update(playersTable)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          isNotNull(playersTable.mlbId),
          inArray(playersTable.teamAbbr, [...fetchedTeamAbbrs]),
          notInArray(playersTable.mlbId, activeIds),
        ),
      )
      .returning({ id: playersTable.id });
    deactivated = res.length;
  }

  const complete = teamFailures === 0 && fetchedTeamAbbrs.size === teams.length;
  if (complete) {
    const now = new Date().toISOString();
    await db
      .insert(appMetaTable)
      .values({ key: ROSTER_LAST_SYNC_KEY, value: now })
      .onConflictDoUpdate({ target: appMetaTable.key, set: { value: now, updatedAt: new Date() } });
  } else {
    logger.warn(
      { teamFailures, teamsFetched: fetchedTeamAbbrs.size, teamsTotal: teams.length },
      "Roster sync incomplete; leaving roster_last_sync stale to force a retry",
    );
  }

  logger.info(
    { teamsFetched: fetchedTeamAbbrs.size, teamsTotal: teams.length, hittersUpserted: uniqueHitters.length, deactivated, complete },
    "Roster sync complete",
  );
  return {
    teamsFetched: fetchedTeamAbbrs.size,
    teamsTotal: teams.length,
    hittersUpserted: uniqueHitters.length,
    deactivated,
    complete,
  };
}
