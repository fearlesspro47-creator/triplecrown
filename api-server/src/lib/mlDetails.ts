import { db, hrPredictionDetailsTable } from "@workspace/db";
import type { HrScoreComponent, CrownComponent, ShapReason } from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";

// The Python scorer writes the renormalized `effectiveWeight` onto each crown component at
// runtime; the typed jsonb (CrownComponent) only declares the nominal fields, so read it loosely.
type StoredCrownComponent = CrownComponent & { effectiveWeight?: number };

// Rich ML output for one hitter on one day, resolved from `hr_prediction_details`.
export interface MlPickDetail {
  hrProbability: number; // calibrated 0-1
  crownScore: number; // 0-100
  confidenceScore: number | null; // 0-1
  confidenceGrade: string | null; // A+ .. D
  ciLow: number | null;
  ciHigh: number | null;
  dataCompleteness: number | null;
  crownComponents: HrScoreComponent[] | null;
  reasons: ShapReason[] | null;
  modelVersion: string;
}

// Map the ML Crown Score component (value01 normalized) onto the app's HrScoreComponent wire
// shape so the existing AIReasoningChecklist renders ML-driven picks with zero UI changes.
function toHrScoreComponent(c: StoredCrownComponent): HrScoreComponent {
  return {
    key: c.key,
    label: c.label,
    weight: c.weight,
    effectiveWeight: c.effectiveWeight ?? (c.available ? c.weight : 0),
    raw: null,
    normalized: c.value01,
    points: c.points,
    available: c.available,
  };
}

// Fetch the latest ML detail per player for a date. Empty map (graceful heuristic fallback) when
// the scorer hasn't run for that date yet.
export async function fetchMlDetailsByPlayer(
  date: string,
  playerIds?: number[],
): Promise<Map<number, MlPickDetail>> {
  const conds = [eq(hrPredictionDetailsTable.date, date)];
  if (playerIds && playerIds.length) {
    conds.push(inArray(hrPredictionDetailsTable.playerId, playerIds));
  }
  // Order oldest-first so that if a player somehow has multiple model-version rows for the date,
  // the most recent row deterministically wins the Map (later set() overwrites earlier).
  const rows = await db
    .select()
    .from(hrPredictionDetailsTable)
    .where(and(...conds))
    .orderBy(asc(hrPredictionDetailsTable.createdAt));

  const map = new Map<number, MlPickDetail>();
  for (const r of rows) {
    const comps = r.crownComponents as StoredCrownComponent[] | null;
    map.set(r.playerId, {
      hrProbability: parseFloat(r.hrProbability),
      crownScore: parseFloat(r.crownScore),
      confidenceScore: r.confidenceScore != null ? parseFloat(r.confidenceScore) : null,
      confidenceGrade: r.confidenceGrade ?? null,
      ciLow: r.ciLow != null ? parseFloat(r.ciLow) : null,
      ciHigh: r.ciHigh != null ? parseFloat(r.ciHigh) : null,
      dataCompleteness: r.dataCompleteness != null ? parseFloat(r.dataCompleteness) : null,
      crownComponents: comps ? comps.map(toHrScoreComponent) : null,
      reasons: (r.shapReasons as ShapReason[] | null) ?? null,
      modelVersion: r.modelVersion,
    });
  }
  return map;
}
