import { Router } from "express";
import { todayEastern } from "../lib/dates";
import { db, oddsTable, gamesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const date = (req.query.date as string) || todayEastern();
    const games = await db.select().from(gamesTable).where(eq(gamesTable.gameDate, date));
    const allOdds = await db.select().from(oddsTable);

    const oddsMap = new Map<number, typeof allOdds>();
    for (const o of allOdds) {
      if (!oddsMap.has(o.gameId)) oddsMap.set(o.gameId, []);
      oddsMap.get(o.gameId)!.push(o);
    }

    const result = games.map((g) => {
      const bookmakers = (oddsMap.get(g.id) || []).map((o) => ({
        bookmaker: o.bookmaker,
        homeML: parseFloat(o.homeML),
        awayML: parseFloat(o.awayML),
        overUnder: o.overUnder ? parseFloat(o.overUnder) : null,
        spread: o.spread ? parseFloat(o.spread) : null,
      }));

      const homeMLs = bookmakers.map((b) => b.homeML).filter(Boolean);
      const awayMLs = bookmakers.map((b) => b.awayML).filter(Boolean);
      const ous = bookmakers.map((b) => b.overUnder).filter((x): x is number => x !== null);

      return {
        gameId: g.id,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        gameTime: g.gameTime,
        bookmakers,
        consensusHomeML: homeMLs.length ? homeMLs.reduce((a, b) => a + b, 0) / homeMLs.length : null,
        consensusAwayML: awayMLs.length ? awayMLs.reduce((a, b) => a + b, 0) / awayMLs.length : null,
        overUnder: ous.length ? ous.reduce((a, b) => a + b, 0) / ous.length : null,
      };
    });

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to list odds");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
