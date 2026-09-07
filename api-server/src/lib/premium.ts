/**
 * Premium field redaction for FREE users. The Games board and the Top Picks /
 * Dashboard leaderboard stay publicly viewable (names, team, HR%, rank, career
 * BvP), but the paid analytics — the composite Crown/HR Score, its component
 * breakdown, the ML confidence grade, and the natural-language matchup insight —
 * are stripped so a non-member never receives the real premium values over the
 * wire. `locked: true` tells the client to render a teaser/upsell in their place.
 */
export interface Lockable {
  hrScore: number | null;
  hrScoreComponents: unknown;
  confidenceGrade: string | null;
  insight: unknown;
  locked?: boolean;
}

export function redactPremiumFields<T extends Lockable>(
  item: T,
  isMember: boolean,
): T {
  if (isMember) return { ...item, locked: false };
  return {
    ...item,
    hrScore: null,
    hrScoreComponents: null,
    confidenceGrade: null,
    insight: null,
    locked: true,
  };
}
