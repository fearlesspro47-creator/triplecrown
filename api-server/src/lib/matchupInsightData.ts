import {
  db,
  batterPitchMixTable,
  pitcherArsenalTable,
  pitcherPlatoonSplitsTable,
  statcastTable,
  weatherTable,
  batterVsPitcherTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import type {
  MatchupInsightArsenal,
  MatchupInsightPitchMix,
  MatchupInsightProfile,
  MatchupInsightPlatoon,
  MatchupInsightWeather,
  MatchupInsightBvp,
} from "./matchupInsight";

// Batch-loaded real inputs for the matchup-insight builder, keyed for O(1) per-player lookup.
export interface MatchupInsightData {
  pitchMixByPlayer: Map<number, MatchupInsightPitchMix[]>;
  arsenalByPitcher: Map<number, MatchupInsightArsenal[]>;
  profileByPlayer: Map<number, MatchupInsightProfile>;
  platoonByPitcher: Map<number, MatchupInsightPlatoon[]>;
  weatherByGame: Map<number, MatchupInsightWeather>;
  bvpByKey: Map<string, MatchupInsightBvp>; // `${playerId}:${gameId}`
}

function currentSeason(): number {
  return new Date().getUTCFullYear();
}

// Load every input the insight builder needs for a slate in one batch of queries. All rate/ratio
// columns are Drizzle numerics (strings) → parsed to numbers here so the pure builder stays numeric.
export async function loadMatchupInsightInputs(params: {
  date: string;
  playerIds: number[];
  pitcherMlbIds: number[];
  gameIds: number[];
}): Promise<MatchupInsightData> {
  const season = currentSeason();
  const { date, playerIds, pitcherMlbIds, gameIds } = params;

  const pitchMixByPlayer = new Map<number, MatchupInsightPitchMix[]>();
  const arsenalByPitcher = new Map<number, MatchupInsightArsenal[]>();
  const profileByPlayer = new Map<number, MatchupInsightProfile>();
  const platoonByPitcher = new Map<number, MatchupInsightPlatoon[]>();
  const weatherByGame = new Map<number, MatchupInsightWeather>();
  const bvpByKey = new Map<string, MatchupInsightBvp>();

  if (playerIds.length) {
    const rows = await db
      .select({
        playerId: batterPitchMixTable.playerId,
        pitchType: batterPitchMixTable.pitchType,
        iso: batterPitchMixTable.iso,
        homeRuns: batterPitchMixTable.homeRuns,
        atBats: batterPitchMixTable.atBats,
      })
      .from(batterPitchMixTable)
      .where(and(eq(batterPitchMixTable.season, season), inArray(batterPitchMixTable.playerId, playerIds)));
    for (const r of rows) {
      const arr = pitchMixByPlayer.get(r.playerId) ?? [];
      arr.push({
        pitchType: r.pitchType,
        iso: r.iso != null ? parseFloat(r.iso) : null,
        homeRuns: r.homeRuns,
        atBats: r.atBats,
      });
      pitchMixByPlayer.set(r.playerId, arr);
    }
  }

  if (pitcherMlbIds.length) {
    const rows = await db
      .select({
        pitcherMlbId: pitcherArsenalTable.pitcherMlbId,
        pitchType: pitcherArsenalTable.pitchType,
        pitchName: pitcherArsenalTable.pitchName,
        usage: pitcherArsenalTable.usage,
      })
      .from(pitcherArsenalTable)
      .where(and(eq(pitcherArsenalTable.season, season), inArray(pitcherArsenalTable.pitcherMlbId, pitcherMlbIds)));
    for (const r of rows) {
      const arr = arsenalByPitcher.get(r.pitcherMlbId) ?? [];
      arr.push({ pitchType: r.pitchType, pitchName: r.pitchName, usage: parseFloat(r.usage) });
      arsenalByPitcher.set(r.pitcherMlbId, arr);
    }
  }

  // Hitter quality-of-contact profile (overall Statcast season) for the barrel%/EV clause.
  if (playerIds.length) {
    const rows = await db
      .select({
        playerId: statcastTable.playerId,
        barrelRate: statcastTable.barrelRate,
        exitVelocityAvg: statcastTable.exitVelocityAvg,
      })
      .from(statcastTable)
      .where(inArray(statcastTable.playerId, playerIds));
    for (const r of rows) {
      profileByPlayer.set(r.playerId, {
        barrelRate: r.barrelRate != null ? parseFloat(r.barrelRate) : null,
        exitVelocity: r.exitVelocityAvg != null ? parseFloat(r.exitVelocityAvg) : null,
      });
    }
  }

  // Each starter's real season HR + AB allowed by batter side (vs L / vs R) for the platoon clause.
  if (pitcherMlbIds.length) {
    const rows = await db
      .select({
        pitcherMlbId: pitcherPlatoonSplitsTable.pitcherMlbId,
        batSide: pitcherPlatoonSplitsTable.batSide,
        homeRuns: pitcherPlatoonSplitsTable.homeRuns,
        atBats: pitcherPlatoonSplitsTable.atBats,
      })
      .from(pitcherPlatoonSplitsTable)
      .where(
        and(
          eq(pitcherPlatoonSplitsTable.season, season),
          inArray(pitcherPlatoonSplitsTable.pitcherMlbId, pitcherMlbIds),
        ),
      );
    for (const r of rows) {
      if (r.batSide !== "L" && r.batSide !== "R") continue;
      const arr = platoonByPitcher.get(r.pitcherMlbId) ?? [];
      arr.push({ batSide: r.batSide, homeRuns: r.homeRuns, atBats: r.atBats });
      platoonByPitcher.set(r.pitcherMlbId, arr);
    }
  }

  if (gameIds.length) {
    const rows = await db
      .select({
        gameId: weatherTable.gameId,
        windDirection: weatherTable.windDirection,
        hrBoostFactor: weatherTable.hrBoostFactor,
        temperature: weatherTable.temperature,
      })
      .from(weatherTable)
      .where(inArray(weatherTable.gameId, gameIds));
    for (const r of rows) {
      weatherByGame.set(r.gameId, {
        windDirection: r.windDirection,
        hrBoostFactor: parseFloat(r.hrBoostFactor),
        temperature: parseFloat(r.temperature),
      });
    }
  }

  if (playerIds.length) {
    const rows = await db
      .select({
        playerId: batterVsPitcherTable.playerId,
        gameId: batterVsPitcherTable.gameId,
        seasonAb: batterVsPitcherTable.seasonAb,
        seasonHr: batterVsPitcherTable.seasonHr,
        careerAb: batterVsPitcherTable.careerAb,
        careerHr: batterVsPitcherTable.careerHr,
      })
      .from(batterVsPitcherTable)
      .where(eq(batterVsPitcherTable.date, date));
    for (const r of rows) {
      bvpByKey.set(`${r.playerId}:${r.gameId}`, {
        seasonAb: r.seasonAb,
        seasonHr: r.seasonHr,
        careerAb: r.careerAb,
        careerHr: r.careerHr,
      });
    }
  }

  return { pitchMixByPlayer, arsenalByPitcher, profileByPlayer, platoonByPitcher, weatherByGame, bvpByKey };
}
