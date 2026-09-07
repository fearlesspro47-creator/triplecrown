import { db, statcastTable, playersTable, appMetaTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

const SAVANT_BASE = "https://baseballsavant.mlb.com/leaderboard/custom";
const MLB_API = "https://statsapi.mlb.com/api/v1";
const STATCAST_LAST_SYNC_KEY = "statcast_last_sync";

// wOBA scale constant (FanGraphs "Guts"), used to convert a wOBA delta into runs for the
// wRC+ estimate. This is the ONLY hardcoded sabermetric constant; it drifts slightly year
// to year (~1.15–1.30) and should be updated per season. Because our wRC+ is anchored to a
// league wOBA computed from real data, this constant only affects the SPREAD around 100, not
// the center — so an approximate value still yields sensible, correctly-ordered ratings.
const WOBA_SCALE = 1.24;

// Columns requested from the Savant custom leaderboard (keyed by MLB player_id).
const SAVANT_SELECTIONS = [
  "pa",
  "exit_velocity_avg",
  "launch_angle_avg",
  "barrel_batted_rate",
  "hard_hit_percent",
  "xba",
  "xslg",
  "xwoba",
  "woba",
  "xiso",
  "isolated_power",
  "babip",
  "sprint_speed",
  "pull_percent",
  "straightaway_percent",
  "opposite_percent",
].join(",");

export interface StatcastSyncResult {
  playersUpdated: number;
  statcastUpserted: number;
  missing: number;
  leagueWoba: number | null;
  leagueRunsPerPa: number | null;
  skipped?: boolean;
}

let statcastSyncInProgress = false;

function currentSeason(): number {
  return new Date().getUTCFullYear();
}

// Parse a single CSV line honoring double-quoted fields. Savant quotes the
// "last_name, first_name" column, which itself contains a comma.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Savant returns rate stats as strings like ".270" / "0.285" and percentages as whole
// numbers like "57.3". Returns a finite number or null.
function num(v: string | undefined): number | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === "" || t.toLowerCase() === "null") return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

type SavantRow = Record<string, string>;

async function fetchSavant(season: number): Promise<SavantRow[]> {
  const url =
    `${SAVANT_BASE}?year=${season}&type=batter&filter=&min=1` +
    `&selections=${SAVANT_SELECTIONS}&sort=xwoba&sortDir=desc&csv=true`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (TripleCrownAI)" } });
  if (!res.ok) throw new Error(`Baseball Savant ${res.status} for statcast leaderboard`);
  const text = await res.text();
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]!).map((h) => h.replace(/^"|"$/g, "").trim());
  const rows: SavantRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]!);
    const row: SavantRow = {};
    header.forEach((h, idx) => {
      row[h] = cells[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

// League runs per plate appearance, summed from all 30 teams' real season hitting totals.
async function fetchLeagueRunsPerPa(season: number): Promise<number | null> {
  try {
    const res = await fetch(`${MLB_API}/teams/stats?season=${season}&stats=season&group=hitting&sportId=1`);
    if (!res.ok) return null;
    const j = (await res.json()) as {
      stats?: Array<{ splits?: Array<{ stat?: { runs?: number; plateAppearances?: number } }> }>;
    };
    const splits = j.stats?.[0]?.splits ?? [];
    let runs = 0;
    let pa = 0;
    for (const s of splits) {
      runs += s.stat?.runs ?? 0;
      pa += s.stat?.plateAppearances ?? 0;
    }
    return pa > 0 ? runs / pa : null;
  } catch {
    return null;
  }
}

// Fetch real Baseball Savant Statcast for every tracked hitter and refresh the statcast table
// plus each player's advanced metrics (ISO, BABIP, wRC+ estimate). Guarded so overlapping
// runs can't collide. Resilient: a Savant failure leaves existing values untouched, and a
// per-column null never overwrites a previously-synced real value.
export async function syncStatcast(): Promise<StatcastSyncResult> {
  if (statcastSyncInProgress) {
    logger.info("Statcast sync already in progress, skipping duplicate run");
    return { playersUpdated: 0, statcastUpserted: 0, missing: 0, leagueWoba: null, leagueRunsPerPa: null, skipped: true };
  }
  statcastSyncInProgress = true;
  try {
    return await runStatcastSync();
  } finally {
    statcastSyncInProgress = false;
  }
}

async function runStatcastSync(): Promise<StatcastSyncResult> {
  const season = currentSeason();
  let rows = await fetchSavant(season);
  // Fall back to last season if the current one has no leaderboard yet (offseason / preseason).
  if (rows.length === 0) rows = await fetchSavant(season - 1);
  if (rows.length === 0) {
    logger.warn("Statcast sync: Baseball Savant returned no rows; leaving existing values untouched");
    return { playersUpdated: 0, statcastUpserted: 0, missing: 0, leagueWoba: null, leagueRunsPerPa: null };
  }

  // League wOBA = PA-weighted mean across every batter on the leaderboard (real, non-pitchers).
  let wobaWeighted = 0;
  let wobaPa = 0;
  const byMlbId = new Map<number, SavantRow>();
  for (const r of rows) {
    const mlbId = num(r["player_id"]);
    if (mlbId != null) byMlbId.set(mlbId, r);
    const w = num(r["woba"]);
    const pa = num(r["pa"]);
    if (w != null && pa != null && pa > 0) {
      wobaWeighted += w * pa;
      wobaPa += pa;
    }
  }
  const leagueWoba = wobaPa > 0 ? wobaWeighted / wobaPa : null;
  const leagueRunsPerPa = await fetchLeagueRunsPerPa(season);

  const players = await db
    .select({
      id: playersTable.id,
      mlbId: playersTable.mlbId,
      name: playersTable.name,
      slg: playersTable.slg,
      battingAvg: playersTable.battingAvg,
    })
    .from(playersTable)
    .where(sql`${playersTable.mlbId} IS NOT NULL`);

  let statcastUpserted = 0;
  let playersUpdated = 0;
  let missing = 0;

  const fx = (n: number | null, d: number): string | null => (n == null ? null : n.toFixed(d));
  // Whole-number percent -> 0-1 decimal, to match the probability.ts consumers.
  const pct = (n: number | null): string | null => (n == null ? null : (n / 100).toFixed(3));

  for (const p of players) {
    if (p.mlbId == null) continue;
    const r = byMlbId.get(p.mlbId);
    if (!r) {
      missing += 1;
      logger.warn({ player: p.name, mlbId: p.mlbId }, "Statcast sync: player not on Savant leaderboard, preserving prior values");
      continue;
    }

    const scValues = {
      playerId: p.id,
      exitVelocityAvg: fx(num(r["exit_velocity_avg"]), 2),
      launchAngleAvg: fx(num(r["launch_angle_avg"]), 2),
      hardHitRate: pct(num(r["hard_hit_percent"])),
      barrelRate: pct(num(r["barrel_batted_rate"])),
      xba: fx(num(r["xba"]), 3),
      xslg: fx(num(r["xslg"]), 3),
      xwoba: fx(num(r["xwoba"]), 3),
      woba: fx(num(r["woba"]), 3),
      xiso: fx(num(r["xiso"]), 3),
      sprintSpeed: fx(num(r["sprint_speed"]), 2),
      pullRate: pct(num(r["pull_percent"])),
      centerRate: pct(num(r["straightaway_percent"])),
      oppositeRate: pct(num(r["opposite_percent"])),
    };

    // coalesce(excluded.col, existing) so a null in this run never wipes a prior real value.
    await db
      .insert(statcastTable)
      .values(scValues)
      .onConflictDoUpdate({
        target: statcastTable.playerId,
        set: {
          exitVelocityAvg: sql`coalesce(excluded.exit_velocity_avg, ${statcastTable.exitVelocityAvg})`,
          launchAngleAvg: sql`coalesce(excluded.launch_angle_avg, ${statcastTable.launchAngleAvg})`,
          hardHitRate: sql`coalesce(excluded.hard_hit_rate, ${statcastTable.hardHitRate})`,
          barrelRate: sql`coalesce(excluded.barrel_rate, ${statcastTable.barrelRate})`,
          xba: sql`coalesce(excluded.xba, ${statcastTable.xba})`,
          xslg: sql`coalesce(excluded.xslg, ${statcastTable.xslg})`,
          xwoba: sql`coalesce(excluded.xwoba, ${statcastTable.xwoba})`,
          woba: sql`coalesce(excluded.woba, ${statcastTable.woba})`,
          xiso: sql`coalesce(excluded.xiso, ${statcastTable.xiso})`,
          sprintSpeed: sql`coalesce(excluded.sprint_speed, ${statcastTable.sprintSpeed})`,
          pullRate: sql`coalesce(excluded.pull_rate, ${statcastTable.pullRate})`,
          centerRate: sql`coalesce(excluded.center_rate, ${statcastTable.centerRate})`,
          oppositeRate: sql`coalesce(excluded.opposite_rate, ${statcastTable.oppositeRate})`,
          updatedAt: new Date(),
        },
      });
    statcastUpserted += 1;

    // Advanced metrics on the player row.
    // ISO: prefer Savant isolated_power; fall back to SLG - AVG from the real season line.
    let iso = num(r["isolated_power"]);
    if (iso == null && p.slg != null && p.battingAvg != null) {
      iso = parseFloat(p.slg) - parseFloat(p.battingAvg);
    }
    const babip = num(r["babip"]);
    // wRC+ (park-neutral estimate) from real wOBA + real league constants.
    const woba = num(r["woba"]);
    let wrcPlus: number | null = null;
    if (woba != null && leagueWoba != null && leagueRunsPerPa != null && leagueRunsPerPa > 0) {
      wrcPlus = Math.round(100 + ((woba - leagueWoba) / (WOBA_SCALE * leagueRunsPerPa)) * 100);
    }

    const updates: { iso?: string; babip?: string; wrcPlus?: number; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (iso != null) updates.iso = iso.toFixed(3);
    if (babip != null) updates.babip = babip.toFixed(3);
    if (wrcPlus != null) updates.wrcPlus = wrcPlus;
    if (updates.iso !== undefined || updates.babip !== undefined || updates.wrcPlus !== undefined) {
      await db.update(playersTable).set(updates).where(eq(playersTable.id, p.id));
      playersUpdated += 1;
    }
  }

  // Mark fresh only after a successful batch fetch + upsert.
  const now = new Date().toISOString();
  await db
    .insert(appMetaTable)
    .values({ key: STATCAST_LAST_SYNC_KEY, value: now })
    .onConflictDoUpdate({ target: appMetaTable.key, set: { value: now, updatedAt: new Date() } });

  logger.info(
    { statcastUpserted, playersUpdated, missing, leagueWoba, leagueRunsPerPa, season },
    "Statcast + advanced metrics sync complete",
  );
  return { playersUpdated, statcastUpserted, missing, leagueWoba, leagueRunsPerPa };
}
