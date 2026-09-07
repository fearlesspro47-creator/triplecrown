/**
 * Official MLB headshot for a player, built from their stable MLB id. Returns a transparent
 * PNG (falls back on the client to initials if the image 404s or the player has no mlb_id).
 * Real, key-less MLB static asset — no fabricated/placeholder image.
 */
export function headshotUrl(mlbId: number | null | undefined): string | null {
  return mlbId ? `https://midfield.mlbstatic.com/v1/people/${mlbId}/spots/120` : null;
}
