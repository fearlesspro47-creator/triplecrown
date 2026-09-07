"""Static ballpark reference: HR park factors + coordinates.

PARK_FACTORS are kept IN SYNC with the Node side
(artifacts/api-server/src/lib/probability.ts) so the model and the app agree.
Multiplier centered on 1.0 (>1 favors HRs). Keyed by the home team's Statcast
abbreviation. Lat/long are the stadium locations (for Open-Meteo weather joins).
"""

from __future__ import annotations

# Mirror of PARK_FACTORS in probability.ts (keep in lockstep).
PARK_FACTORS: dict[str, float] = {
    "COL": 1.15, "CIN": 1.12, "NYY": 1.08, "PHI": 1.07, "BAL": 1.06,
    "CHC": 1.05, "BOS": 1.04, "CWS": 1.04, "TEX": 1.03, "MIL": 1.03,
    "AZ": 1.03, "ARI": 1.03, "HOU": 1.02, "ATL": 1.02, "LAD": 1.02,
    "TOR": 1.02, "WSH": 1.00, "MIN": 1.00, "LAA": 1.00, "STL": 0.98,
    "CLE": 0.97, "NYM": 0.97, "KC": 0.97, "PIT": 0.97, "TB": 0.96,
    "DET": 0.96, "SD": 0.95, "MIA": 0.95, "ATH": 0.95, "OAK": 0.95,
    "SEA": 0.94, "SF": 0.92,
}

# Stadium coordinates (approx, for weather lookups). Keyed by Statcast home abbr.
BALLPARK_COORDS: dict[str, tuple[float, float]] = {
    "AZ": (33.4455, -112.0667), "ARI": (33.4455, -112.0667),
    "ATL": (33.8907, -84.4677), "BAL": (39.2839, -76.6217),
    "BOS": (42.3467, -71.0972), "CHC": (41.9484, -87.6553),
    "CWS": (41.8299, -87.6338), "CIN": (39.0975, -84.5069),
    "CLE": (41.4962, -81.6852), "COL": (39.7559, -104.9942),
    "DET": (42.3390, -83.0485), "HOU": (29.7573, -95.3555),
    "KC": (39.0517, -94.4803), "LAA": (33.8003, -117.8827),
    "LAD": (34.0739, -118.2400), "MIA": (25.7781, -80.2197),
    "MIL": (43.0280, -87.9712), "MIN": (44.9817, -93.2776),
    "NYM": (40.7571, -73.8458), "NYY": (40.8296, -73.9262),
    "OAK": (37.7516, -122.2005), "ATH": (37.7516, -122.2005),
    "PHI": (39.9061, -75.1665), "PIT": (40.4469, -80.0057),
    "SD": (32.7073, -117.1566), "SEA": (47.5914, -122.3325),
    "SF": (37.7786, -122.3893), "STL": (38.6226, -90.1928),
    "TB": (27.7683, -82.6534), "TEX": (32.7473, -97.0847),
    "TOR": (43.6414, -79.3894), "WSH": (38.8730, -77.0074),
}

NEUTRAL_PARK_FACTOR = 1.0


def park_factor_for(home_abbr: str | None) -> float:
    if not home_abbr:
        return NEUTRAL_PARK_FACTOR
    return PARK_FACTORS.get(home_abbr.upper(), NEUTRAL_PARK_FACTOR)
