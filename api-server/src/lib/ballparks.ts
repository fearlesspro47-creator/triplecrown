// Static ballpark reference for real weather lookups: coordinates + the compass bearing
// from home plate to center field (used to project real wind onto an "out to CF" component).
//
// Keyed by the MLB Stats API home-team abbreviation (games.homeTeamAbbr). Coordinates are the
// stadium locations. cfBearingDeg is the approximate direction (degrees clockwise from north)
// you face looking from home plate toward center field — used only to decide whether real wind
// is blowing out or in; approximate values are fine for that projection.

export interface Ballpark {
  lat: number;
  lon: number;
  cfBearingDeg: number;
}

export const BALLPARKS: Record<string, Ballpark> = {
  AZ: { lat: 33.4455, lon: -112.0667, cfBearingDeg: 0 },
  ARI: { lat: 33.4455, lon: -112.0667, cfBearingDeg: 0 },
  ATL: { lat: 33.8907, lon: -84.4677, cfBearingDeg: 25 },
  BAL: { lat: 39.2839, lon: -76.6217, cfBearingDeg: 30 },
  BOS: { lat: 42.3467, lon: -71.0972, cfBearingDeg: 45 },
  CHC: { lat: 41.9484, lon: -87.6553, cfBearingDeg: 30 },
  CWS: { lat: 41.8299, lon: -87.6338, cfBearingDeg: 40 },
  CHW: { lat: 41.8299, lon: -87.6338, cfBearingDeg: 40 },
  CIN: { lat: 39.0975, lon: -84.5069, cfBearingDeg: 30 },
  CLE: { lat: 41.4962, lon: -81.6852, cfBearingDeg: 0 },
  COL: { lat: 39.7559, lon: -104.9942, cfBearingDeg: 0 },
  DET: { lat: 42.339, lon: -83.0485, cfBearingDeg: 30 },
  HOU: { lat: 29.7573, lon: -95.3555, cfBearingDeg: 20 },
  KC: { lat: 39.0517, lon: -94.4803, cfBearingDeg: 45 },
  LAA: { lat: 33.8003, lon: -117.8827, cfBearingDeg: 45 },
  LAD: { lat: 34.0739, lon: -118.24, cfBearingDeg: 25 },
  MIA: { lat: 25.7781, lon: -80.2197, cfBearingDeg: 40 },
  MIL: { lat: 43.028, lon: -87.9712, cfBearingDeg: 30 },
  MIN: { lat: 44.9817, lon: -93.2776, cfBearingDeg: 15 },
  NYM: { lat: 40.7571, lon: -73.8458, cfBearingDeg: 25 },
  NYY: { lat: 40.8296, lon: -73.9262, cfBearingDeg: 25 },
  OAK: { lat: 37.7516, lon: -122.2005, cfBearingDeg: 60 },
  ATH: { lat: 38.5804, lon: -121.5188, cfBearingDeg: 30 },
  PHI: { lat: 39.9061, lon: -75.1665, cfBearingDeg: 15 },
  PIT: { lat: 40.4469, lon: -80.0057, cfBearingDeg: 40 },
  SD: { lat: 32.7073, lon: -117.1566, cfBearingDeg: 40 },
  SEA: { lat: 47.5914, lon: -122.3325, cfBearingDeg: 45 },
  SF: { lat: 37.7786, lon: -122.3893, cfBearingDeg: 90 },
  STL: { lat: 38.6226, lon: -90.1928, cfBearingDeg: 30 },
  TB: { lat: 27.7683, lon: -82.6534, cfBearingDeg: 0 },
  TEX: { lat: 32.7473, lon: -97.0847, cfBearingDeg: 0 },
  TOR: { lat: 43.6414, lon: -79.3894, cfBearingDeg: 0 },
  WSH: { lat: 38.873, lon: -77.0074, cfBearingDeg: 30 },
};

export function ballparkFor(homeAbbr?: string | null): Ballpark | null {
  if (!homeAbbr) return null;
  return BALLPARKS[homeAbbr.toUpperCase()] ?? null;
}
