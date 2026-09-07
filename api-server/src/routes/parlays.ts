import { Router } from "express";
import { todayEastern, easternDateDaysAgo } from "../lib/dates";
import { db, playersTable, predictionsTable, gamesTable, gameLogsTable } from "@workspace/db";
import { eq, and, inArray, lt, gte, sql } from "drizzle-orm";
import { headshotUrl } from "../lib/headshot";
import { computeHrProbability, probabilityToAmericanOdds } from "../lib/probability";

const router = Router();

// A single leg returned by both parlay boards. Per-leg `americanOdds` are the app's OWN fair
// model price derived from the HR probability (no sportsbook margin) — the client groups legs
// into parlays and multiplies the decimal odds for the combined payout.
interface ParlayLeg {
  playerId: number;
  playerName: string;
  teamAbbr: string;
  avatarUrl: string | null;
  opponentAbbr: string | null;
  pitcher: string | null;
  detail: string;
  hrProbability: number;
  americanOdds: number;
}

// "Cooking Up" — today's elite danger batters. Each leg is a hitter on today's slate ranked by
// how many HRs they've hit over their last 10 game-days (real game logs), priced off today's
// modeled HR probability. Real-or-nothing: no slate / no hot bats -> [].
router.get("/cooking-up", async (req, res) => {
  try {
    const today = todayEastern();
    const preds = await db
      .select()
      .from(predictionsTable)
      .where(and(eq(predictionsTable.predictionType, "hr"), eq(predictionsTable.date, today)));

    if (preds.length === 0) {
      res.json([]);
      return;
    }

    const playerIds = [...new Set(preds.map((p) => p.playerId))];
    const gameIds = [...new Set(preds.map((p) => p.gameId).filter((g): g is number => g != null))];

    const playerRows = await db
      .select({
        id: playersTable.id,
        mlbId: playersTable.mlbId,
        teamAbbr: playersTable.teamAbbr,
        isActive: playersTable.isActive,
      })
      .from(playersTable)
      .where(inArray(playersTable.id, playerIds));
    const playerById = new Map(playerRows.map((p) => [p.id, p]));

    const gameRows = gameIds.length
      ? await db.select().from(gamesTable).where(inArray(gamesTable.id, gameIds))
      : [];
    const gameById = new Map(gameRows.map((g) => [g.id, g]));

    // Real recent power: HRs over each player's last 10 game-days from the synced logs.
    // Bound to the last ~6 weeks so this public endpoint never scans a full season of logs —
    // a 10-game window spans ~2 weeks for an everyday hitter, so this never truncates it.
    const since = easternDateDaysAgo(45);
    const logRows = await db
      .select({
        playerId: gameLogsTable.playerId,
        gameDate: gameLogsTable.gameDate,
        homeRuns: gameLogsTable.homeRuns,
      })
      .from(gameLogsTable)
      .where(and(inArray(gameLogsTable.playerId, playerIds), gte(gameLogsTable.gameDate, since)));
    const logsByPlayer = new Map<number, { gameDate: string; homeRuns: number }[]>();
    for (const l of logRows) {
      const arr = logsByPlayer.get(l.playerId) ?? [];
      arr.push({ gameDate: l.gameDate, homeRuns: l.homeRuns });
      logsByPlayer.set(l.playerId, arr);
    }
    const recentHr10 = new Map<number, number>();
    for (const [pid, arr] of logsByPlayer) {
      const last10 = arr.sort((a, b) => (a.gameDate < b.gameDate ? 1 : -1)).slice(0, 10);
      recentHr10.set(
        pid,
        last10.reduce((s, x) => s + x.homeRuns, 0),
      );
    }

    const legs: Array<ParlayLeg & { _rank: number }> = [];
    for (const p of preds) {
      const player = playerById.get(p.playerId);
      if (!player?.isActive) continue; // never surface an IL'd / off-roster hitter
      const hr10 = recentHr10.get(p.playerId) ?? 0;
      if (hr10 < 1) continue; // "danger bats" only — must have gone yard in the last 10
      const prob = parseFloat(p.value);
      if (!Number.isFinite(prob) || prob <= 0) continue;

      const game = p.gameId != null ? gameById.get(p.gameId) : undefined;
      let opponentAbbr: string | null = null;
      let pitcher: string | null = null;
      if (game) {
        const teamAbbr = player.teamAbbr;
        if (teamAbbr && game.homeTeamAbbr === teamAbbr) {
          opponentAbbr = game.awayTeamAbbr || null;
          pitcher = game.awayPitcher;
        } else if (teamAbbr && game.awayTeamAbbr === teamAbbr) {
          opponentAbbr = game.homeTeamAbbr || null;
          pitcher = game.homePitcher;
        }
      }

      legs.push({
        playerId: p.playerId,
        playerName: p.playerName,
        teamAbbr: player.teamAbbr,
        avatarUrl: headshotUrl(player.mlbId),
        opponentAbbr,
        pitcher,
        detail: `${hr10} HR in last 10`,
        hrProbability: prob,
        americanOdds: probabilityToAmericanOdds(prob),
        _rank: hr10,
      });
    }

    // Most dangerous first; tiebreak by HR probability. Cap at 15 (enough for ~5 parlays of 3).
    legs.sort((a, b) => b._rank - a._rank || b.hrProbability - a.hrProbability);
    res.json(legs.slice(0, 15).map(({ _rank, ...leg }) => leg));
  } catch (err) {
    req.log.error({ err }, "Failed to get cooking-up parlays");
    res.status(500).json({ error: "Internal server error" });
  }
});

// "Heat Checks" — hitters who homered on the most recent completed slate (real game logs),
// priced off each hitter's season HR rate (their typical single-game HR probability). Longest
// price first so the flashiest longshots lead the board. Real-or-nothing: no slate / no HRs -> [].
router.get("/heat-checks", async (req, res) => {
  try {
    const today = todayEastern();
    const [latest] = await db
      .select({ date: sql<string | null>`max(${gameLogsTable.gameDate})` })
      .from(gameLogsTable)
      .where(lt(gameLogsTable.gameDate, today));
    const slate = latest?.date ?? null;
    if (!slate) {
      res.json([]);
      return;
    }

    const hrLogs = await db
      .select({
        playerId: gameLogsTable.playerId,
        homeRuns: gameLogsTable.homeRuns,
        opponentAbbr: gameLogsTable.opponentAbbr,
      })
      .from(gameLogsTable)
      .where(and(eq(gameLogsTable.gameDate, slate), gte(gameLogsTable.homeRuns, 1)));
    if (hrLogs.length === 0) {
      res.json([]);
      return;
    }

    const playerIds = [...new Set(hrLogs.map((l) => l.playerId))];
    const playerRows = await db
      .select({
        id: playersTable.id,
        mlbId: playersTable.mlbId,
        name: playersTable.name,
        teamAbbr: playersTable.teamAbbr,
        hrRate: playersTable.hrRate,
        isActive: playersTable.isActive,
      })
      .from(playersTable)
      .where(inArray(playersTable.id, playerIds));
    const playerById = new Map(playerRows.map((p) => [p.id, p]));

    const legs: ParlayLeg[] = [];
    for (const l of hrLogs) {
      const player = playerById.get(l.playerId);
      if (!player?.isActive) continue;
      const hrRate = player.hrRate ? parseFloat(player.hrRate) : NaN;
      if (!Number.isFinite(hrRate) || hrRate <= 0) continue; // need a real season HR rate to price it
      const prob = computeHrProbability({ hrRate, parkFactor: 1.0 });

      legs.push({
        playerId: l.playerId,
        playerName: player.name,
        teamAbbr: player.teamAbbr,
        avatarUrl: headshotUrl(player.mlbId),
        opponentAbbr: l.opponentAbbr,
        pitcher: null,
        detail: "HR yesterday",
        hrProbability: prob,
        americanOdds: probabilityToAmericanOdds(prob),
      });
    }

    // Longest price (rarest HR) first — the flashy longshots lead, like the reference layout.
    legs.sort((a, b) => b.americanOdds - a.americanOdds);
    res.json(legs.slice(0, 15));
  } catch (err) {
    req.log.error({ err }, "Failed to get heat-check parlays");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
