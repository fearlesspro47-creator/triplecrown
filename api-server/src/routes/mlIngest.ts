import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  db,
  hrPredictionDetailsTable,
  batterPitchMixTable,
  playersTable,
  gamesTable,
} from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";

const router = Router();

// Numeric columns are drizzle `numeric` (string mode). Accept number|string from the
// pusher and normalize to string so drizzle stores them without float drift.
const numStr = z
  .union([z.number(), z.string()])
  .transform((v: number | string) => String(v))
  .refine((s: string) => /^-?\d+(\.\d+)?$/.test(s), {
    message: "must be a numeric string",
  });
const nullableNumStr = numStr.nullable().optional();

// One ML output row, keyed by NATURAL keys (mlb_id / mlb_game_pk) — NOT dev serial ids.
// Dev and prod grew independently, so serial ids do not align; the route resolves the
// local serial ids from these natural keys before upserting.
const rowSchema = z.object({
  playerMlbId: z.number().int(),
  gameMlbPk: z.number().int().nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // yyyy-mm-dd
  modelRunId: z.uuid().nullable().optional(), // uuid column — validate to avoid a mid-batch cast 500
  modelVersion: z.string().min(1),
  hrProbability: numStr,
  crownScore: numStr,
  confidenceScore: nullableNumStr,
  confidenceGrade: z.string().nullable().optional(),
  ciLow: nullableNumStr,
  ciHigh: nullableNumStr,
  dataCompleteness: nullableNumStr,
  featureVector: z.record(z.string(), z.union([z.number(), z.null()])).nullable().optional(),
  shapReasons: z.array(z.unknown()).nullable().optional(),
  crownComponents: z.array(z.unknown()).nullable().optional(),
  weatherSnapshot: z.unknown().nullable().optional(),
  valueEdge: nullableNumStr,
});

const bodySchema = z.object({
  rows: z.array(rowSchema).min(1).max(1000),
});

// Explicit shape of a validated row. Zod v4's inference widens this deeply-transformed
// schema to `unknown`, so we pin the type and cast the runtime-validated payload.
type IngestRow = {
  playerMlbId: number;
  gameMlbPk?: number | null;
  date: string;
  modelRunId?: string | null;
  modelVersion: string;
  hrProbability: string;
  crownScore: string;
  confidenceScore?: string | null;
  confidenceGrade?: string | null;
  ciLow?: string | null;
  ciHigh?: string | null;
  dataCompleteness?: string | null;
  featureVector?: Record<string, number | null> | null;
  shapReasons?: unknown[] | null;
  crownComponents?: unknown[] | null;
  weatherSnapshot?: unknown;
  valueEdge?: string | null;
};

// Constant-time compare of two arbitrary-length strings (hash first so length never leaks
// and timingSafeEqual never throws on a length mismatch).
function secretsMatch(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Shared shared-secret gate for the server-to-server ingest routes. Writes the error
// response and returns true when the request must be rejected; returns false when
// the caller may proceed. Disabled (503) until ML_INGEST_TOKEN is set; 401 on mismatch.
function ingestAuthRejected(
  req: import("express").Request,
  res: import("express").Response,
): boolean {
  const expected = process.env.ML_INGEST_TOKEN;
  if (!expected) {
    res.status(503).json({ error: "ml ingest disabled: ML_INGEST_TOKEN not set" });
    return true;
  }
  const provided = req.header("x-ml-ingest-token") ?? "";
  if (!secretsMatch(provided, expected)) {
    res.status(401).json({ error: "unauthorized" });
    return true;
  }
  return false;
}

// Secured server-to-server ingest for the offline Python ML output. Production runs no
// Python (Node-only deploy), so the scorer runs in the dev workspace and pushes its rows
// here; the deployed Node app has write access to the production DB and upserts them.
// Disabled (503) until ML_INGEST_TOKEN is set; 401 on a missing/wrong token.
router.post("/ingest", async (req, res) => {
  if (ingestAuthRejected(req, res)) return;

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body", issues: parsed.error.issues.slice(0, 5) });
  }
  const rows = parsed.data.rows as IngestRow[];

  // Resolve natural keys -> local serial ids in one query each.
  const mlbIds = [...new Set(rows.map((r) => r.playerMlbId))];
  const gamePks = [
    ...new Set(rows.map((r) => r.gameMlbPk).filter((v): v is number => v != null)),
  ];

  const players = await db
    .select({ id: playersTable.id, mlbId: playersTable.mlbId })
    .from(playersTable)
    .where(inArray(playersTable.mlbId, mlbIds));
  const playerIdByMlb = new Map(players.map((p) => [p.mlbId, p.id]));

  const games = gamePks.length
    ? await db
        .select({ id: gamesTable.id, pk: gamesTable.mlbGamePk })
        .from(gamesTable)
        .where(inArray(gamesTable.mlbGamePk, gamePks))
    : [];
  const gameIdByPk = new Map(games.map((g) => [g.pk, g.id]));

  let skippedUnknownPlayer = 0;
  let skippedUnknownGame = 0;
  const values = [];
  for (const r of rows) {
    const playerId = playerIdByMlb.get(r.playerMlbId);
    if (playerId == null) {
      skippedUnknownPlayer++;
      continue;
    }
    let gameId: number | null = null;
    if (r.gameMlbPk != null) {
      gameId = gameIdByPk.get(r.gameMlbPk) ?? null;
      if (gameId == null) skippedUnknownGame++;
    }
    values.push({
      playerId,
      gameId,
      date: r.date,
      modelRunId: r.modelRunId ?? null,
      modelVersion: r.modelVersion,
      hrProbability: r.hrProbability,
      crownScore: r.crownScore,
      confidenceScore: r.confidenceScore ?? null,
      confidenceGrade: r.confidenceGrade ?? null,
      ciLow: r.ciLow ?? null,
      ciHigh: r.ciHigh ?? null,
      dataCompleteness: r.dataCompleteness ?? null,
      featureVector: r.featureVector ?? null,
      shapReasons: (r.shapReasons ?? null) as never,
      crownComponents: (r.crownComponents ?? null) as never,
      weatherSnapshot: (r.weatherSnapshot ?? null) as never,
      valueEdge: r.valueEdge ?? null,
    });
  }

  let upserted = 0;
  if (values.length) {
    await db
      .insert(hrPredictionDetailsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [
          hrPredictionDetailsTable.playerId,
          hrPredictionDetailsTable.date,
          hrPredictionDetailsTable.modelVersion,
        ],
        set: {
          gameId: sql`excluded.game_id`,
          modelRunId: sql`excluded.model_run_id`,
          hrProbability: sql`excluded.hr_probability`,
          crownScore: sql`excluded.crown_score`,
          confidenceScore: sql`excluded.confidence_score`,
          confidenceGrade: sql`excluded.confidence_grade`,
          ciLow: sql`excluded.ci_low`,
          ciHigh: sql`excluded.ci_high`,
          dataCompleteness: sql`excluded.data_completeness`,
          featureVector: sql`excluded.feature_vector`,
          shapReasons: sql`excluded.shap_reasons`,
          crownComponents: sql`excluded.crown_components`,
          weatherSnapshot: sql`excluded.weather_snapshot`,
          valueEdge: sql`excluded.value_edge`,
        },
      });
    upserted = values.length;
  }

  req.log.info(
    {
      received: rows.length,
      upserted,
      skippedUnknownPlayer,
      skippedUnknownGame,
      date: rows[0]?.date,
      modelVersion: rows[0]?.modelVersion,
    },
    "ml ingest",
  );
  return res.json({ received: rows.length, upserted, skippedUnknownPlayer, skippedUnknownGame });
});

// ---------------------------------------------------------------------------------------
// Batter pitch-mix ingest
// ---------------------------------------------------------------------------------------
// `batter_pitch_mix` is produced ONLY by the offline Python job (services/ml/ml/pitch_mix.py)
// against the dev DB — production runs no Python, so (like the ML Crown Scores above) the
// only way this real, slow-changing season aggregate reaches prod is this secured push.
// Keyed by NATURAL keys (players.mlb_id) + season + pitch family; the route re-resolves the
// local serial player id and upserts on the unique (player_id, season, pitch_type).
const intCol = z.number().int();
const pitchMixRowSchema = z.object({
  playerMlbId: z.number().int(),
  season: z.number().int(),
  pitchType: z.string().min(1),
  pitchName: z.string().nullable().optional(),
  rawPitchTypes: z.string().nullable().optional(),
  pitchesSeen: intCol,
  plateAppearances: intCol,
  atBats: intCol,
  hits: intCol,
  singles: intCol,
  doubles: intCol,
  triples: intCol,
  homeRuns: intCol,
  strikeouts: intCol,
  walks: intCol,
  pitchUsage: nullableNumStr,
  avg: nullableNumStr,
  slg: nullableNumStr,
  iso: nullableNumStr,
  kRate: nullableNumStr,
  whiffRate: nullableNumStr,
  barrelRate: nullableNumStr,
  hardHitRate: nullableNumStr,
  avgExitVelocity: nullableNumStr,
});

const pitchMixBodySchema = z.object({
  rows: z.array(pitchMixRowSchema).min(1).max(2000),
});

type PitchMixIngestRow = {
  playerMlbId: number;
  season: number;
  pitchType: string;
  pitchName?: string | null;
  rawPitchTypes?: string | null;
  pitchesSeen: number;
  plateAppearances: number;
  atBats: number;
  hits: number;
  singles: number;
  doubles: number;
  triples: number;
  homeRuns: number;
  strikeouts: number;
  walks: number;
  pitchUsage?: string | null;
  avg?: string | null;
  slg?: string | null;
  iso?: string | null;
  kRate?: string | null;
  whiffRate?: string | null;
  barrelRate?: string | null;
  hardHitRate?: string | null;
  avgExitVelocity?: string | null;
};

router.post("/ingest-pitch-mix", async (req, res) => {
  if (ingestAuthRejected(req, res)) return;

  const parsed = pitchMixBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body", issues: parsed.error.issues.slice(0, 5) });
  }
  const rows = parsed.data.rows as PitchMixIngestRow[];

  const mlbIds = [...new Set(rows.map((r) => r.playerMlbId))];
  const players = await db
    .select({ id: playersTable.id, mlbId: playersTable.mlbId })
    .from(playersTable)
    .where(inArray(playersTable.mlbId, mlbIds));
  const playerIdByMlb = new Map(players.map((p) => [p.mlbId, p.id]));

  let skippedUnknownPlayer = 0;
  const values = [];
  for (const r of rows) {
    const playerId = playerIdByMlb.get(r.playerMlbId);
    if (playerId == null) {
      skippedUnknownPlayer++;
      continue;
    }
    values.push({
      playerId,
      season: r.season,
      pitchType: r.pitchType,
      pitchName: r.pitchName ?? null,
      rawPitchTypes: r.rawPitchTypes ?? null,
      pitchesSeen: r.pitchesSeen,
      plateAppearances: r.plateAppearances,
      atBats: r.atBats,
      hits: r.hits,
      singles: r.singles,
      doubles: r.doubles,
      triples: r.triples,
      homeRuns: r.homeRuns,
      strikeouts: r.strikeouts,
      walks: r.walks,
      pitchUsage: r.pitchUsage ?? null,
      avg: r.avg ?? null,
      slg: r.slg ?? null,
      iso: r.iso ?? null,
      kRate: r.kRate ?? null,
      whiffRate: r.whiffRate ?? null,
      barrelRate: r.barrelRate ?? null,
      hardHitRate: r.hardHitRate ?? null,
      avgExitVelocity: r.avgExitVelocity ?? null,
    });
  }

  let upserted = 0;
  if (values.length) {
    await db
      .insert(batterPitchMixTable)
      .values(values)
      .onConflictDoUpdate({
        target: [
          batterPitchMixTable.playerId,
          batterPitchMixTable.season,
          batterPitchMixTable.pitchType,
        ],
        set: {
          pitchName: sql`excluded.pitch_name`,
          rawPitchTypes: sql`excluded.raw_pitch_types`,
          pitchesSeen: sql`excluded.pitches_seen`,
          plateAppearances: sql`excluded.plate_appearances`,
          atBats: sql`excluded.at_bats`,
          hits: sql`excluded.hits`,
          singles: sql`excluded.singles`,
          doubles: sql`excluded.doubles`,
          triples: sql`excluded.triples`,
          homeRuns: sql`excluded.home_runs`,
          strikeouts: sql`excluded.strikeouts`,
          walks: sql`excluded.walks`,
          pitchUsage: sql`excluded.pitch_usage`,
          avg: sql`excluded.avg`,
          slg: sql`excluded.slg`,
          iso: sql`excluded.iso`,
          kRate: sql`excluded.k_rate`,
          whiffRate: sql`excluded.whiff_rate`,
          barrelRate: sql`excluded.barrel_rate`,
          hardHitRate: sql`excluded.hard_hit_rate`,
          avgExitVelocity: sql`excluded.avg_exit_velocity`,
        },
      });
    upserted = values.length;
  }

  req.log.info(
    { received: rows.length, upserted, skippedUnknownPlayer, season: rows[0]?.season },
    "pitch-mix ingest",
  );
  return res.json({ received: rows.length, upserted, skippedUnknownPlayer });
});

export default router;
