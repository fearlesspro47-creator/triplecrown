// "Today" for MLB slates must be the US Eastern calendar date, not UTC. MLB
// schedules and DFS slates are anchored to the US date, so after ~8pm ET the UTC
// date has already rolled to tomorrow — which would surface the next day's slate
// hours early. The `en-CA` locale formats as ISO (YYYY-MM-DD); the timeZone
// option resolves the date in Eastern regardless of where the server runs, and
// it is DST-safe (America/New_York switches EST/EDT automatically).
const EASTERN_TZ = "America/New_York";

export function todayEastern(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: EASTERN_TZ });
}

// The Eastern calendar date `days` days before today (YYYY-MM-DD). Used to bound
// rolling-window queries (e.g. a "last 10 game-days" lookback) so they don't scan a
// full season of logs. The bound is intentionally generous — a 10-game window spans
// only ~2 weeks for an everyday hitter — so it never truncates a real recent window.
export function easternDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toLocaleDateString("en-CA", { timeZone: EASTERN_TZ });
}
