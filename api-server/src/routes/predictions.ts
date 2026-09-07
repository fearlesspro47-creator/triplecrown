import { Router } from "express";
import { todayEastern } from "../lib/dates";
import { db, predictionsTable, playersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getMembership } from "../lib/membership";

const router = Router();

function parsePrediction(p: typeof predictionsTable.$inferSelect) {
  return {
    ...p,
    value: parseFloat(p.value),
    confidence: parseFloat(p.confidence),
    gameId: p.gameId ?? null,
    factors: p.factors ?? [],
  };
}

router.get("/", async (req, res) => {
  try {
    const { date, playerId } = req.query as Record<string, string>;
    const today = date || todayEastern();
    const conditions: any[] = [eq(predictionsTable.date, today)];
    if (playerId) conditions.push(eq(predictionsTable.playerId, parseInt(playerId)));

    const preds = await db
      .select()
      .from(predictionsTable)
      .where(and(...conditions))
      .orderBy(desc(predictionsTable.value));

    // The composite Crown/HR Score is a paid metric — never expose the raw
    // hr_score prediction value to non-members via this public endpoint.
    const { isMember } = await getMembership(req);
    const visible = isMember
      ? preds
      : preds.filter((p) => p.predictionType !== "hr_score");

    res.json(visible.map(parsePrediction));
  } catch (err) {
    req.log.error({ err }, "Failed to list predictions");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/simulate", async (req, res) => {
  try {
    const { playerId, gameId, simulations } = req.body;
    const n = Math.min(simulations || 1000, 10000);

    const [player] = await db.select().from(playersTable).where(eq(playersTable.id, playerId));
    const baseHrRate = player?.hrRate ? parseFloat(player.hrRate) : 0.04;
    const parkFactor = 0.9 + Math.random() * 0.3;
    const weatherBoost = 1 + (Math.random() - 0.4) * 0.1;
    const adjustedRate = baseHrRate * parkFactor * weatherBoost;

    const atBatsPerGame = 4;
    let hrGames = 0;
    let hitGames = 0;

    for (let sim = 0; sim < n; sim++) {
      let hadHr = false;
      let hadHit = false;
      for (let ab = 0; ab < atBatsPerGame; ab++) {
        if (Math.random() < adjustedRate) hadHr = true;
        if (Math.random() < 0.28) hadHit = true;
      }
      if (hadHr) hrGames++;
      if (hadHit) hitGames++;
    }

    const hrProbability = hrGames / n;
    const hitProbability = hitGames / n;

    res.json({
      playerId,
      gameId,
      hrProbability,
      hitProbability,
      simulations: n,
      percentileHrs: {
        p10: Math.max(0, hrProbability - 0.15),
        p25: Math.max(0, hrProbability - 0.08),
        p50: hrProbability,
        p75: Math.min(1, hrProbability + 0.08),
        p90: Math.min(1, hrProbability + 0.15),
      },
      factors: [
        `Park factor: ${parkFactor.toFixed(2)}x`,
        `Weather boost: ${weatherBoost > 1 ? "+" : ""}${((weatherBoost - 1) * 100).toFixed(1)}%`,
        `Base HR rate: ${(baseHrRate * 100).toFixed(1)}%`,
        `Adjusted rate: ${(adjustedRate * 100).toFixed(1)}%`,
        `${n.toLocaleString()} simulations run`,
      ],
    });
  } catch (err) {
    req.log.error({ err }, "Failed to run simulation");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
