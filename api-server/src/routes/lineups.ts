import { Router } from "express";
import { todayEastern } from "../lib/dates";
import { db, playersTable, predictionsTable, weatherTable, gamesTable, gameLogsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireActiveMembership } from "../lib/membership";
import { syncMlbGameLogs } from "../lib/mlbSync";
import { syncDailySchedule } from "../lib/mlbScheduleSync";
import { syncPitcherArsenal } from "../lib/pitcherArsenalSync";
import {
  parkFactorFor,
  hasPlatoonAdvantage,
  computeHitProbability,
  computeHrProbability,
  EXPECTED_ABS,
} from "../lib/probability";

const router = Router();

// Deterministic pseudo-random generator so rolling hit rates are stable per player across refreshes.
function seededRandom(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Build a deterministic 30-game hit/no-hit sequence (index 0 = most recent game).
// Each game is a Bernoulli draw around the player's per-game hit rate; the most recent
// ~7 games share a persistent form drift so short windows can coherently run hot/cold.
// Deriving all windows from one sequence keeps last-7 ⊂ last-14 ⊂ last-30 statistically consistent.
function recentGameLog(playerId: number, gameHitRate: number): boolean[] {
  const formDrift = (seededRandom(playerId * 131 + 1) - 0.5) * 0.28;
  const log: boolean[] = [];
  for (let i = 0; i < 30; i++) {
    const drift = i < 7 ? formDrift : 0;
    const p = Math.min(0.98, Math.max(0.05, gameHitRate + drift));
    log.push(seededRandom(playerId * 1000 + i * 17 + 3) < p);
  }
  return log;
}

const SALARY_BASE: Record<string, number> = {
  "Aaron Judge": 5800,
  "Shohei Ohtani": 5600,
  "Yordan Alvarez": 5400,
  "Matt Olson": 5200,
  "Pete Alonso": 5100,
  "Gunnar Henderson": 5000,
  "Bryce Harper": 4900,
  "Jose Ramirez": 4800,
  "Corey Seager": 4700,
  "Kyle Tucker": 4600,
  "Freddie Freeman": 4500,
  "Rafael Devers": 4400,
  "Vladimir Guerrero Jr.": 4300,
  "Julio Rodriguez": 4200,
  "Adley Rutschman": 4000,
};

const SALARY_CAP = 50000;

router.get("/optimize", requireActiveMembership, async (req, res) => {
  try {
    const { gameId, contestType = "classic" } = req.query as Record<string, string>;
    const today = todayEastern();

    const players = await db
      .select()
      .from(playersTable)
      .where(eq(playersTable.isActive, true));

    const predictions = await db
      .select()
      .from(predictionsTable)
      .where(and(eq(predictionsTable.predictionType, "hr"), eq(predictionsTable.date, today)));

    const weatherRows = await db.select().from(weatherTable);
    const weatherByGame = new Map(weatherRows.map((w) => [w.gameId, w]));
    const games = await db.select().from(gamesTable).where(eq(gamesTable.gameDate, today));

    const predMap = new Map(predictions.map((p) => [p.playerId, parseFloat(p.value)]));

    // Real per-game batting results from the MLB Stats API (synced nightly), newest first.
    const gameLogs = await db
      .select()
      .from(gameLogsTable)
      .orderBy(desc(gameLogsTable.gameDate));
    const logsByPlayer = new Map<number, typeof gameLogs>();
    for (const g of gameLogs) {
      const arr = logsByPlayer.get(g.playerId) ?? [];
      arr.push(g);
      logsByPlayer.set(g.playerId, arr);
    }

    interface PickData {
      playerId: number;
      playerName: string;
      team: string;
      teamAbbr: string;
      position: string;
      opponent: string | null;
      pitcherHandedness: string | null;
      gameTime: string | null;
      salary: number;
      hrProbability: number;
      hitProbability: number;
      hitRate7: number;
      hitRate14: number;
      hitRate30: number;
      hits7: number;
      hits14: number;
      hits30: number;
      hitRateSource: "live" | "model";
      form: "hot" | "cold" | "steady";
      matchupScore: number;
      weatherImpact: number;
      parkFactor: number;
      valueScore: number;
      compositeScore: number;
      recommendation: "must-play" | "consider" | "avoid";
      factors: string[];
      rank: number;
      projectedPoints: number;
      handedness: string | null;
      homeRuns: number | null;
      battingAvg: number | null;
      ops: number | null;
      exitVelocityAvg: number | null;
      barrelRate: number | null;
    }

    const picks: PickData[] = players.map((p) => {
      const handedness = p.handedness ?? "R";

      // Real matchup for today: opponent, ballpark, opposing probable pitcher hand, start time.
      const game = games.find(
        (g) => g.homeTeamAbbr === p.teamAbbr || g.awayTeamAbbr === p.teamAbbr
      );
      const isHome = game?.homeTeamAbbr === p.teamAbbr;
      const opponent = game ? (isHome ? game.awayTeamAbbr : game.homeTeamAbbr) : null;
      const gameTime = game?.gameTime ?? null;
      const pitcherHandedness = game
        ? (isHome ? game.awayPitcherHand : game.homePitcherHand) ?? null
        : null;
      const parkFactor = parkFactorFor(game?.homeTeamAbbr ?? p.teamAbbr);

      const weather = game ? weatherByGame.get(game.id) : null;
      const weatherHrBoost = weather ? parseFloat(weather.hrBoostFactor) : 1;
      const weatherImpact = (weatherHrBoost - 1.0) * 10;

      const parsedBA = p.battingAvg ? parseFloat(p.battingAvg) : 0.26;
      const rawBA = Number.isFinite(parsedBA) ? parsedBA : 0.26;
      const parsedHrRate = p.hrRate ? parseFloat(p.hrRate) : 0.04;

      // HR probability comes from the daily prediction sync; deterministic model fallback for
      // any player without a synced prediction (e.g. an off day).
      const hrProb =
        predMap.get(p.id) ??
        computeHrProbability({ hrRate: parsedHrRate, parkFactor, weatherHrBoost });

      const handednessBonus = hasPlatoonAdvantage(handedness, pitcherHandedness) ? 5 : 0;

      const hitProbability = computeHitProbability({
        battingAvg: rawBA,
        batterHand: handedness,
        pitcherHand: pitcherHandedness,
        parkFactor,
        weatherHrBoost,
      });
      const expectedABs = EXPECTED_ABS;

      // Rolling historical hit rate: % of recent games with at least one hit.
      // Prefer real MLB game-log data; fall back to the deterministic model when a
      // player has fewer than a full 30-game window synced.
      const liveLogs = logsByPlayer.get(p.id) ?? [];
      let hits7: number, hits14: number, hits30: number;
      let hitRate7: number, hitRate14: number, hitRate30: number;
      let hitRateSource: "live" | "model";
      if (liveLogs.length >= 30) {
        const liveHits = (n: number) => liveLogs.slice(0, n).filter((g) => g.hadHit).length;
        hits7 = liveHits(7);
        hits14 = liveHits(14);
        hits30 = liveHits(30);
        hitRate7 = hits7 / 7;
        hitRate14 = hits14 / 14;
        hitRate30 = hits30 / 30;
        hitRateSource = "live";
      } else {
        const seasonGameHitRate = 1 - Math.pow(1 - rawBA, expectedABs);
        const gameLog = recentGameLog(p.id, seasonGameHitRate);
        const countHits = (n: number) => gameLog.slice(0, n).filter(Boolean).length;
        hits7 = countHits(7);
        hits14 = countHits(14);
        hits30 = countHits(30);
        hitRate7 = hits7 / 7;
        hitRate14 = hits14 / 14;
        hitRate30 = hits30 / 30;
        hitRateSource = "model";
      }
      const formDiff = hitRate7 - hitRate30;
      const form: "hot" | "cold" | "steady" =
        formDiff >= 0.12 ? "hot" : formDiff <= -0.12 ? "cold" : "steady";

      const matchupScore = Math.min(
        100,
        50 +
          (hrProb - 0.2) * 100 +
          (parkFactor - 1.0) * 80 +
          weatherImpact * 2 +
          handednessBonus
      );

      const salary = SALARY_BASE[p.name] ?? 3800 + Math.floor(Math.random() * 800);
      // Projected DFS pts: HRs (4.2pts) + hits (3pts) + runs/RBI rough estimate
      const projectedPoints =
        hrProb * 12.6 +
        hitProbability * 3.0 +
        (p.battingAvg ? parseFloat(p.battingAvg) : 0.27) * 1.5 +
        0.5;
      const valueScore = (projectedPoints / salary) * 1000;

      const compositeScore = Math.min(
        100,
        hrProb * 45 + hitProbability * 25 + matchupScore * 0.15 + valueScore * 8 + weatherImpact * 1.5
      );

      const recommendation: "must-play" | "consider" | "avoid" =
        compositeScore >= 35 ? "must-play" : compositeScore >= 27 ? "consider" : "avoid";

      const factors: string[] = [];
      if (hrProb >= 0.35) factors.push(`Elite HR probability: ${(hrProb * 100).toFixed(1)}%`);
      if (hitProbability >= 0.75) factors.push(`High hit probability: ${(hitProbability * 100).toFixed(1)}%`);
      if (parkFactor > 1.05) factors.push(`Hitter-friendly park (${((parkFactor - 1) * 100).toFixed(0)}% boost)`);
      if (weatherImpact > 0.5) factors.push(`Wind blowing out (+${weatherImpact.toFixed(1)} impact)`);
      if (weatherImpact < -0.5) factors.push(`Wind blowing in (${weatherImpact.toFixed(1)} impact)`);
      if (handednessBonus > 0) factors.push(`Platoon advantage vs ${pitcherHandedness}HP`);
      if (valueScore > 8) factors.push(`Strong value at $${salary.toLocaleString()}`);
      if (rawBA >= 0.29) factors.push(`Elite contact: .${Math.round(rawBA * 1000)} BA`);

      return {
        playerId: p.id,
        playerName: p.name,
        team: p.team,
        teamAbbr: p.teamAbbr ?? "",
        position: p.position,
        opponent,
        pitcherHandedness,
        gameTime,
        salary,
        hrProbability: hrProb,
        hitProbability,
        hitRate7,
        hitRate14,
        hitRate30,
        hits7,
        hits14,
        hits30,
        hitRateSource,
        form,
        matchupScore,
        weatherImpact,
        parkFactor,
        valueScore,
        compositeScore,
        recommendation,
        factors,
        rank: 0,
        projectedPoints,
        handedness,
        homeRuns: p.homeRuns ?? null,
        battingAvg: rawBA,
        ops: p.ops ? parseFloat(p.ops) : null,
        exitVelocityAvg: null,
        barrelRate: null,
      };
    });

    const sorted = picks
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .map((pick, i) => ({ ...pick, rank: i + 1 }));

    const totalSalaryUsed = sorted
      .filter((p) => p.recommendation === "must-play")
      .slice(0, 6)
      .reduce((sum, p) => sum + p.salary, 0);

    const projectedScore = sorted
      .filter((p) => p.recommendation === "must-play")
      .slice(0, 6)
      .reduce((sum, p) => sum + p.projectedPoints, 0);

    res.json({
      contestType,
      date: today,
      picks: sorted,
      totalSalaryUsed,
      projectedScore,
      salaryCap: SALARY_CAP,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to optimize lineup");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Manually trigger a refresh of MLB game-log data. Disabled in production so it can't be
// abused to hammer the MLB API / DB; the nightly scheduler handles production refreshes.
router.post("/sync", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(403).json({ error: "Manual sync is disabled in production" });
    return;
  }
  try {
    const [gameLogs, schedule, arsenal] = await Promise.all([
      syncMlbGameLogs(),
      syncDailySchedule(),
      syncPitcherArsenal(),
    ]);
    res.json({ ok: true, gameLogs, schedule, arsenal });
  } catch (err) {
    req.log.error({ err }, "Manual MLB sync failed");
    res.status(500).json({ error: "Sync failed" });
  }
});

export default router;
