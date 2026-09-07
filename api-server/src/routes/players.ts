import { Router } from "express";
import { todayEastern } from "../lib/dates";
import {
  db,
  playersTable,
  statcastTable,
  predictionsTable,
  gamesTable,
  gameLogsTable,
  batterPitchMixTable,
  pitcherArsenalTable,
  nearMissesTable,
} from "@workspace/db";
import { eq, ilike, and, desc, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { headshotUrl } from "../lib/headshot";
import { fetchMlDetailsByPlayer } from "../lib/mlDetails";
import { buildMatchupInsight, type MatchupInsight } from "../lib/matchupInsight";
import { loadMatchupInsightInputs } from "../lib/matchupInsightData";
import { getMembership, requireActiveMembership } from "../lib/membership";
import { redactPremiumFields } from "../lib/premium";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const { position, team, search } = req.query as Record<string, string>;
    // Active players only — the Player Database mirrors the boards, so injured/optioned players
    // (off the active roster, e.g. an IL'd star) don't appear here either.
    const conditions = [eq(playersTable.isActive, true)];
    if (position) conditions.push(eq(playersTable.position, position));
    if (team) conditions.push(ilike(playersTable.team, `%${team}%`));

    let players = await db
      .select()
      .from(playersTable)
      .where(and(...conditions))
      .orderBy(sql`${playersTable.homeRuns} DESC NULLS LAST`);

    // Free-text search box: match player name OR team (full name / abbreviation),
    // accent- and case-insensitively so "garcia" finds "García" and both "yankees"
    // and "NYY" find New York hitters. Done in JS over the active set (~400 rows) so
    // we don't depend on a Postgres unaccent extension being installed in every env.
    if (search && search.trim()) {
      const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const q = norm(search.trim());
      players = players.filter(
        (p) =>
          norm(p.name).includes(q) ||
          (p.team ? norm(p.team).includes(q) : false) ||
          (p.teamAbbr ? norm(p.teamAbbr).includes(q) : false),
      );
    }

    const result = players.map((p) => ({
      ...p,
      avatarUrl: headshotUrl(p.mlbId),
      battingAvg: p.battingAvg ? parseFloat(p.battingAvg) : null,
      ops: p.ops ? parseFloat(p.ops) : null,
      slg: p.slg ? parseFloat(p.slg) : null,
      obp: p.obp ? parseFloat(p.obp) : null,
      strikeoutRate: p.strikeoutRate ? parseFloat(p.strikeoutRate) : null,
      walkRate: p.walkRate ? parseFloat(p.walkRate) : null,
      hrRate: p.hrRate ? parseFloat(p.hrRate) : null,
      iso: p.iso ? parseFloat(p.iso) : null,
      babip: p.babip ? parseFloat(p.babip) : null,
      wrcPlus: p.wrcPlus ?? null,
    }));

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to list players");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const [player] = await db.insert(playersTable).values(req.body).returning();
    res.status(201).json({
      ...player,
      battingAvg: player.battingAvg ? parseFloat(player.battingAvg) : null,
      ops: player.ops ? parseFloat(player.ops) : null,
      slg: player.slg ? parseFloat(player.slg) : null,
      obp: player.obp ? parseFloat(player.obp) : null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to create player");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Sample-size reliability for ranking. A hitter's composite HR/Crown Score is only fully trusted
// once they've played enough games this season; below TRUST_GAMES the score is discounted
// proportionally (floored so a red-hot recent call-up still appears, just not at the top), so a
// noisy small-sample rate spike (e.g. a .400+ ISO over ~15 games) can't dominate the board.
const TRUST_GAMES = 40;
const RELIABILITY_FLOOR = 0.4;
function sampleReliability(gamesPlayed: number | null): number {
  const g = gamesPlayed ?? 0;
  return Math.max(RELIABILITY_FLOOR, Math.min(1, g / TRUST_GAMES));
}

router.get("/top-picks", async (req, res) => {
  try {
    const today = todayEastern();
    // Every hitter with a HR probability for today, ranked highest-first (no cap).
    const preds = await db
      .select()
      .from(predictionsTable)
      .where(and(eq(predictionsTable.predictionType, "hr"), eq(predictionsTable.date, today)))
      .orderBy(desc(predictionsTable.value));

    if (preds.length === 0) {
      res.json([]);
      return;
    }

    const playerIds = [...new Set(preds.map((p) => p.playerId))];
    const gameIds = [...new Set(preds.map((p) => p.gameId).filter((g): g is number => g != null))];

    // Rich ML output (calibrated HR prob + Crown Score + confidence + reasoning) when the daily
    // scorer has run for today. Falls back to the heuristic prediction per player when absent.
    const mlByPlayer = await fetchMlDetailsByPlayer(today, playerIds);

    // Composite HR Score (0-100) for today, if the daily sync computed one for the player.
    const scoreRows = await db
      .select({ playerId: predictionsTable.playerId, value: predictionsTable.value, meta: predictionsTable.meta })
      .from(predictionsTable)
      .where(and(eq(predictionsTable.predictionType, "hr_score"), eq(predictionsTable.date, today)));
    const hrScoreById = new Map(scoreRows.map((s) => [s.playerId, parseFloat(s.value)]));
    // Heuristic Crown Score component breakdown, used only for players without an ML row so the
    // score and its breakdown always come from the SAME source (never an ML score with heuristic
    // components or vice-versa).
    const heurComponentsById = new Map(
      scoreRows.filter((s) => s.meta?.components).map((s) => [s.playerId, s.meta!.components]),
    );

    // Real player positions + team abbreviations (for opponent resolution) + active status.
    const playerRows = await db
      .select({
        id: playersTable.id,
        mlbId: playersTable.mlbId,
        position: playersTable.position,
        teamAbbr: playersTable.teamAbbr,
        handedness: playersTable.handedness,
        isActive: playersTable.isActive,
        gamesPlayed: playersTable.gamesPlayed,
      })
      .from(playersTable)
      .where(inArray(playersTable.id, playerIds));
    const playerById = new Map(playerRows.map((p) => [p.id, p]));

    // Real opponent / venue / start time from today's scheduled game.
    const gameRows = gameIds.length
      ? await db.select().from(gamesTable).where(inArray(gamesTable.id, gameIds))
      : [];
    const gameById = new Map(gameRows.map((g) => [g.id, g]));

    // Batch-load real inputs for the "why the model likes this matchup" insight (hitter SLG-by-pitch,
    // each starter's pitch-usage arsenal, ballpark weather, BvP) for the whole slate in one pass.
    const pitcherMlbIds = [
      ...new Set(
        gameRows.flatMap((g) => [g.homePitcherMlbId, g.awayPitcherMlbId].filter((x): x is number => x != null)),
      ),
    ];
    const insightData = await loadMatchupInsightInputs({ date: today, playerIds, pitcherMlbIds, gameIds });

    // Real recent form: HRs over each player's last 7 game-days from the synced logs.
    const logRows = await db
      .select({
        playerId: gameLogsTable.playerId,
        gameDate: gameLogsTable.gameDate,
        homeRuns: gameLogsTable.homeRuns,
      })
      .from(gameLogsTable)
      .where(inArray(gameLogsTable.playerId, playerIds));
    const logsByPlayer = new Map<number, { gameDate: string; homeRuns: number }[]>();
    for (const l of logRows) {
      const arr = logsByPlayer.get(l.playerId) ?? [];
      arr.push({ gameDate: l.gameDate, homeRuns: l.homeRuns });
      logsByPlayer.set(l.playerId, arr);
    }
    const recentHrById = new Map<number, number>();
    for (const [pid, arr] of logsByPlayer) {
      const last7 = arr.sort((a, b) => (a.gameDate < b.gameDate ? 1 : -1)).slice(0, 7);
      recentHrById.set(
        pid,
        last7.reduce((sum, x) => sum + x.homeRuns, 0),
      );
    }

    // Defensive: predictions are only generated for active players and stale rows are cleaned up
    // each sync, but never surface a player who is no longer on an active roster (e.g. an IL'd
    // star) if a cleanup step lagged. Real-or-nothing: drop, don't fabricate.
    const activePreds = preds.filter((p) => playerById.get(p.playerId)?.isActive);
    const picks = activePreds.map((p) => {
      const ml = mlByPlayer.get(p.playerId);
      // Coalesce ML over the heuristic for display + ranking; fall back per player when no ML row.
      const prob = ml ? ml.hrProbability : parseFloat(p.value);
      const player = playerById.get(p.playerId);
      const game = p.gameId != null ? gameById.get(p.gameId) : undefined;

      let opponent: string | null = null;
      let venue: string | null = null;
      let gameTime: string | null = null;
      // The opposing probable starter whose arsenal this hitter faces is the OTHER side's pitcher.
      let oppPitcherMlbId: number | null = null;
      let oppPitcherName: string | null = null;
      let oppPitcherHand: string | null = null;
      if (game) {
        venue = game.venue || null;
        gameTime = game.gameTime || null;
        const teamAbbr = player?.teamAbbr;
        if (teamAbbr && game.homeTeamAbbr === teamAbbr) {
          opponent = game.awayTeamAbbr || game.awayTeam || null;
          oppPitcherMlbId = game.awayPitcherMlbId;
          oppPitcherName = game.awayPitcher;
          oppPitcherHand = game.awayPitcherHand;
        } else if (teamAbbr && game.awayTeamAbbr === teamAbbr) {
          opponent = game.homeTeamAbbr || game.homeTeam || null;
          oppPitcherMlbId = game.homePitcherMlbId;
          oppPitcherName = game.homePitcher;
          oppPitcherHand = game.homePitcherHand;
        }
      }

      const insight = buildMatchupInsight({
        batterName: p.playerName,
        pitcherName: oppPitcherName,
        batterHand: player?.handedness ?? null,
        pitcherHand: oppPitcherHand,
        arsenal: oppPitcherMlbId != null ? (insightData.arsenalByPitcher.get(oppPitcherMlbId) ?? []) : [],
        pitchMix: insightData.pitchMixByPlayer.get(p.playerId) ?? [],
        profile: insightData.profileByPlayer.get(p.playerId) ?? null,
        platoonSplits: oppPitcherMlbId != null ? (insightData.platoonByPitcher.get(oppPitcherMlbId) ?? null) : null,
        weather: game ? (insightData.weatherByGame.get(game.id) ?? null) : null,
        bvp: game ? (insightData.bvpByKey.get(`${p.playerId}:${game.id}`) ?? null) : null,
        mlReasons: ml?.reasons ?? null,
      });

      const hrScore = ml ? ml.crownScore : (hrScoreById.get(p.playerId) ?? null);
      const gamesPlayed = player?.gamesPlayed ?? null;
      // Reliability-weighted composite, used for BOTH ranking and the confidence badge so a
      // high-ranked pick never reads "low" and a thin-sample pick never reads "high".
      const rankScore = hrScore != null ? hrScore * sampleReliability(gamesPlayed) : null;

      return {
        playerId: p.playerId,
        playerName: p.playerName,
        team: p.team,
        avatarUrl: headshotUrl(player?.mlbId),
        position: player?.position ?? "DH",
        hrProbability: prob,
        trend: prob > 0.3 ? "up" : prob > 0.2 ? "flat" : "down",
        opponent,
        venue,
        gameTime,
        gameId: p.gameId ?? null,
        gameStatus: game?.status ?? null,
        confidence:
          rankScore != null
            ? rankScore >= 65 ? "high" : rankScore >= 50 ? "medium" : "low"
            : prob > 0.3 ? "high" : prob > 0.2 ? "medium" : "low",
        recentHrs: recentHrById.get(p.playerId) ?? 0,
        gamesPlayed,
        smallSample: (gamesPlayed ?? 0) < TRUST_GAMES,
        hrScore,
        confidenceGrade: ml?.confidenceGrade ?? null,
        hrScoreComponents: ml ? (ml.crownComponents ?? null) : (heurComponentsById.get(p.playerId) ?? null),
        modelSource: ml ? "ml" : "heuristic",
        insight,
        _rankScore: rankScore,
      };
    });

    // Rank by the model's FULL composite HR/Crown Score (matchup, HR-vs-top-pitches, barrel/hard-hit,
    // xSLG, platoon, park, weather, recent form) — NOT raw HR% — so the best all-around HR spots lead
    // the board. Each score is weighted by a games-played reliability factor so small-sample rate
    // spikes can't float to the top. Ties (and any player without a composite score) fall back to the
    // effective HR probability.
    picks.sort((a, b) => {
      if (a._rankScore == null && b._rankScore == null) return b.hrProbability - a.hrProbability;
      if (a._rankScore == null) return 1;
      if (b._rankScore == null) return -1;
      if (b._rankScore !== a._rankScore) return b._rankScore - a._rankScore;
      return b.hrProbability - a.hrProbability;
    });
    // Strip the internal ranking scalar (not part of the API contract) before responding.
    const topPicks = picks.map(({ _rankScore, ...pick }, i) => ({ ...pick, rank: i + 1 }));

    // The ranked board (names, HR%, rank, career BvP) stays viewable; the paid
    // analytics (Crown Score, breakdown, grade, AI insight) are stripped server-side.
    // The free 5-pick limit is a display concern on the Top Picks page, so the other
    // consumers of this endpoint (the Analytics distribution chart, the Dashboard
    // showcase) still receive the full slate.
    const { isMember } = await getMembership(req);
    res.json(topPicks.map((p) => redactPremiumFields(p, isMember)));
  } catch (err) {
    req.log.error({ err }, "Failed to get top picks");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Top 10 hitters most likely to record a HIT today, ranked by the model's real `hit` probability
// (a decimal 0-1). Active players only, joined to today's game for opponent/venue/first pitch and to
// the season line for batting average — real-or-nothing, no fabricated names.
router.get("/top-hits", async (req, res) => {
  try {
    const today = todayEastern();
    const preds = await db
      .select()
      .from(predictionsTable)
      .where(and(eq(predictionsTable.predictionType, "hit"), eq(predictionsTable.date, today)))
      .orderBy(desc(predictionsTable.value));

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
        position: playersTable.position,
        teamAbbr: playersTable.teamAbbr,
        isActive: playersTable.isActive,
        battingAvg: playersTable.battingAvg,
      })
      .from(playersTable)
      .where(inArray(playersTable.id, playerIds));
    const playerById = new Map(playerRows.map((p) => [p.id, p]));

    const gameRows = gameIds.length
      ? await db.select().from(gamesTable).where(inArray(gamesTable.id, gameIds))
      : [];
    const gameById = new Map(gameRows.map((g) => [g.id, g]));

    // Defensive: only surface players still on an active roster (an IL'd player must never leak in
    // even if a prediction-cleanup step lagged behind the roster deactivation).
    const activePreds = preds.filter((p) => playerById.get(p.playerId)?.isActive);

    const rows = activePreds.slice(0, 10).map((p, i) => {
      const player = playerById.get(p.playerId);
      const game = p.gameId != null ? gameById.get(p.gameId) : undefined;

      let opponent: string | null = null;
      let venue: string | null = null;
      let gameTime: string | null = null;
      if (game) {
        venue = game.venue || null;
        gameTime = game.gameTime || null;
        const teamAbbr = player?.teamAbbr;
        if (teamAbbr && game.homeTeamAbbr === teamAbbr) {
          opponent = game.awayTeamAbbr || game.awayTeam || null;
        } else if (teamAbbr && game.awayTeamAbbr === teamAbbr) {
          opponent = game.homeTeamAbbr || game.homeTeam || null;
        }
      }

      return {
        playerId: p.playerId,
        playerName: p.playerName,
        team: p.team,
        avatarUrl: headshotUrl(player?.mlbId),
        position: player?.position ?? "DH",
        hitProbability: parseFloat(p.value),
        battingAvg: player?.battingAvg ? parseFloat(player.battingAvg) : null,
        opponent,
        venue,
        gameTime,
        gameId: p.gameId ?? null,
        gameStatus: game?.status ?? null,
        rank: i + 1,
      };
    });

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to get top hits");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Real-data steal-likelihood score (0-100). SB rate per game is the dominant signal (a player's
// tendency + green light + opportunity); real Statcast sprint speed adds raw wheels; success rate
// rewards efficient runners once there's a sample. Missing sprint/success components are dropped
// and the remaining weights renormalized (same approach as the HR Score), so the score always
// reflects only real inputs.
function computeStealScore(input: {
  sbPerGame: number | null;
  sprintSpeed: number | null;
  successRate: number | null;
  attempts: number;
}): number {
  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
  const parts: Array<{ weight: number; value: number }> = [];
  if (input.sbPerGame != null) {
    // ~0.30 SB/game is elite (≈45 SB over a 150-game season). Dropped (not zeroed) when
    // games-played is unknown, so a missing denominator never fabricates a low rate.
    parts.push({ weight: 0.6, value: clamp01(input.sbPerGame / 0.3) });
  }
  if (input.sprintSpeed != null) {
    // 26–30 ft/s spans roughly league-average to elite sprint speed.
    parts.push({ weight: 0.3, value: clamp01((input.sprintSpeed - 26) / 4) });
  }
  if (input.successRate != null && input.attempts >= 5) {
    // Below a 50% success rate a runner is a net negative; 90%+ is elite.
    parts.push({ weight: 0.1, value: clamp01((input.successRate - 0.5) / 0.4) });
  }
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  if (totalWeight === 0) return 0; // no real component available (unreachable with real payloads)
  const score = parts.reduce((s, p) => s + p.weight * p.value, 0) / totalWeight;
  return Math.round(score * 1000) / 10;
}

// Today's 5 players most likely to steal a base — real season stolen-base production + real
// Statcast sprint speed, scoped to players actually on today's slate. Registered before "/:id".
router.get("/top-steals", async (req, res) => {
  try {
    // Members-only board — non-members get an empty list; the client shows an upsell.
    const { isMember } = await getMembership(req);
    if (!isMember) {
      res.json([]);
      return;
    }
    const today = todayEastern();
    // "On today's card" = players with a prediction for today (they're on the slate). Reuse the
    // hit predictions to define the set + carry game context, same as the top-hits board.
    const preds = await db
      .select()
      .from(predictionsTable)
      .where(and(eq(predictionsTable.predictionType, "hit"), eq(predictionsTable.date, today)));

    if (preds.length === 0) {
      res.json([]);
      return;
    }

    const predByPlayer = new Map<number, (typeof preds)[number]>();
    for (const p of preds) if (!predByPlayer.has(p.playerId)) predByPlayer.set(p.playerId, p);
    const playerIds = [...predByPlayer.keys()];

    const playerRows = await db
      .select({
        id: playersTable.id,
        mlbId: playersTable.mlbId,
        name: playersTable.name,
        team: playersTable.team,
        teamAbbr: playersTable.teamAbbr,
        position: playersTable.position,
        isActive: playersTable.isActive,
        stolenBases: playersTable.stolenBases,
        caughtStealing: playersTable.caughtStealing,
        gamesPlayed: playersTable.gamesPlayed,
      })
      .from(playersTable)
      .where(inArray(playersTable.id, playerIds));

    const statRows = await db
      .select({ playerId: statcastTable.playerId, sprintSpeed: statcastTable.sprintSpeed })
      .from(statcastTable)
      .where(inArray(statcastTable.playerId, playerIds));
    const sprintById = new Map(
      statRows.map((s) => [s.playerId, s.sprintSpeed != null ? parseFloat(s.sprintSpeed) : null]),
    );

    const gameIds = [...new Set(preds.map((p) => p.gameId).filter((g): g is number => g != null))];
    const gameRows = gameIds.length
      ? await db.select().from(gamesTable).where(inArray(gamesTable.id, gameIds))
      : [];
    const gameById = new Map(gameRows.map((g) => [g.id, g]));

    // Real signal required: only players with at least one season steal are true base-stealing
    // threats — never surface a non-stealer as "likely to steal" (real-or-nothing).
    const candidates = playerRows
      .filter((p) => p.isActive && (p.stolenBases ?? 0) >= 1)
      .map((p) => {
        const sb = p.stolenBases ?? 0;
        const cs = p.caughtStealing; // real value or null — never fabricate a caught-stealing of 0
        const g = p.gamesPlayed; // real value or null
        const attempts = sb + (cs ?? 0);
        const sprintSpeed = sprintById.get(p.id) ?? null;
        // Real-or-nothing: no games → no rate (drop it), no CS → no success rate (don't invent 100%).
        const sbPerGame = g != null && g > 0 ? sb / g : null;
        const successRate = cs != null && attempts > 0 ? sb / attempts : null;
        const stealScore = computeStealScore({ sbPerGame, sprintSpeed, successRate, attempts });

        const pred = predByPlayer.get(p.id);
        const game = pred?.gameId != null ? gameById.get(pred.gameId) : undefined;
        let opponent: string | null = null;
        let venue: string | null = null;
        let gameTime: string | null = null;
        if (game) {
          venue = game.venue || null;
          gameTime = game.gameTime || null;
          if (game.homeTeamAbbr === p.teamAbbr) opponent = game.awayTeamAbbr || game.awayTeam || null;
          else if (game.awayTeamAbbr === p.teamAbbr) opponent = game.homeTeamAbbr || game.homeTeam || null;
        }

        return {
          playerId: p.id,
          playerName: p.name,
          team: p.team,
          teamAbbr: p.teamAbbr || null,
          position: p.position ?? null,
          avatarUrl: headshotUrl(p.mlbId),
          stolenBases: sb,
          caughtStealing: cs ?? null,
          gamesPlayed: g ?? null,
          sbPerGame: sbPerGame != null ? Math.round(sbPerGame * 1000) / 1000 : null,
          successRate: successRate != null ? Math.round(successRate * 1000) / 1000 : null,
          sprintSpeed,
          stealScore,
          opponent,
          venue,
          gameTime,
          gameId: pred?.gameId ?? null,
          gameStatus: game?.status ?? null,
        };
      });

    candidates.sort((a, b) => b.stealScore - a.stealScore || b.stolenBases - a.stolenBases);
    const rows = candidates.slice(0, 5).map((r, i) => ({ ...r, rank: i + 1 }));

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to get top steals");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Yesterday's hardest-hit balls that stayed in the park (barrels / 100+ mph in the HR launch
// window that were NOT home runs), ranked by exit velocity. Registered before "/:id" so it
// isn't captured as an id param. Data is refreshed daily by nearMissSync.
router.get("/near-misses", async (req, res) => {
  try {
    const rows = await db
      .select({
        playerId: nearMissesTable.playerId,
        gameDate: nearMissesTable.gameDate,
        exitVelocity: nearMissesTable.exitVelocity,
        launchAngle: nearMissesTable.launchAngle,
        distance: nearMissesTable.distance,
        eventType: nearMissesTable.eventType,
        eventLabel: nearMissesTable.eventLabel,
        category: nearMissesTable.category,
        isBarrel: nearMissesTable.isBarrel,
        count: nearMissesTable.count,
        opponentAbbr: nearMissesTable.opponentAbbr,
        playerName: playersTable.name,
        team: playersTable.team,
        teamAbbr: playersTable.teamAbbr,
        position: playersTable.position,
        mlbId: playersTable.mlbId,
        isActive: playersTable.isActive,
      })
      .from(nearMissesTable)
      .innerJoin(playersTable, eq(nearMissesTable.playerId, playersTable.id))
      // Defensive: never surface a player who's since been deactivated (IL/optioned).
      .where(eq(playersTable.isActive, true))
      .orderBy(desc(nearMissesTable.exitVelocity))
      .limit(12);

    if (rows.length === 0) {
      res.json([]);
      return;
    }

    // "On today's card" = the player has a prediction for today (they're on today's slate).
    const today = todayEastern();
    const todaysPlayerRows = await db
      .selectDistinct({ playerId: predictionsTable.playerId })
      .from(predictionsTable)
      .where(eq(predictionsTable.date, today!));
    const onTodaysCardSet = new Set(todaysPlayerRows.map((r) => r.playerId));

    const result = rows.map((r) => ({
      playerId: r.playerId,
      playerName: r.playerName,
      team: r.team,
      teamAbbr: r.teamAbbr,
      position: r.position,
      avatarUrl: headshotUrl(r.mlbId),
      exitVelocity: parseFloat(r.exitVelocity),
      launchAngle: parseFloat(r.launchAngle),
      distance: r.distance,
      eventLabel: r.eventLabel,
      eventType: r.eventType,
      category: r.category,
      isBarrel: r.isBarrel,
      count: r.count,
      opponentAbbr: r.opponentAbbr,
      onTodaysCard: onTodaysCardSet.has(r.playerId),
      gameDate: r.gameDate,
    }));

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to get near misses");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [player] = await db.select().from(playersTable).where(eq(playersTable.id, id));
    if (!player) {
      res.status(404).json({ error: "Player not found" });
      return;
    }
    res.json({
      ...player,
      avatarUrl: headshotUrl(player.mlbId),
      battingAvg: player.battingAvg ? parseFloat(player.battingAvg) : null,
      ops: player.ops ? parseFloat(player.ops) : null,
      slg: player.slg ? parseFloat(player.slg) : null,
      obp: player.obp ? parseFloat(player.obp) : null,
      strikeoutRate: player.strikeoutRate ? parseFloat(player.strikeoutRate) : null,
      walkRate: player.walkRate ? parseFloat(player.walkRate) : null,
      hrRate: player.hrRate ? parseFloat(player.hrRate) : null,
      iso: player.iso ? parseFloat(player.iso) : null,
      babip: player.babip ? parseFloat(player.babip) : null,
      wrcPlus: player.wrcPlus ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get player");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id/statcast", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [sc] = await db.select().from(statcastTable).where(eq(statcastTable.playerId, id));
    if (!sc) {
      res.json({ playerId: id });
      return;
    }
    res.json({
      ...sc,
      exitVelocityAvg: sc.exitVelocityAvg ? parseFloat(sc.exitVelocityAvg) : null,
      launchAngleAvg: sc.launchAngleAvg ? parseFloat(sc.launchAngleAvg) : null,
      hardHitRate: sc.hardHitRate ? parseFloat(sc.hardHitRate) : null,
      barrelRate: sc.barrelRate ? parseFloat(sc.barrelRate) : null,
      xba: sc.xba ? parseFloat(sc.xba) : null,
      xslg: sc.xslg ? parseFloat(sc.xslg) : null,
      xwoba: sc.xwoba ? parseFloat(sc.xwoba) : null,
      woba: sc.woba ? parseFloat(sc.woba) : null,
      xiso: sc.xiso ? parseFloat(sc.xiso) : null,
      sprintSpeed: sc.sprintSpeed ? parseFloat(sc.sprintSpeed) : null,
      pullRate: sc.pullRate ? parseFloat(sc.pullRate) : null,
      centerRate: sc.centerRate ? parseFloat(sc.centerRate) : null,
      oppositeRate: sc.oppositeRate ? parseFloat(sc.oppositeRate) : null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get statcast");
    res.status(500).json({ error: "Internal server error" });
  }
});

// The opposing starter's real pitch arsenal (from pitcher_arsenal, ordered by how often
// the pitcher throws each family — most-used first) crossed with this batter's real season
// split vs each family (from batter_pitch_mix). Answers "against the pitches this guy throws
// most, how has the hitter done — and how many HR?". Real-or-nothing: pitcher rows always
// come from real arsenal data; batter stat columns are null when the hitter has no tracked
// at-bats vs that family (never a fabricated 0), so a family shows the pitcher's usage with a
// "—" batter line rather than inventing numbers.
router.get("/:id/matchup-pitch-mix/:pitcherMlbId", requireActiveMembership, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const pitcherMlbId = parseInt(String(req.params.pitcherMlbId), 10);
    const season = new Date().getFullYear();
    if (!Number.isFinite(id) || !Number.isFinite(pitcherMlbId)) {
      res.json([]);
      return;
    }

    // Pitcher's arsenal, most-thrown pitch first.
    const arsenal = await db
      .select({
        pitchType: pitcherArsenalTable.pitchType,
        pitchName: pitcherArsenalTable.pitchName,
        usage: pitcherArsenalTable.usage,
      })
      .from(pitcherArsenalTable)
      .where(and(eq(pitcherArsenalTable.pitcherMlbId, pitcherMlbId), eq(pitcherArsenalTable.season, season)))
      .orderBy(desc(pitcherArsenalTable.usage));

    // Batter's season split vs each family, keyed for O(1) lookup.
    const mixRows = await db
      .select()
      .from(batterPitchMixTable)
      .where(and(eq(batterPitchMixTable.playerId, id), eq(batterPitchMixTable.season, season)));
    const num = (v: string | null) => (v != null ? parseFloat(v) : null);
    const mixByType = new Map(mixRows.map((r) => [r.pitchType, r]));

    res.json(
      arsenal.map((a) => {
        const b = mixByType.get(a.pitchType);
        return {
          pitchType: a.pitchType,
          pitchName: a.pitchName ?? b?.pitchName ?? null,
          pitcherUsage: parseFloat(a.usage),
          // Batter columns: null when the hitter has no tracked results vs this family.
          atBats: b ? b.atBats : null,
          homeRuns: b ? b.homeRuns : null,
          avg: b ? num(b.avg) : null,
          iso: b ? num(b.iso) : null,
          kRate: b ? num(b.kRate) : null,
          hardHitRate: b ? num(b.hardHitRate) : null,
          avgExitVelocity: b ? num(b.avgExitVelocity) : null,
        };
      }),
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get matchup pitch mix");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Per-batter performance split by the pitch family they saw (real Statcast, from the
// Python pitch-mix job). Ordered by usage so the primary pitches show first.
router.get("/:id/pitch-mix", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const season = req.query.season ? parseInt(req.query.season as string) : new Date().getFullYear();
    const rows = await db
      .select()
      .from(batterPitchMixTable)
      .where(and(eq(batterPitchMixTable.playerId, id), eq(batterPitchMixTable.season, season)))
      .orderBy(desc(batterPitchMixTable.pitchUsage));
    const num = (v: string | null) => (v != null ? parseFloat(v) : null);
    res.json(
      rows.map((r) => ({
        playerId: r.playerId,
        season: r.season,
        pitchType: r.pitchType,
        pitchName: r.pitchName,
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
        pitchUsage: num(r.pitchUsage),
        avg: num(r.avg),
        slg: num(r.slg),
        iso: num(r.iso),
        kRate: num(r.kRate),
        whiffRate: num(r.whiffRate),
        barrelRate: num(r.barrelRate),
        hardHitRate: num(r.hardHitRate),
        avgExitVelocity: num(r.avgExitVelocity),
      })),
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get pitch mix");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
