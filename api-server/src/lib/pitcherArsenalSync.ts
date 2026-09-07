import { db, pitcherArsenalTable, appMetaTable } from "@workspace/db";
import type { InsertPitcherArsenal } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "./logger";

// Baseball Savant's free pitch-arsenals leaderboard. `type=n_` returns per-pitcher USAGE
// PERCENTAGES per pitch (columns n_ff, n_si, ... summing ~100); `type=n` returns raw counts
// but comes back empty. No key required — same pattern as statcastSync's Savant CSV pull.
const SAVANT_ARSENAL = "https://baseballsavant.mlb.com/leaderboard/pitch-arsenals";
const LAST_SYNC_KEY = "pitcher_arsenal_last_sync";

// Human-readable family label per family code (same taxonomy as batter_pitch_mix).
const FAMILY_LABEL: Record<string, string> = {
  FF: "Four-Seam",
  SI: "Sinker",
  FC: "Cutter",
  SL: "Slider",
  CU: "Curveball",
  CH: "Changeup",
  FS: "Splitter",
  KN: "Knuckleball",
};

// Savant CSV usage column -> family code. Sweeper (st) and slurve (sv) fold into Slider (SL),
// matching how the batter pitch-mix job folds ST/SV into SL, so hitter SLG-vs-family lines up
// with pitcher usage-by-family for the matchup insight.
const COLUMN_FAMILY: Record<string, string> = {
  n_ff: "FF",
  n_si: "SI",
  n_fc: "FC",
  n_sl: "SL",
  n_st: "SL",
  n_sv: "SL",
  n_cu: "CU",
  n_ch: "CH",
  n_fs: "FS",
  n_kn: "KN",
};

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

function num(v: string | undefined): number | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === "" || t.toLowerCase() === "null") return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

type SavantRow = Record<string, string>;

async function fetchArsenal(season: number): Promise<SavantRow[]> {
  const url = `${SAVANT_ARSENAL}?year=${season}&min=1&type=n_&hand=&csv=true`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (TripleCrownAI)" } });
  if (!res.ok) throw new Error(`Baseball Savant ${res.status} for pitch arsenals`);
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

export interface PitcherArsenalSyncResult {
  pitchersUpserted: number;
  rowsWritten: number;
  skipped?: boolean;
}

let arsenalSyncInProgress = false;

// Fetch every pitcher's real pitch-usage arsenal from Baseball Savant and replace each
// processed pitcher's rows for the current season. Guarded against overlapping runs.
// Real-or-nothing: a failed/empty fetch throws before any write, leaving prior rows intact,
// and the freshness marker is only written on a successful run.
export async function syncPitcherArsenal(): Promise<PitcherArsenalSyncResult> {
  if (arsenalSyncInProgress) {
    logger.info("Pitcher arsenal sync already in progress, skipping duplicate run");
    return { pitchersUpserted: 0, rowsWritten: 0, skipped: true };
  }
  arsenalSyncInProgress = true;
  try {
    return await runArsenalSync();
  } finally {
    arsenalSyncInProgress = false;
  }
}

async function runArsenalSync(): Promise<PitcherArsenalSyncResult> {
  const season = currentSeason();
  // Current season only — a "throws X% four-seam" claim must be about this year, never a
  // prior-season fallback. If the leaderboard is empty (offseason), we write nothing.
  const rows = await fetchArsenal(season);
  if (rows.length === 0) {
    logger.warn("Pitcher arsenal sync: Savant returned no rows; leaving existing values untouched");
    return { pitchersUpserted: 0, rowsWritten: 0 };
  }

  const values: InsertPitcherArsenal[] = [];
  const processed = new Set<number>();
  for (const r of rows) {
    const mlbId = num(r["pitcher"]);
    if (mlbId == null) continue;
    // Fold the raw usage columns into families, summing folded columns (SL = sl + st + sv).
    const famUsage = new Map<string, number>();
    for (const [col, fam] of Object.entries(COLUMN_FAMILY)) {
      const v = num(r[col]);
      // A blank cell means the pitcher doesn't throw that pitch — skip it, never store a 0.
      if (v == null || v <= 0) continue;
      famUsage.set(fam, (famUsage.get(fam) ?? 0) + v);
    }
    if (famUsage.size === 0) continue;
    processed.add(mlbId);
    for (const [fam, pct] of famUsage) {
      values.push({
        pitcherMlbId: mlbId,
        season,
        pitchType: fam,
        pitchName: FAMILY_LABEL[fam] ?? fam,
        usage: (pct / 100).toFixed(4), // 0-1 decimal, repo convention
      });
    }
  }

  if (values.length === 0) {
    logger.warn("Pitcher arsenal sync: no usable rows parsed; leaving existing values untouched");
    return { pitchersUpserted: 0, rowsWritten: 0 };
  }

  const processedIds = [...processed];
  await db.transaction(async (tx) => {
    // Replace only the pitchers present in this run (delete-then-insert), so a partial slate
    // never nulls out a pitcher we didn't see this run.
    await tx
      .delete(pitcherArsenalTable)
      .where(
        and(
          eq(pitcherArsenalTable.season, season),
          inArray(pitcherArsenalTable.pitcherMlbId, processedIds),
        ),
      );
    // Chunk the insert to stay well under Postgres' bind-parameter limit.
    const CHUNK = 1000;
    for (let i = 0; i < values.length; i += CHUNK) {
      await tx.insert(pitcherArsenalTable).values(values.slice(i, i + CHUNK));
    }
  });

  const now = new Date().toISOString();
  await db
    .insert(appMetaTable)
    .values({ key: LAST_SYNC_KEY, value: now })
    .onConflictDoUpdate({ target: appMetaTable.key, set: { value: now, updatedAt: new Date() } });

  logger.info(
    { pitchersUpserted: processedIds.length, rowsWritten: values.length, season },
    "Pitcher arsenal sync complete",
  );
  return { pitchersUpserted: processedIds.length, rowsWritten: values.length };
}
