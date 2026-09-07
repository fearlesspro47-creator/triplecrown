import type { HrScoreComponent, HrScoreMeta } from "@workspace/db";

// Shared hit/HR probability model used by both the lineup optimizer and the daily
// prediction sync so the two never drift. All inputs are real per-day matchup data
// (opposing probable pitcher hand, home ballpark, weather) where available.

// HR park factors keyed by the HOME team's abbreviation (MLB Stats API abbreviations).
// >1 favors hitters. Modeled values; only the relative ordering matters for the model.
export const PARK_FACTORS: Record<string, number> = {
  COL: 1.15, CIN: 1.12, NYY: 1.08, PHI: 1.07, BAL: 1.06, CHC: 1.05, BOS: 1.04,
  CWS: 1.04, TEX: 1.03, MIL: 1.03, AZ: 1.03, ARI: 1.03, HOU: 1.02, ATL: 1.02,
  LAD: 1.02, TOR: 1.02, WSH: 1.00, MIN: 1.00, LAA: 1.00, STL: 0.98, CLE: 0.97,
  NYM: 0.97, KC: 0.97, PIT: 0.97, TB: 0.96, DET: 0.96, SD: 0.95, MIA: 0.95,
  ATH: 0.95, OAK: 0.95, SEA: 0.94, SF: 0.92,
};

// Typical MLB game: ~3.8 plate appearances and ~4 at-bats per hitter.
export const EXPECTED_ABS = 3.8;
export const HR_AT_BATS = 4;

export function parkFactorFor(homeAbbr?: string | null): number {
  return PARK_FACTORS[(homeAbbr ?? "").toUpperCase()] ?? 1.0;
}

// A hitter has the platoon edge vs an opposite-handed pitcher; switch hitters always do.
export function hasPlatoonAdvantage(batterHand?: string | null, pitcherHand?: string | null): boolean {
  if (!batterHand || !pitcherHand) return false;
  const b = batterHand.toUpperCase();
  const p = pitcherHand.toUpperCase();
  if (b === "S") return true;
  return (b === "L" && p === "R") || (b === "R" && p === "L");
}

// P(at least one hit in the game) = 1 - (1 - adjustedBA)^expectedABs.
export function computeHitProbability(opts: {
  battingAvg: number;
  batterHand?: string | null;
  pitcherHand?: string | null;
  parkFactor: number;
  weatherHrBoost?: number; // e.g. 1.02 = wind blowing out
}): number {
  const rawBA = Number.isFinite(opts.battingAvg) ? opts.battingAvg : 0.26;
  // Platoon: ~15 pts of BA when known; small penalty at a disadvantage. Neutral if unknown.
  const platoonAdj = opts.pitcherHand
    ? hasPlatoonAdvantage(opts.batterHand, opts.pitcherHand)
      ? 0.015
      : -0.008
    : 0;
  const parkContactAdj = (opts.parkFactor - 1.0) * 0.02;
  const weatherHitAdj = (opts.weatherHrBoost ?? 1) < 1 ? -0.005 : 0;
  const adjustedBA = Math.min(0.42, Math.max(0.18, rawBA + platoonAdj + parkContactAdj + weatherHitAdj));
  return 1 - Math.pow(1 - adjustedBA, EXPECTED_ABS);
}

// P(at least one HR in the game). Closed form of the per-at-bat Monte Carlo HR sim.
export function computeHrProbability(opts: {
  hrRate: number; // HR per at-bat
  parkFactor: number;
  weatherHrBoost?: number;
}): number {
  const base = Number.isFinite(opts.hrRate) ? opts.hrRate : 0.04;
  const perAb = Math.min(0.35, Math.max(0, base * opts.parkFactor * (opts.weatherHrBoost ?? 1)));
  return 1 - Math.pow(1 - perAb, HR_AT_BATS);
}

// ---- Model-fair betting odds -----------------------------------------------------------
// Convert a model win-probability (0-1) into FAIR American odds (no sportsbook margin). These
// are the app's OWN model prices, not a real book's line. Clamped so a 0/1 probability can't
// produce ±Infinity, and rounded to the nearest 5 so it reads like a posted price.
export function probabilityToAmericanOdds(prob: number): number {
  const p = Math.min(0.95, Math.max(0.01, Number.isFinite(prob) ? prob : 0.01));
  const decimal = 1 / p; // fair decimal odds
  const american = decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
  return Math.round(american / 5) * 5;
}

// ---- Composite HR Score (0-100) --------------------------------------------------------
// A weighted blend of quality-of-contact (Statcast), matchup, and context factors. Unlike
// the HR% probability, this is a *ranking score* that expresses relative HR upside.
// v2 adds two real batter-vs-pitcher matchup components (pitch-matchup ISO + pitcher platoon
// HR rate) and rebalances the quality-of-contact + generic pitcher-HR weights to fund them.
export const HR_SCORE_MODEL_VERSION = "hrscore-v2";

// Product-specified weights; must sum to 1.0. `pitchMatchup` = the hitter's AB-weighted ISO
// against the pitch families the opposing starter leans on; `platoonHr` = that starter's real
// season HR-per-AB allowed to the hitter's batting side. The generic `pitcherHr9` weight is
// reduced (0.10 -> 0.05) because `platoonHr` is the more targeted version of the same signal.
export const HR_SCORE_WEIGHTS = {
  barrelRate: 0.25,
  hardHitRate: 0.15,
  xslg: 0.15,
  pitchMatchup: 0.1,
  pitcherHr9: 0.05,
  platoonHr: 0.1,
  parkFactor: 0.1,
  weather: 0.05,
  recentForm: 0.05,
} as const;

type HrScoreKey = keyof typeof HR_SCORE_WEIGHTS;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const normRange = (v: number, min: number, max: number) => clamp01((v - min) / (max - min));

export interface HrScoreInputs {
  barrelRate?: number | null; // 0-1 (Statcast)
  hardHitRate?: number | null; // 0-1 (Statcast)
  xslg?: number | null; // expected SLG, e.g. 0.55
  pitchMatchupIso?: number | null; // hitter AB-weighted ISO vs the SP's go-to pitch families
  pitcherHr9?: number | null; // opposing probable SP season HR/9 (higher favors the hitter)
  platoonHrPerAb?: number | null; // SP season HR allowed per AB vs the hitter's batting side
  parkFactor: number; // home-park HR factor, ~1.0
  weatherHrBoost?: number | null; // modeled weather HR boost, ~1.0
  recentForm?: number | null; // pre-normalized 0-1 recent form (from game logs)
}

interface Spec {
  key: HrScoreKey;
  label: string;
  raw: number | null;
  // null => data source truly absent: drop the component and renormalize remaining weights.
  normalized: number | null;
  available: boolean;
}

// Statcast metric: if missing, drop it and renormalize (don't invent quality-of-contact).
function statSpec(key: HrScoreKey, label: string, raw: number | null | undefined, min: number, max: number): Spec {
  if (raw == null || !Number.isFinite(raw)) return { key, label, raw: null, normalized: null, available: false };
  return { key, label, raw, normalized: normRange(raw, min, max), available: true };
}

// Matchup/context metric that always applies to a game: if missing, use a neutral 0.5 so a
// temporary data gap (e.g. an unfetched pitcher HR/9) doesn't unfairly deflate the score.
function neutralSpec(key: HrScoreKey, label: string, raw: number | null | undefined, min: number, max: number): Spec {
  if (raw == null || !Number.isFinite(raw)) return { key, label, raw: null, normalized: 0.5, available: false };
  return { key, label, raw, normalized: normRange(raw, min, max), available: true };
}

// MLB-realistic ranges below map each raw metric onto 0-1 before weighting.
export function computeHrScore(inputs: HrScoreInputs): HrScoreMeta {
  const specs: Spec[] = [
    statSpec("barrelRate", "Barrel %", inputs.barrelRate, 0.03, 0.2),
    statSpec("hardHitRate", "Hard Hit %", inputs.hardHitRate, 0.3, 0.55),
    statSpec("xslg", "xSLG", inputs.xslg, 0.35, 0.65),
    // Real pitch-matchup power (drop + renormalize when no qualifying pitch-mix/arsenal data).
    statSpec("pitchMatchup", "Pitch Matchup ISO", inputs.pitchMatchupIso, 0.1, 0.3),
    neutralSpec("pitcherHr9", "Pitcher HR/9", inputs.pitcherHr9, 0.6, 2.0),
    // Pitcher HR-per-AB allowed to the hitter's side (neutral 0.5 on a small/absent split sample).
    neutralSpec("platoonHr", "Platoon HR", inputs.platoonHrPerAb, 0.015, 0.06),
    {
      key: "parkFactor",
      label: "Park Factor",
      raw: inputs.parkFactor,
      normalized: normRange(inputs.parkFactor, 0.92, 1.15),
      available: true,
    },
    neutralSpec("weather", "Weather", inputs.weatherHrBoost, 0.9, 1.12),
    inputs.recentForm == null || !Number.isFinite(inputs.recentForm)
      ? { key: "recentForm", label: "Recent Form", raw: null, normalized: 0.5, available: false }
      : {
          key: "recentForm",
          label: "Recent Form",
          raw: inputs.recentForm,
          normalized: clamp01(inputs.recentForm),
          available: true,
        },
  ];

  // Renormalize nominal weights over the components that are actually included.
  const includedWeight = specs.reduce((s, d) => (d.normalized === null ? s : s + HR_SCORE_WEIGHTS[d.key]), 0) || 1;

  const components: HrScoreComponent[] = specs.map((d) => {
    const weight = HR_SCORE_WEIGHTS[d.key];
    const effectiveWeight = d.normalized === null ? 0 : weight / includedWeight;
    const normalized = d.normalized ?? 0;
    return {
      key: d.key,
      label: d.label,
      weight,
      effectiveWeight,
      raw: d.raw,
      normalized,
      points: normalized * effectiveWeight * 100,
      available: d.available,
    };
  });

  const score = components.reduce((s, c) => s + c.points, 0);
  return { score: Math.round(score * 10) / 10, modelVersion: HR_SCORE_MODEL_VERSION, components };
}
