import { Router } from "express";
import { todayEastern } from "../lib/dates";
import { db, gamesTable, pitchersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const router = Router();

function num(v: string | null): number | null {
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

interface Matchup {
  gameId: number;
  team: string;
  opponent: string;
  gameTime: string;
  gameStatus: string;
  home: boolean;
}

// Pitchers page = today's probable STARTING pitchers with their up-to-date season line.
// Scope strictly to today's games so stale (other-day) pitchers never leak into the list.
router.get("/", async (req, res) => {
  try {
    const date = (req.query.date as string) || todayEastern();
    const games = await db.select().from(gamesTable).where(eq(gamesTable.gameDate, date));

    const matchupByMlbId = new Map<number, Matchup>();
    for (const g of games) {
      if (g.homePitcherMlbId != null) {
        matchupByMlbId.set(g.homePitcherMlbId, {
          gameId: g.id,
          team: g.homeTeamAbbr,
          opponent: g.awayTeamAbbr,
          gameTime: g.gameTime,
          gameStatus: g.status,
          home: true,
        });
      }
      if (g.awayPitcherMlbId != null) {
        matchupByMlbId.set(g.awayPitcherMlbId, {
          gameId: g.id,
          team: g.awayTeamAbbr,
          opponent: g.homeTeamAbbr,
          gameTime: g.gameTime,
          gameStatus: g.status,
          home: false,
        });
      }
    }

    const ids = [...matchupByMlbId.keys()];
    if (ids.length === 0) {
      res.json([]);
      return;
    }

    const rows = await db.select().from(pitchersTable).where(inArray(pitchersTable.mlbId, ids));

    const pitchers = rows.map((p) => {
      const m = matchupByMlbId.get(p.mlbId)!;
      // Average strikeouts per game: use games started (these are starters); fall back to games played.
      const denom = p.gamesStarted && p.gamesStarted > 0 ? p.gamesStarted : p.games ?? 0;
      const strikeoutsPerGame =
        p.strikeouts != null && denom > 0 ? Math.round((p.strikeouts / denom) * 10) / 10 : null;
      return {
        mlbId: p.mlbId,
        name: p.name,
        team: m.team || p.team || null,
        hand: p.hand ?? null,
        games: p.games ?? null,
        gamesStarted: p.gamesStarted ?? null,
        inningsPitched: p.inningsPitched ?? null,
        strikeouts: p.strikeouts ?? null,
        strikeoutsPerGame,
        era: num(p.era),
        whip: num(p.whip),
        k9: num(p.k9),
        hr9: num(p.hr9),
        wins: p.wins ?? null,
        losses: p.losses ?? null,
        avgAgainst: num(p.avgAgainst),
        gameId: m.gameId,
        opponent: m.opponent,
        gameTime: m.gameTime,
        gameStatus: m.gameStatus,
        home: m.home,
      };
    });

    // Rank by season strikeouts (nulls last).
    pitchers.sort((a, b) => (b.strikeouts ?? -1) - (a.strikeouts ?? -1));
    res.json(pitchers);
  } catch (err) {
    req.log.error({ err }, "Failed to list pitchers");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
