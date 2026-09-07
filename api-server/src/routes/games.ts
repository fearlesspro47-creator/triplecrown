import { Router } from "express";
import { todayEastern } from "../lib/dates";
import { db, gamesTable, playersTable, predictionsTable, batterVsPitcherTable } from "@workspace/db";
import type { HrScoreComponent } from "@workspace/db";
import { eq } from "drizzle-orm";
import { headshotUrl } from "../lib/headshot";
import { fetchMlDetailsByPlayer } from "../lib/mlDetails";
import { buildMatchupInsight, type MatchupInsight } from "../lib/matchupInsight";
import { loadMatchupInsightInputs } from "../lib/matchupInsightData";
import { getMembership } from "../lib/membership";
import { redactPremiumFields } from "../lib/premium";

const router = Router();

function parseGame(g: typeof gamesTable.$inferSelect) {
  return {
    ...g,
    homeScore: g.homeScore ?? null,
    awayScore: g.awayScore ?? null,
    inning: g.inning ?? null,
    homePitcher: g.homePitcher ?? null,
    awayPitcher: g.awayPitcher ?? null,
    homePitcherHand: g.homePitcherHand ?? null,
    awayPitcherHand: g.awayPitcherHand ?? null,
    homePitcherMlbId: g.homePitcherMlbId ?? null,
    awayPitcherMlbId: g.awayPitcherMlbId ?? null,
    homePitcherHr9: g.homePitcherHr9 != null ? parseFloat(g.homePitcherHr9) : null,
    awayPitcherHr9: g.awayPitcherHr9 != null ? parseFloat(g.awayPitcherHr9) : null,
    mlbGamePk: g.mlbGamePk ?? null,
  };
}

interface BvpSummary {
  pitcherName: string | null;
  seasonAb: number;
  seasonHr: number;
  seasonHits: number;
  seasonDoubles: number;
  seasonTriples: number;
  seasonStrikeouts: number;
  careerAb: number;
  careerHr: number;
  careerHits: number;
  careerDoubles: number;
  careerTriples: number;
  careerStrikeouts: number;
}

interface SeasonBattingLine {
  gamesPlayed: number | null;
  atBats: number;
  hits: number;
  doubles: number;
  triples: number;
  homeRuns: number;
  avg: number | null; // season batting average (0-1), null when unavailable
}

interface TrackedPlayer {
  playerId: number;
  playerName: string;
  team: string;
  avatarUrl: string | null;
  teamAbbr: string;
  position: string;
  side: "home" | "away";
  hitProbability: number;
  hrProbability: number;
  handedness: string | null;
  seasonStats: SeasonBattingLine | null; // hitter's overall current-season batting line (real MLB totals)
  hrScore: number | null; // composite 0-100 HR Score / Crown Score (not a probability)
  hrScoreComponents: HrScoreComponent[] | null; // weighted breakdown for the HR Score
  confidenceGrade: string | null; // ML confidence grade (A+..D) when the ML scorer ran
  modelSource: "ml" | "heuristic"; // which model produced hrProbability / hrScore
  bvp: BvpSummary | null; // batter vs today's opposing probable pitcher
  insight: MatchupInsight | null; // natural-language "why the model likes this matchup" blurb
}

// Attach the tracked (active) players playing in each game, with today's hit/HR probabilities
// pulled from the daily prediction sync. Keyed by game id, highest HR probability first.
async function trackedPlayersByGame(
  date: string,
  games: (typeof gamesTable.$inferSelect)[],
): Promise<Map<number, TrackedPlayer[]>> {
  const byGame = new Map<number, TrackedPlayer[]>();
  if (games.length === 0) return byGame;

  const players = await db.select().from(playersTable).where(eq(playersTable.isActive, true));
  const preds = await db.select().from(predictionsTable).where(eq(predictionsTable.date, date));
  const valueByKey = new Map<string, number>();
  const metaByPlayer = new Map<number, HrScoreComponent[]>();
  for (const p of preds) {
    valueByKey.set(`${p.playerId}:${p.predictionType}`, parseFloat(p.value));
    if (p.predictionType === "hr_score" && p.meta?.components) metaByPlayer.set(p.playerId, p.meta.components);
  }

  // Rich ML output (calibrated HR prob + Crown Score + reasoning) when the daily scorer has run
  // for this date; coalesced over the heuristic per player, graceful fallback when absent.
  const mlByPlayer = await fetchMlDetailsByPlayer(date);

  const bvpRows = await db.select().from(batterVsPitcherTable).where(eq(batterVsPitcherTable.date, date));
  const bvpByKey = new Map<string, BvpSummary>();
  for (const b of bvpRows) {
    bvpByKey.set(`${b.playerId}:${b.gameId}`, {
      pitcherName: b.pitcherName,
      seasonAb: b.seasonAb,
      seasonHr: b.seasonHr,
      seasonHits: b.seasonHits,
      seasonDoubles: b.seasonDoubles,
      seasonTriples: b.seasonTriples,
      seasonStrikeouts: b.seasonStrikeouts,
      careerAb: b.careerAb,
      careerHr: b.careerHr,
      careerHits: b.careerHits,
      careerDoubles: b.careerDoubles,
      careerTriples: b.careerTriples,
      careerStrikeouts: b.careerStrikeouts,
    });
  }

  // Batch-load real inputs for the "why the model likes this matchup" insight: hitter SLG-by-pitch,
  // each starter's pitch-usage arsenal, ballpark weather, and BvP — one query set for the slate.
  const predPlayerIds = [...new Set(preds.map((p) => p.playerId))];
  const pitcherMlbIds = [
    ...new Set(
      games.flatMap((g) => [g.homePitcherMlbId, g.awayPitcherMlbId].filter((x): x is number => x != null)),
    ),
  ];
  const insightData = await loadMatchupInsightInputs({
    date,
    playerIds: predPlayerIds,
    pitcherMlbIds,
    gameIds: games.map((g) => g.id),
  });

  for (const game of games) {
    const list: TrackedPlayer[] = [];
    for (const pl of players) {
      const side: "home" | "away" | null =
        game.homeTeamAbbr === pl.teamAbbr ? "home" : game.awayTeamAbbr === pl.teamAbbr ? "away" : null;
      if (!side) continue;
      const hit = valueByKey.get(`${pl.id}:hit`);
      const hr = valueByKey.get(`${pl.id}:hr`);
      // Only surface players who have today's computed predictions. This skips off-day players
      // and avoids showing a misleading 0.0% if a sync hasn't populated a player yet.
      if (hit == null || hr == null) continue;
      const ml = mlByPlayer.get(pl.id);
      // Opposing probable starter (whose arsenal the hitter faces) is the OTHER side's pitcher.
      const oppMlbId = side === "home" ? game.awayPitcherMlbId : game.homePitcherMlbId;
      const oppName = side === "home" ? game.awayPitcher : game.homePitcher;
      const oppHand = side === "home" ? game.awayPitcherHand : game.homePitcherHand;
      const insight = buildMatchupInsight({
        batterName: pl.name,
        pitcherName: oppName ?? null,
        batterHand: pl.handedness ?? null,
        pitcherHand: oppHand ?? null,
        arsenal: oppMlbId != null ? (insightData.arsenalByPitcher.get(oppMlbId) ?? []) : [],
        pitchMix: insightData.pitchMixByPlayer.get(pl.id) ?? [],
        profile: insightData.profileByPlayer.get(pl.id) ?? null,
        platoonSplits: oppMlbId != null ? (insightData.platoonByPitcher.get(oppMlbId) ?? null) : null,
        weather: insightData.weatherByGame.get(game.id) ?? null,
        bvp: insightData.bvpByKey.get(`${pl.id}:${game.id}`) ?? null,
        mlReasons: ml?.reasons ?? null,
      });
      list.push({
        playerId: pl.id,
        playerName: pl.name,
        team: pl.team,
        avatarUrl: headshotUrl(pl.mlbId),
        teamAbbr: pl.teamAbbr,
        position: pl.position,
        side,
        hitProbability: hit,
        hrProbability: ml ? ml.hrProbability : hr,
        handedness: pl.handedness ?? null,
        seasonStats:
          pl.atBats != null
            ? {
                gamesPlayed: pl.gamesPlayed ?? null,
                atBats: pl.atBats,
                hits: pl.hits ?? 0,
                doubles: pl.doubles ?? 0,
                triples: pl.triples ?? 0,
                homeRuns: pl.homeRuns ?? 0,
                avg: pl.battingAvg != null ? parseFloat(pl.battingAvg) : null,
              }
            : null,
        hrScore: ml ? ml.crownScore : (valueByKey.get(`${pl.id}:hr_score`) ?? null),
        hrScoreComponents: ml ? (ml.crownComponents ?? null) : (metaByPlayer.get(pl.id) ?? null),
        confidenceGrade: ml?.confidenceGrade ?? null,
        modelSource: ml ? "ml" : "heuristic",
        bvp: bvpByKey.get(`${pl.id}:${game.id}`) ?? null,
        insight,
      });
    }
    list.sort((a, b) => b.hrProbability - a.hrProbability);
    byGame.set(game.id, list);
  }
  return byGame;
}

router.get("/", async (req, res) => {
  try {
    const date = (req.query.date as string) || todayEastern();
    const games = await db.select().from(gamesTable).where(eq(gamesTable.gameDate, date));
    const tracked = await trackedPlayersByGame(date, games);
    const { isMember } = await getMembership(req);
    res.json(
      games.map((g) => ({
        ...parseGame(g),
        trackedPlayers: (tracked.get(g.id) ?? []).map((t) => redactPremiumFields(t, isMember)),
      })),
    );
  } catch (err) {
    req.log.error({ err }, "Failed to list games");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [game] = await db.select().from(gamesTable).where(eq(gamesTable.id, id));
    if (!game) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    const tracked = (await trackedPlayersByGame(game.gameDate, [game])).get(game.id) ?? [];
    const toLineup = (side: "home" | "away") =>
      tracked
        .filter((t) => t.side === side)
        .map((t, i) => ({
          battingOrder: i + 1,
          playerName: t.playerName,
          position: t.position,
          teamAbbr: t.teamAbbr,
          playerId: t.playerId,
          hrProbability: t.hrProbability,
          hitProbability: t.hitProbability,
        }));

    res.json({
      ...parseGame(game),
      homeLineup: toLineup("home"),
      awayLineup: toLineup("away"),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get game");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
