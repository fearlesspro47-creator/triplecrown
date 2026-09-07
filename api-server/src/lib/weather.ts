// Real forecast weather from Open-Meteo (free, no API key), by ballpark. Replaces the old
// deterministic modelWeather(). Fetches the hourly forecast nearest each game's start time and
// derives an HR boost factor from the transient, park-independent conditions that actually move
// fly-ball carry: temperature, humidity, and the wind component blowing out toward center field.
//
// Real data only: if the forecast fetch fails or the ballpark is unknown, we return null and the
// caller simply omits the weather row (never fabricates one). Persistent park effects (elevation,
// dimensions) are already captured by PARK_FACTORS, so this factor is centered on 1.0 and reflects
// only the day's weather deviation — it is deliberately NOT an absolute park HR factor.

import type { InsertWeather } from "@workspace/db";
import { ballparkFor } from "./ballparks";
import { logger } from "./logger";

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";

interface OpenMeteoHourly {
  time: string[];
  temperature_2m: (number | null)[];
  apparent_temperature: (number | null)[];
  relative_humidity_2m: (number | null)[];
  wind_speed_10m: (number | null)[];
  wind_direction_10m: (number | null)[];
  precipitation_probability: (number | null)[];
  weather_code: (number | null)[];
}

const TWO_WORD_NICK = new Set(["Red Sox", "White Sox", "Blue Jays"]);
function cityFromTeam(name: string): string {
  const parts = name.trim().split(/\s+/);
  const lastTwo = parts.slice(-2).join(" ");
  const city = TWO_WORD_NICK.has(lastTwo) ? parts.slice(0, -2).join(" ") : parts.slice(0, -1).join(" ");
  return city || name;
}

// WMO weather codes -> short human labels (matches the app's existing condition vocabulary).
function conditionFromCode(code: number | null): string {
  if (code == null) return "Clear";
  if (code === 0) return "Clear";
  if (code === 1 || code === 2) return "Partly Cloudy";
  if (code === 3) return "Cloudy";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 67) return "Light Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain Showers";
  if (code >= 85 && code <= 86) return "Snow Showers";
  if (code >= 95) return "Thunderstorm";
  return "Cloudy";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchForecast(lat: number, lon: number, attempts = 3): Promise<OpenMeteoHourly | null> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly:
      "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation_probability,weather_code",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    timezone: "UTC",
    forecast_days: "2",
    past_days: "1",
  });
  const url = `${OPEN_METEO}?${params.toString()}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
      const json = (await res.json()) as { hourly?: OpenMeteoHourly };
      if (!json.hourly?.time?.length) throw new Error("Open-Meteo empty hourly");
      return json.hourly;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(attempt * 500);
    }
  }
  logger.warn({ err: lastErr, lat, lon }, "Open-Meteo forecast fetch failed; omitting weather for game");
  return null;
}

// Index of the hourly bucket nearest the game's start (both compared in UTC epoch ms).
// Open-Meteo hourly times are "YYYY-MM-DDTHH:mm" with no zone suffix; requested as UTC.
function nearestHourIndex(times: string[], gameTimeIso: string): number {
  const target = Date.parse(gameTimeIso);
  if (!Number.isFinite(target)) return Math.floor(times.length / 2);
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    const ms = Date.parse(t.endsWith("Z") ? t : `${t}Z`);
    if (!Number.isFinite(ms)) continue;
    const diff = Math.abs(ms - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

const clampBoost = (x: number) => Math.max(0.9, Math.min(1.12, x));
const norm360 = (d: number) => ((d % 360) + 360) % 360;

// Signed wind component along the home-plate -> CF axis. Open-Meteo wind_direction is the
// direction the wind blows FROM (meteorological), so the blowing-TO direction is +180.
// Positive result = blowing out toward center field.
function windOutMph(speedMph: number, windFromDeg: number, cfBearingDeg: number): number {
  const windToDeg = norm360(windFromDeg + 180);
  const theta = ((windToDeg - cfBearingDeg) * Math.PI) / 180;
  return speedMph * Math.cos(theta);
}

function windLabel(speedMph: number, windFromDeg: number, cfBearingDeg: number): string {
  if (speedMph < 3) return "Calm";
  const out = windOutMph(speedMph, windFromDeg, cfBearingDeg);
  const windToDeg = norm360(windFromDeg + 180);
  const cross = speedMph * Math.sin(((windToDeg - cfBearingDeg) * Math.PI) / 180);
  if (Math.abs(out) >= Math.abs(cross)) return out > 0 ? "Out to CF" : "In from CF";
  return cross > 0 ? "L to R" : "R to L";
}

export async function fetchGameWeather(game: {
  id: number;
  homeTeamAbbr: string | null;
  homeTeam: string;
  venue: string;
  gameTime: string;
}): Promise<InsertWeather | null> {
  const park = ballparkFor(game.homeTeamAbbr);
  if (!park) {
    logger.warn({ abbr: game.homeTeamAbbr }, "Unknown ballpark for weather; omitting weather row");
    return null;
  }
  const hourly = await fetchForecast(park.lat, park.lon);
  if (!hourly) return null;

  const i = nearestHourIndex(hourly.time, game.gameTime);
  const temp = hourly.temperature_2m[i];
  const windSpeed = hourly.wind_speed_10m[i];
  const windFrom = hourly.wind_direction_10m[i];
  if (temp == null || windSpeed == null || windFrom == null) {
    logger.warn({ gameId: game.id }, "Open-Meteo returned nulls for game hour; omitting weather row");
    return null;
  }
  const humidity = hourly.relative_humidity_2m[i];
  const feels = hourly.apparent_temperature[i];
  const rain = hourly.precipitation_probability[i];
  const code = hourly.weather_code[i];

  const out = windOutMph(windSpeed, windFrom, park.cfBearingDeg);
  // Transient, park-independent HR boost: temperature (~1%/10F), wind out to CF (~0.6%/mph),
  // and a small humidity term (humid air is slightly less dense). Clamped 0.90-1.12.
  const tempEffect = (temp - 70) * 0.001;
  const windEffect = out * 0.006;
  const humidityEffect = humidity != null ? (humidity - 50) * 0.0002 : 0;
  const boost = clampBoost(1.0 + tempEffect + windEffect + humidityEffect);

  return {
    gameId: game.id,
    stadium: game.venue || "TBD",
    city: cityFromTeam(game.homeTeam),
    temperature: temp.toFixed(1),
    feelsLike: feels != null ? feels.toFixed(1) : null,
    humidity: humidity != null ? humidity.toFixed(1) : null,
    windSpeed: windSpeed.toFixed(1),
    windDirection: windLabel(windSpeed, windFrom, park.cfBearingDeg),
    windDeg: windFrom.toFixed(1),
    condition: conditionFromCode(code),
    conditionIcon: null,
    hrBoostFactor: boost.toFixed(3),
    rainProbability: rain != null ? rain.toFixed(1) : null,
  };
}
