import { Router } from "express";
import { todayEastern } from "../lib/dates";
import { db, weatherTable, gamesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

function parseWeather(w: typeof weatherTable.$inferSelect) {
  return {
    ...w,
    temperature: parseFloat(w.temperature),
    feelsLike: w.feelsLike ? parseFloat(w.feelsLike) : null,
    humidity: w.humidity ? parseFloat(w.humidity) : null,
    windSpeed: parseFloat(w.windSpeed),
    windDeg: w.windDeg ? parseFloat(w.windDeg) : null,
    hrBoostFactor: parseFloat(w.hrBoostFactor),
    rainProbability: w.rainProbability ? parseFloat(w.rainProbability) : null,
  };
}

router.get("/", async (req, res) => {
  try {
    // Scope to today's games so stale prior-day ballparks never leak in (weather rows are
    // inserted per game and never deleted). Optional ?date= override for parity with /games.
    const date = (req.query.date as string) || todayEastern();
    const rows = await db
      .select({ w: weatherTable })
      .from(weatherTable)
      .innerJoin(gamesTable, eq(weatherTable.gameId, gamesTable.id))
      .where(eq(gamesTable.gameDate, date));
    res.json(rows.map((r) => parseWeather(r.w)));
  } catch (err) {
    req.log.error({ err }, "Failed to list weather");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:gameId", async (req, res) => {
  try {
    const gameId = parseInt(req.params.gameId);
    const [w] = await db.select().from(weatherTable).where(eq(weatherTable.gameId, gameId));
    if (!w) {
      res.status(404).json({ error: "Weather not found" });
      return;
    }
    res.json(parseWeather(w));
  } catch (err) {
    req.log.error({ err }, "Failed to get game weather");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
