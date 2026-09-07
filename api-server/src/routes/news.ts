import { Router } from "express";
import { todayEastern } from "../lib/dates";
import { db, playersTable, gamesTable, weatherTable, predictionsTable, gameLogsTable } from "@workspace/db";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Logger } from "pino";

const router = Router();

type Tone = "alert" | "positive" | "info" | "neutral";
interface NewsItem {
  category: string;
  text: string;
  tone: Tone;
}

// Render an hrBoostFactor (multiplier centered on 1.0) as a signed HR percentage delta.
function hrDelta(factor: number): string {
  const d = Math.round((factor - 1) * 100);
  return `${d >= 0 ? "+" : ""}${d}% HR`;
}

// Round-robin interleave so the ticker alternates categories instead of clumping.
function interleave(buckets: NewsItem[][]): NewsItem[] {
  const out: NewsItem[] = [];
  const max = Math.max(0, ...buckets.map((b) => b.length));
  for (let i = 0; i < max; i++) {
    for (const b of buckets) if (i < b.length) out.push(b[i]!);
  }
  return out;
}

// Build a bucket resiliently: one bucket's failure degrades only that category (logged and
// dropped), never the whole ticker — better a partial real feed than a 500 and a blank bar.
async function safeBucket(log: Logger, label: string, fn: () => Promise<NewsItem[]>): Promise<NewsItem[]> {
  try {
    return await fn();
  } catch (err) {
    log.error({ err }, `news bucket failed: ${label}`);
    return [];
  }
}

// Live, real-data news ticker feed: injuries (players off the active roster), today's park
// weather, top model HR picks, hot recent-form trends, and today's game matchups. Everything
// is derived from synced data — no fabricated headlines. Empty when nothing is scheduled.
router.get("/", async (req, res) => {
  const date = (req.query.date as string) || todayEastern();

  // Today's games power both the weather venue lookup and the matchup headlines. Fetched once
  // and shared; if it fails, weather + game buckets degrade to empty rather than failing.
  let games: (typeof gamesTable.$inferSelect)[] = [];
  try {
    games = await db.select().from(gamesTable).where(eq(gamesTable.gameDate, date));
  } catch (err) {
    req.log.error({ err }, "news: today's games fetch failed");
  }
  const gameById = new Map(games.map((g) => [g.id, g]));

  // 1) INJURY / OUT — real hitters no longer on an active roster (IL / optioned), biggest bats
  //    first so recognizable names (e.g. an IL'd slugger) lead. is_active=false is the app's
  //    injury/inactive flag; we surface it truthfully as "OUT" rather than guessing the cause.
  const injury = await safeBucket(req.log, "injury", async () => {
    const outRows = await db
      .select({ name: playersTable.name, teamAbbr: playersTable.teamAbbr, homeRuns: playersTable.homeRuns })
      .from(playersTable)
      .where(and(eq(playersTable.isActive, false), isNotNull(playersTable.homeRuns)))
      .orderBy(desc(playersTable.homeRuns))
      .limit(5);
    return outRows.map<NewsItem>((p) => ({
      category: "INJURY",
      tone: "alert",
      text: `${p.name}${p.teamAbbr ? ` (${p.teamAbbr})` : ""} is OUT — off the active roster (IL / inactive)`,
    }));
  });

  // 2) WEATHER — real per-park conditions for today's games. Rain risks lead (they can rain out a
  //    slate regardless of wind), then the most extreme HR wind effects.
  const weather = await safeBucket(req.log, "weather", async () => {
    if (!games.length) return [];
    const wxRows = await db
      .select({ w: weatherTable })
      .from(weatherTable)
      .innerJoin(gamesTable, eq(weatherTable.gameId, gamesTable.id))
      .where(eq(gamesTable.gameDate, date));
    const wx = wxRows
      .map((r) => r.w)
      .map((w) => ({
        venue: gameById.get(w.gameId)?.venue ?? "",
        factor: parseFloat(w.hrBoostFactor),
        wind: parseFloat(w.windSpeed),
        // rainProbability is a 0-100 percentage (Open-Meteo), rendered as-is like the Weather page.
        rain: w.rainProbability != null ? parseFloat(w.rainProbability) : null,
      }))
      .filter((w) => w.venue);

    const items: NewsItem[] = [];
    // Rain risks first — highest chance leads.
    for (const w of wx.filter((w) => w.rain != null && w.rain >= 50).sort((a, b) => b.rain! - a.rain!)) {
      items.push({ category: "WEATHER", tone: "alert", text: `Rain risk at ${w.venue} — ${Math.round(w.rain!)}% chance` });
    }
    // Then strongest HR wind effects (blowing out / holding in), most extreme first.
    const wind = wx
      .filter((w) => !(w.rain != null && w.rain >= 50))
      .sort((a, b) => Math.abs(b.factor - 1) - Math.abs(a.factor - 1))
      .slice(0, 6);
    for (const w of wind) {
      if (w.factor >= 1.04) {
        items.push({ category: "WEATHER", tone: "positive", text: `Wind blowing out ${Math.round(w.wind)}mph at ${w.venue} — ${hrDelta(w.factor)}` });
      } else if (w.factor <= 0.97) {
        items.push({ category: "WEATHER", tone: "info", text: `Wind holding balls in at ${w.venue} — ${hrDelta(w.factor)}` });
      }
    }
    return items;
  });

  // 3) MODEL — highest HR probabilities today (real predictions, active hitters only).
  const model = await safeBucket(req.log, "model", async () => {
    const hrRows = await db
      .select({ name: playersTable.name, value: predictionsTable.value })
      .from(predictionsTable)
      .innerJoin(playersTable, eq(playersTable.id, predictionsTable.playerId))
      .where(and(eq(predictionsTable.predictionType, "hr"), eq(predictionsTable.date, date), eq(playersTable.isActive, true)))
      .orderBy(desc(predictionsTable.value))
      .limit(5);
    return hrRows.map<NewsItem>((p) => ({
      category: "MODEL",
      tone: "positive",
      text: `${p.name} HR probability ${(parseFloat(p.value) * 100).toFixed(1)}% today`,
    }));
  });

  // 4) TREND — hottest recent form: most HRs over the last 7 game-days (real game logs).
  const trend = await safeBucket(req.log, "trend", async () => {
    const weekAgo = new Date(date);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split("T")[0]!;
    const trendRows = await db
      .select({ name: playersTable.name, hr: sql<number>`sum(${gameLogsTable.homeRuns})` })
      .from(gameLogsTable)
      .innerJoin(playersTable, eq(playersTable.id, gameLogsTable.playerId))
      .where(and(gte(gameLogsTable.gameDate, weekAgoStr), eq(playersTable.isActive, true)))
      .groupBy(playersTable.id, playersTable.name)
      .orderBy(desc(sql`sum(${gameLogsTable.homeRuns})`))
      .limit(5);
    return trendRows
      .map((t) => ({ name: t.name, n: Number(t.hr) }))
      .filter((t) => t.n >= 2)
      .map<NewsItem>((t) => ({ category: "TREND", tone: "positive", text: `${t.name} is heating up — ${t.n} HR in the last 7 games` }));
  });

  // 5) GAMES — today's matchups: live score, final, or scheduled first pitch.
  const gameNews = await safeBucket(req.log, "games", async () =>
    games.slice(0, 8).map<NewsItem>((g) => {
      if (g.status === "live") {
        const inn = g.inning ? ` (${g.inning})` : "";
        return {
          category: "LIVE",
          tone: "alert",
          text: `LIVE: ${g.awayTeamAbbr || g.awayTeam} ${g.awayScore ?? 0} - ${g.homeScore ?? 0} ${g.homeTeamAbbr || g.homeTeam}${inn}`,
        };
      }
      if (g.status === "final") {
        return { category: "FINAL", tone: "neutral", text: `Final: ${g.awayTeam} ${g.awayScore ?? 0}, ${g.homeTeam} ${g.homeScore ?? 0}` };
      }
      return { category: "GAME", tone: "info", text: `${g.awayTeam} @ ${g.homeTeam} · ${g.gameTime}` };
    }),
  );

  res.json(interleave([injury, weather, model, trend, gameNews]));
});

export default router;
