# Triple Crown AI — Home Run Model Roadmap

**Goal:** Replace the current real-data *heuristic* HR Score with a real, trained ML system (XGBoost + probability calibration + Monte Carlo + SHAP) that outputs, per hitter per game: **HR Probability**, **Crown Score**, **Confidence grade**, **Value Edge**, and **Reasons**.

**Status:** Planning document. No code has been written yet. This is the roadmap you asked for — data sources, pipeline, infra, cost, phases, and the decisions I need from you before building.

---

## 1. Guardrails (unchanged from the rest of the app)

- **Real data only.** No fabricated features, no synthetic training rows. If a feature source isn't real, the feature is dropped and the UI shows "—", never a made-up value.
- **No leakage.** The model may only use information knowable *before first pitch* (season-to-date stats, probable pitcher, lineup, forecast weather, opening/live odds). Anything computed from the game itself is banned from training features.
- **Honest labeling.** Estimated/derived numbers stay labeled as estimates (same rule as today's "wRC+ (est.)"). A Confidence grade that's really "how much real data backed this pick" is labeled as exactly that.

---

## 2. Where we are today (baseline the model has to beat)

| Piece | Today | Real? |
|---|---|---|
| HR probability | Heuristic in `probability.ts` (BA × park × platoon × weather, `EXPECTED_ABS`) | Real inputs, hand-tuned formula |
| Crown/HR Score | `computeHrScore()` weighted blend (30 barrel / 20 hardHit / 20 xSLG / 10 pitcher HR9 / 10 park / 5 weather / 5 form) | Real inputs, hand-tuned weights |
| Reasons | `AIReasoningChecklist` = the score's own component points | Real, but not model-derived |
| Statcast, pitcher lines, BvP, rosters, schedule, season stats | Live from Baseball Savant + MLB Stats API | **Real** |
| Weather | `modelWeather()` seeded per game | **Simulated** |
| Odds | `modelOdds()` seeded per game | **Simulated** |

**Implication:** the ML model's *training* and *daily prediction* both need real weather (easy, free) and — for Value Edge only — real odds (the hard/paid part). Everything else already has a real source.

---

## 3. Key architectural decision: Python for ML, batch-served into Postgres

The app is a pnpm/TypeScript monorepo. The ML ecosystem (XGBoost, scikit-learn calibration, SHAP, `pybaseball` for Statcast) is Python. Trying to do this in JS would be fighting the toolchain the whole way.

**Recommended shape:**

1. **A new Python package/artifact** (e.g. `services/ml-trainer`) owns: historical data ingestion, feature engineering, training, calibration, evaluation, and a **daily batch prediction job**.
2. The daily job writes finished predictions **into the existing Postgres `predictions` table** (plus a new `hr_reasons` / `hr_model_meta` table for SHAP reasons, confidence, value edge).
3. The **existing Node/Express API keeps serving** — it just reads richer rows. **No Python in the request path.** The React UI barely changes shape; it renders the new fields.

**Why batch, not a live Python API:** we predict ~a few hundred hitters once per day (plus intra-day lineup refreshes). Real-time inference per request buys nothing and adds a fragile cross-language hop. Batch-into-Postgres fits the app's current "sync job writes rows, API reads rows" pattern exactly.

```
pybaseball / MLB API / Open-Meteo / Odds API
        │  (historical + daily)
        ▼
[Python] ingest → feature store (Postgres/parquet)
        │
        ├─ (one-time + weekly) train XGBoost → calibrate → save model artifact (object storage)
        │
        └─ (daily + intra-day) load model → predict today's slate
                   → Monte Carlo → SHAP reasons → Crown Score / Confidence / Value Edge
                   → WRITE to Postgres (predictions + reasons tables)
        ▼
[Node/Express] existing routes read rows  →  [React] Crown Score cards
```

---

## 4. Data sources (all concrete)

| Group | Source | Cost / Key | Notes |
|---|---|---|---|
| **Historical Statcast (training)** | `pybaseball.statcast()` (Baseball Savant) | Free, no key | Pitch-level, 2021–present. ~700k pitches/season → ~2.5–3M+ rows. Scrape in date chunks, cache to parquet. Rate-limited; be polite. |
| **Batter/pitcher season aggregates** | Savant custom leaderboard CSV | Free, no key | Already used in the app (`statcastSync.ts`). Barrel%, HardHit%, xSLG, xwOBA, EV, LA, sprint, splits. |
| **Schedule / rosters / probables / lineups / box** | MLB Stats API (`statsapi.mlb.com`) | Free, no key | Already used. Provides expected PAs context (lineup slot), final HR labels for training. |
| **Weather (real)** | **Open-Meteo** forecast + historical API | Free, no key | By ballpark lat/long. Gives temp, humidity, pressure, wind speed/deg. Air density is computed from temp+humidity+pressure+elevation. Replaces `modelWeather()`. |
| **Ballpark HR factors** | Savant park factors (public) / static table | Free | Roof open/closed for domed parks needs a small static map + game-status. |
| **HR player-prop odds** | **The Odds API** (or OddsJam/SGO) | **Paid — the main recurring cost & risk** | Player HR props are *not* on most free tiers. Coverage varies by book/day. Needed **only** for Value Edge; everything else works without it. |

**Feature coverage vs. your 80–120 spec:** ~85% is directly buildable from the free sources above (all batter Statcast, all pitcher Statcast, park, matchup/handedness, BvP, lineup slot, weather). The gaps are: **live odds/line movement/CLV** (paid), **bullpen quality & team implied runs** (derivable but extra work), and **bat speed / roof state** (bat speed only exists 2024+ Statcast, so it can't be a full-history feature — it'd be optional/recent-only).

---

## 5. Modeling pipeline

**Target (label):** `did_homer` = did this hitter hit ≥1 HR in this game (binary). This matches the product output "Home Run Probability = 31.4%" (per-game, not per-PA). Per-PA HR rate is modeled internally to drive the Monte Carlo.

**1. XGBoost classifier** — main model. Handles the mixed, correlated, non-linear baseball features well. Tune with temporal cross-validation. Address class imbalance (a given hitter homers in roughly 8–14% of games for power bats, less for others) via `scale_pos_weight` / focal-style weighting, evaluated on **log loss + calibration**, not raw accuracy.

**2. Probability calibration** — `CalibratedClassifierCV` (isotonic or Platt). Raw XGBoost scores are not true probabilities; calibration makes "31.4%" mean *31.4% of such players actually homer*. Validate with a reliability curve + Brier score.

**3. Monte Carlo (10k–50k sims/player)** — simulate the hitter's expected plate appearances using the calibrated per-PA HR probability to produce: the game HR probability, a distribution, and a **confidence interval** (drives the Confidence grade).

**4. SHAP (TreeExplainer)** — per-prediction feature attributions → the **Reasons** list ("+ Elite Barrel Rate", "+ Wind Out to Left", "− Weak power vs RHP"). This is the real, model-derived replacement for today's hand-weighted `AIReasoningChecklist`.

**Validation / backtest (non-negotiable before shipping):**
- **Temporal split:** train 2021–2024, validate on 2025, never random split (prevents leakage).
- Metrics: log loss, ROC-AUC, PR-AUC, Brier, calibration curve.
- **Beat the baselines:** must outperform (a) season HR-rate-only and (b) today's heuristic HR Score, or it doesn't ship.

---

## 6. Output computation

- **HR Probability** — calibrated model output (per-game). Stored as decimal 0–1 (same convention as today).
- **Crown Score (0–100)** — your spec's blend: **40% HR probability + 20% contact quality + 15% matchup + 10% weather + 10% ballpark + 5% recent form.** Note this differs from today's HR Score weights, so this is a redefinition, not a tweak — worth confirming.
- **Confidence grade (A+…D)** — from Monte Carlo interval width + data completeness (how many real features were present) + calibration bin. Honest: it measures *how well-supported* the pick is.
- **Value Edge (%)** — `model_prob − devigged_implied_prob_from_odds`. **Requires real odds.** Until odds are wired, this field is hidden (not faked).
- **Reasons** — top ± SHAP contributors, mapped to human labels.

---

## 7. Infrastructure & scheduling on Replit

- **One-time full-history training:** heaviest step (~3M rows). Best run once on a capable machine (a Reserved VM sized up for the job, or locally) and the resulting model artifact committed to **object storage**. Don't try to full-train inside a request or a tiny container.
- **Model artifact storage:** Replit App/object storage (binary model + calibration + feature schema + version).
- **Feature store:** Postgres tables (+ parquet cache for the big historical set).
- **Daily prediction job + weekly retrain:** a **Scheduled Deployment (cron)** running the Python job. ⚠️ Your current nightly refresh is an in-process `setInterval` that only fires on an always-on Reserved VM (already noted in `replit.md` Gotchas). The ML scheduler should be a proper scheduled job, not `setInterval`, so it survives on Autoscale/serverless.
- **Serving:** unchanged Node/Express reading Postgres.

---

## 8. Cost estimate (rough, monthly)

| Item | Estimate | Notes |
|---|---|---|
| Statcast / MLB API / Open-Meteo / park factors | **$0** | Free, no key |
| HR player-prop odds feed | **~$30–100+** | The real recurring cost; only needed for Value Edge. Free tiers generally exclude HR props. |
| Compute — daily predict + weekly retrain | **Reserved VM** tier | Needs an always-on / scheduled machine; sizing depends on retrain frequency |
| Object storage | **~$0–a few $** | Small model artifacts |
| One-time full-history train | One-off compute | Can be done locally to avoid a big VM |

**Bottom line:** you can build and run the *entire model minus Value Edge* at essentially **$0 in data cost** (just compute). Value Edge is the only piece that forces a paid subscription.

---

## 9. Phased delivery plan

| Phase | Deliverable | Depends on | Rough size |
|---|---|---|---|
| **0. Data foundation** | Python service scaffold; historical Statcast ingested to parquet/Postgres; **real weather (Open-Meteo)** replacing seeded weather; park-factor table | — | Medium |
| **1. Baseline model** | Feature engineering; XGBoost trained + **calibrated**; temporal backtest report proving it beats season-rate + current heuristic | 0 | Large |
| **2. Simulation + explainability** | Monte Carlo → confidence intervals; SHAP → Reasons | 1 | Medium |
| **3. Serving integration** | Daily batch job writes predictions + reasons to Postgres; API returns new fields; UI shows the **Crown Score card** (Crown Score / HR Prob / Confidence / Reasons) | 2 | Medium |
| **4. Value Edge** | Connect real odds feed; de-vig; compute + display edge | 3 + odds budget | Small–Medium |
| **5. Automation + monitoring** | Scheduled retrain (cron, not setInterval); drift/calibration monitoring; model versioning | 3 | Medium |

Phases 0–3 deliver the full "Crown Score card with real model-driven reasons." Phase 4 (Value Edge) is gated only by the odds budget. Phase 5 makes it self-updating.

---

## 10. Risks & mitigations

- **Odds availability/cost** — HR props are sparse and paid. *Mitigation:* build everything else first; treat Value Edge as an optional final layer; hide it rather than fake it.
- **Statcast scraping limits / Savant changes** — *Mitigation:* chunked polite scraping, parquet cache so you re-pull only new dates.
- **Data leakage** — the classic way sports models look great and fail live. *Mitigation:* strict pre-first-pitch feature cutoff + temporal validation.
- **Class imbalance / overconfidence** — *Mitigation:* calibration + Brier/reliability as primary metrics.
- **Model drift over a season** — *Mitigation:* weekly retrain + monitoring (Phase 5).
- **Replit compute for training** — *Mitigation:* full-history train once off-box; keep in-cluster jobs to lighter daily predict + incremental retrain.
- **New language in the repo** — Python alongside pnpm/TS is a real addition to maintain. *Mitigation:* isolate it as one service with a clean Postgres hand-off; the TS side never imports Python.

---

## 11. Decisions I need from you before Phase 0

1. **Crown Score redefinition** — adopt your spec's 40/20/15/10/10/5 weights (this changes what today's score means), or keep today's weights and add the ML probability alongside?
2. **Value Edge budget** — are you willing to pay for an HR-props odds feed (~$30–100+/mo)? If not now, I build Phases 0–3 and 5, and leave Value Edge as a stub.
3. **Adopt Python service** — OK to add a Python ML service to the monorepo (the batch-into-Postgres design above)?
4. **Real weather now** — swap the seeded weather for Open-Meteo as part of Phase 0 (this is a free, strict upgrade and also feeds the model)?
5. **Scope of first build** — do you want me to start with just **Phase 0 + a Phase 1 baseline** (prove a calibrated model beats the current heuristic) before committing to the full pipeline?

Once you answer these, I'll turn the chosen phases into a concrete implementation plan and start building.
