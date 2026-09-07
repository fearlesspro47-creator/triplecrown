// Pure, DB-free "why the model likes this matchup" narrative builder. Given a hitter's real
// power-by-pitch-family, quality-of-contact profile, the opposing starter's real pitch-usage
// arsenal + batter-side (vs L / vs R) HR splits, ballpark weather, BvP history, and the ML model's
// top SHAP reason, it composes a short scouting-card blurb plus a few structured highlight chips.
// Real-or-nothing: every clause is gated on real data and the whole thing returns null when no
// favorable, real angle exists (never a fabricated insight).

export interface MatchupInsightArsenal {
  pitchType: string; // family code (FF, SI, ...)
  pitchName: string | null; // human label
  usage: number; // 0-1 share of pitches thrown
}

export interface MatchupInsightPitchMix {
  pitchType: string; // family code
  iso: number | null; // hitter ISO vs this family
  homeRuns: number; // hitter HR vs this family
  atBats: number; // sample size
}

// Hitter overall quality-of-contact (Statcast season).
export interface MatchupInsightProfile {
  barrelRate: number | null; // 0-1
  exitVelocity: number | null; // mph average
}

// A starter's real season line vs one batter side.
export interface MatchupInsightPlatoon {
  batSide: "L" | "R";
  homeRuns: number;
  atBats: number;
}

export interface MatchupInsightWeather {
  windDirection: string; // ballpark-relative ("Out to CF", "In from CF", "Calm", ...)
  hrBoostFactor: number; // multiplier centered on 1.0 (>1 favors HR)
  temperature: number; // °F
}

export interface MatchupInsightBvp {
  seasonAb: number;
  seasonHr: number;
  careerAb: number;
  careerHr: number;
}

export interface MatchupInsightReason {
  label: string;
  direction: "positive" | "negative";
  impact: number;
}

export interface MatchupInsightContext {
  batterName: string;
  pitcherName: string | null;
  batterHand: string | null; // L / R / S
  pitcherHand: string | null; // L / R
  arsenal: MatchupInsightArsenal[];
  pitchMix: MatchupInsightPitchMix[];
  profile: MatchupInsightProfile | null;
  platoonSplits: MatchupInsightPlatoon[] | null;
  weather: MatchupInsightWeather | null;
  bvp: MatchupInsightBvp | null;
  mlReasons: MatchupInsightReason[] | null;
}

export interface MatchupInsightHighlight {
  label: string;
  value: string;
}

export interface MatchupInsight {
  text: string;
  highlights: MatchupInsightHighlight[];
}

// A clause carries its own highlight chips so that when the length cap drops a clause, its chips
// drop with it (no orphan chip backing a sentence that isn't shown).
interface Clause {
  text: string;
  highlights: MatchupInsightHighlight[];
}

// Gate thresholds — all chosen so a clause only fires on a genuine, above-average positive.
const USAGE_MIN = 0.2; // pitcher must throw a family enough to be a real "go-to" pitch
const AB_MIN = 15; // enough hitter sample for a trustworthy power-vs-family
const ISO_MIN = 0.18; // above roughly league-average ISO (~.16) to count as a strength
const PROFILE_BARREL_MIN = 0.1; // above league-average barrel rate (~8%) to be a real positive
const PLATOON_AB_MIN = 50; // enough batters faced from that side for a trustworthy HR rate
const PLATOON_HR_MIN = 4; // only a meaningfully homer-prone split
const PLATOON_RATE_MIN = 0.035; // and above roughly league-average HR-per-AB (~.033)
const HR_BOOST_MIN = 1.03; // ballpark carry must be meaningfully above neutral
const TEMP_WARM = 80; // warm-air carry angle when there's no wind boost
const BVP_AB_MIN = 10; // enough head-to-head history to be meaningful
const BVP_HR_MIN = 1; // only a positive (has gone deep) angle
const MAX_TEXT = 300; // length cap; env clauses drop first, then trailing batter clauses

function fmtRatio(n: number): string {
  const s = n.toFixed(3);
  return n < 1 ? s.replace(/^0/, "") : s; // ".286", but "1.120" keeps its leading 1
}

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

export function buildMatchupInsight(ctx: MatchupInsightContext): MatchupInsight | null {
  const batterClauses: Clause[] = []; // hitter is the grammatical subject
  const envClauses: Clause[] = []; // environment / pitcher / model
  const pitcherLabel = ctx.pitcherName ?? "the opposing starter";

  // 1. Pitch matchup — the hitter's HR + AB-weighted ISO across the pitch families the starter
  //    actually leans on (usage >= 20%). Usage-gated arsenal ∩ the hitter's power-by-family,
  //    sample-gated (>=15 AB), fired only when the aggregate ISO is a genuine strength.
  const topFams = ctx.arsenal.filter((a) => a.usage >= USAGE_MIN).sort((a, b) => b.usage - a.usage);
  const topSet = new Set(topFams.map((a) => a.pitchType));
  if (topSet.size) {
    let hrSum = 0;
    let abSum = 0;
    let isoAb = 0;
    let hasIso = false;
    for (const m of ctx.pitchMix) {
      if (!topSet.has(m.pitchType)) continue;
      hrSum += m.homeRuns;
      if (m.iso != null && m.atBats > 0) {
        abSum += m.atBats;
        isoAb += m.iso * m.atBats;
        hasIso = true;
      }
    }
    const iso = hasIso && abSum >= AB_MIN ? isoAb / abSum : null;
    if (iso != null && iso >= ISO_MIN) {
      const famNames = topFams.slice(0, 2).map((a) => (a.pitchName ?? a.pitchType).toLowerCase());
      const famPhrase = famNames.length ? ` (${joinClauses(famNames)})` : "";
      const power = hrSum >= 1 ? `${hrSum} HR and a ${fmtRatio(iso)} ISO` : `a ${fmtRatio(iso)} ISO`;
      batterClauses.push({
        text: `has ${power} against the pitches ${pitcherLabel} throws most${famPhrase}`,
        highlights: [
          { label: "ISO vs top pitches", value: fmtRatio(iso) },
          ...(hrSum >= 1 ? [{ label: "HR vs top pitches", value: String(hrSum) }] : []),
        ],
      });
    }
  }

  // 2. Quality of contact — the hitter's overall barrel rate (+ average exit velocity), gated so it
  //    only fires when it's a genuine above-average power profile.
  if (ctx.profile && ctx.profile.barrelRate != null && ctx.profile.barrelRate >= PROFILE_BARREL_MIN) {
    const barrelPct = (ctx.profile.barrelRate * 100).toFixed(1);
    const ev = ctx.profile.exitVelocity;
    const evPhrase = ev != null ? ` with a ${Math.round(ev)} mph average exit velocity` : "";
    batterClauses.push({
      text: `barrels ${barrelPct}% of batted balls${evPhrase}`,
      highlights: [
        { label: "Barrel%", value: `${barrelPct}%` },
        ...(ev != null ? [{ label: "Avg EV", value: `${Math.round(ev)} mph` }] : []),
      ],
    });
  }

  // 3. Batter-vs-pitcher — only a positive (has homered) angle with enough history.
  if (ctx.bvp && ctx.bvp.careerAb >= BVP_AB_MIN && ctx.bvp.careerHr >= BVP_HR_MIN) {
    const { careerHr, careerAb } = ctx.bvp;
    batterClauses.push({
      text: `has ${careerHr} career HR in ${careerAb} AB vs ${pitcherLabel}`,
      highlights: [{ label: "Career vs SP", value: `${careerHr} HR / ${careerAb} AB` }],
    });
  }

  // 4. Pitcher platoon HR — the starter's real season HR allowed to the hitter's batting side
  //    (switch hitters bat opposite the pitcher's hand). Fired only for a homer-prone split.
  const bh = (ctx.batterHand ?? "").toUpperCase();
  const ph = (ctx.pitcherHand ?? "").toUpperCase();
  const effSide: "L" | "R" | null =
    bh === "L" ? "L" : bh === "R" ? "R" : bh === "S" ? (ph === "R" ? "L" : ph === "L" ? "R" : null) : null;
  if (effSide && ctx.platoonSplits) {
    const ps = ctx.platoonSplits.find((s) => s.batSide === effSide);
    if (
      ps &&
      ps.atBats >= PLATOON_AB_MIN &&
      ps.homeRuns >= PLATOON_HR_MIN &&
      ps.homeRuns / ps.atBats >= PLATOON_RATE_MIN
    ) {
      const sideWord = effSide === "L" ? "left-handed hitters" : "right-handed hitters";
      envClauses.push({
        text: `${pitcherLabel} has allowed ${ps.homeRuns} HR to ${sideWord} this season`,
        highlights: [{ label: `HR to ${effSide}HH`, value: String(ps.homeRuns) }],
      });
    }
  }

  // 5. Ballpark carry — wind/air boost, else a warm-temperature carry angle.
  if (ctx.weather && ctx.weather.hrBoostFactor >= HR_BOOST_MIN) {
    const boostPct = Math.round((ctx.weather.hrBoostFactor - 1) * 100);
    const dir = (ctx.weather.windDirection ?? "").toLowerCase();
    const windPhrase = dir.startsWith("out") ? `wind ${dir}, ` : "";
    envClauses.push({
      text: `ballpark conditions favor carry (${windPhrase}+${boostPct}% HR)`,
      highlights: [{ label: "HR boost", value: `+${boostPct}%` }],
    });
  } else if (ctx.weather && ctx.weather.temperature >= TEMP_WARM) {
    const t = Math.round(ctx.weather.temperature);
    envClauses.push({
      text: `warm ${t}° air aids carry`,
      highlights: [{ label: "Temp", value: `${t}°` }],
    });
  }

  // 6. Model edge — the top HR-raising SHAP reason. Added ONLY as a supporting clause: essentially
  //    every rated hitter has some positive SHAP reason, so on its own it would fire a "why the model
  //    likes this matchup" blurb even for a pick the model ranks poorly. Require at least one concrete,
  //    matchup-specific angle first — so the model reason only colors an already-justified pick.
  if (batterClauses.length > 0 || envClauses.length > 0) {
    const topReason = (ctx.mlReasons ?? [])
      .filter((r) => r.direction === "positive")
      .sort((a, b) => b.impact - a.impact)[0];
    if (topReason) {
      envClauses.push({
        text: `the model flags ${topReason.label.toLowerCase()}`,
        highlights: [{ label: "Model edge", value: topReason.label }],
      });
    }
  }

  if (batterClauses.length === 0 && envClauses.length === 0) return null;

  const compose = (batter: Clause[], env: Clause[]): string => {
    let text = "";
    if (batter.length) text = `${ctx.batterName} ${joinClauses(batter.map((c) => c.text))}.`;
    if (env.length) {
      const s = joinClauses(env.map((c) => c.text));
      const sentence = s.charAt(0).toUpperCase() + s.slice(1) + ".";
      text = text ? `${text} ${sentence}` : sentence;
    }
    return text;
  };

  // Length cap: drop the lowest-priority (last) env clause first, then trailing batter clauses,
  // always keeping at least one clause so the surviving text is never empty.
  let batter = [...batterClauses];
  let env = [...envClauses];
  let text = compose(batter, env);
  while (text.length > MAX_TEXT && env.length > 0) {
    env = env.slice(0, -1);
    text = compose(batter, env);
  }
  while (text.length > MAX_TEXT && batter.length > 1) {
    batter = batter.slice(0, -1);
    text = compose(batter, env);
  }

  // Highlights track only the surviving clauses, so a dropped clause never leaves an orphan chip.
  const highlights = [...batter, ...env].flatMap((c) => c.highlights).slice(0, 4);

  return { text, highlights };
}
