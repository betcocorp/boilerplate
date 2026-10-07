/**
 * B0-716 — the single home for every speed threshold, weight, band edge and label used by the
 * eval report.
 *
 * The reference methodology's rule is that these numbers live in exactly one file and are
 * hard-coded nowhere else, so a report can always print the thresholds that were actually in
 * force when it graded. Anything in `src/lib/tests/report/` that needs a speed number imports it
 * from here rather than restating it — a restated literal is how the scorecard and the stated
 * methodology drift apart.
 *
 * B0-717 removed the last restatement (`latencyBlock`'s `goodThreshold = 5` / `slowThreshold = 10`
 * function defaults, now `SPEED_THRESHOLDS.total`), so this file is the only home again. Keep it
 * that way.
 *
 * The maths here is deliberately pure and synchronous. Any settings-backed override is resolved
 * at the edge by `loadSpeedThresholds()` and passed *in*; `normalizeSpeed` never reads config.
 *
 * `loadSpeedThresholds()` is **not yet wired into the report path** — `speedBlock` uses the shipped
 * defaults synchronously, because `computeReportMetrics` and `assembleReportCases` are both pure
 * and sync, and threading resolved thresholds through would make the whole assembly chain async.
 * With no `REPORT_SPEED_*` rows configured the two are identical, but a future settings override
 * will not take effect until someone does that work.
 */

export type SpeedMetric = 'ttft' | 'total';

/**
 * Band a single measurement falls in. Only three bands, matching the existing latency block in
 * `./metrics.ts`: `poor` and `floor` are curve anchors, not bands — past `acceptable` everything
 * is simply `slow`.
 */
export type SpeedBand = 'good' | 'acceptable' | 'slow';

/**
 * Rating labels for a 0-100 speed score. Deliberately words, not letters: the content score uses
 * A-F (`Grade` in `./metrics.ts`) and a reader who sees a "B" next to a "B" in the same document
 * will assume they mean the same thing. They do not — one is answer quality, the other is
 * responsiveness, and §7 of the methodology forbids blending them. Never map these onto letters.
 */
export type SpeedRating = 'Excellent' | 'Good' | 'Acceptable' | 'Slow' | 'Very slow';

export type SpeedThresholds = {
  /** Fast enough that nobody notices — the `good` band edge and the 90-point anchor. */
  good: number;
  /** Noticeable but tolerable — the `acceptable` band edge and the 70-point anchor. */
  acceptable: number;
  /** Bad, but still a real measurement — the 40-point anchor. Not a band edge. */
  poor: number;
  /** At or beyond this the score is 0; slower changes nothing. Not a band edge. */
  floor: number;
};

/**
 * Seconds thresholds per metric. `total` reproduces the 5 s / 10 s pair already in use by
 * `latencyBlock`, unchanged — this module moves those numbers, it does not retune them. `ttft`
 * is stricter because time-to-first-token is what a user experiences as "did it hear me".
 */
export const SPEED_THRESHOLDS: Readonly<Record<SpeedMetric, SpeedThresholds>> = {
  ttft: { good: 2, acceptable: 5, poor: 10, floor: 20 },
  total: { good: 5, acceptable: 10, poor: 20, floor: 40 },
};

/**
 * Score awarded at each threshold, plus the 100 at 0 s. `normalizeSpeed` interpolates linearly
 * between consecutive anchors and clamps outside them.
 *
 * Note the property this buys, and preserve it in any future edit: the two band edges (`good`
 * and `acceptable`) ARE curve anchors, at 90 and 70. That makes band membership and score
 * strictly equivalent — `band === 'good'` iff `score >= 90`, `band === 'acceptable'` iff
 * `70 <= score < 90`, `band === 'slow'` iff `score < 70`. A case can therefore never be
 * described as "good" in one column and score below the Excellent line in another. Introduce an
 * anchor that is not a band edge (or a band edge that is not an anchor) and that guarantee is
 * gone, silently. `metricBandAgreesWithScore` asserts it and the tests exercise it directly.
 */
export const SPEED_ANCHOR_SCORES = {
  zero: 100,
  good: 90,
  acceptable: 70,
  poor: 40,
  floor: 0,
} as const;

/**
 * Weighting for the combined speed score. TTFT carries more because perceived responsiveness is
 * dominated by how long the screen sits empty, not by how long the full answer takes to finish
 * streaming. When only one metric was measured the weights are renormalized to 1.0 — see
 * `combineSpeedScores`, which never imputes the absent metric.
 */
export const SPEED_WEIGHTS: Readonly<Record<SpeedMetric, number>> = {
  ttft: 0.6,
  total: 0.4,
};

/**
 * Rating bands, highest first, each as the inclusive minimum score that earns it. Same contract
 * as `GRADE_BANDS` / `STATUS_BANDS` in `./metrics.ts`, and exported for the same reason (B0-591):
 * the report's stated methodology prints these rows rather than restating them as prose.
 */
export const SPEED_RATING_BANDS: ReadonlyArray<{ rating: SpeedRating; min: number }> = [
  { rating: 'Excellent', min: 90 },
  { rating: 'Good', min: 75 },
  { rating: 'Acceptable', min: 60 },
  { rating: 'Slow', min: 40 },
  { rating: 'Very slow', min: 0 },
];

/**
 * Minimum sample size before a P90 is meaningful. Below this the report prints
 * `P90_UNAVAILABLE_LABEL`, because the 90th percentile of three points is just "the slowest one"
 * wearing a statistic's name, and readers treat it as a tail estimate.
 */
export const P90_MIN_N = 5;

/** What a P90 renders as when `n < P90_MIN_N`. Never `0`, never the max — an absent number. */
export const P90_UNAVAILABLE_LABEL = 'n/a';

/**
 * Ceilings above which a "seconds" value is almost certainly a millisecond value that was never
 * divided. A 1,200 s TTFT is not a slow run, it is a unit bug, and scoring it as 0 buries the
 * bug behind a plausible-looking number. These raise an advisory warning; the value is still
 * scored as given, because this module never rewrites a measurement it was handed.
 */
export const IMPLAUSIBLE_SECONDS: Readonly<Record<SpeedMetric, number>> = {
  ttft: 60,
  total: 600,
};

/** Human label per metric, for warnings and report headings. Single home, like the numbers. */
export const SPEED_METRIC_LABELS: Readonly<Record<SpeedMetric, string>> = {
  ttft: 'TTFT',
  total: 'Total response time',
};

export const SPEED_METRICS: ReadonlyArray<SpeedMetric> = ['ttft', 'total'];

type Anchor = { seconds: number; score: number };

function anchorsFor(thresholds: SpeedThresholds): Anchor[] {
  return [
    { seconds: 0, score: SPEED_ANCHOR_SCORES.zero },
    { seconds: thresholds.good, score: SPEED_ANCHOR_SCORES.good },
    { seconds: thresholds.acceptable, score: SPEED_ANCHOR_SCORES.acceptable },
    { seconds: thresholds.poor, score: SPEED_ANCHOR_SCORES.poor },
    { seconds: thresholds.floor, score: SPEED_ANCHOR_SCORES.floor },
  ];
}

/**
 * Seconds → 0-100, piecewise-linear between the anchors above and clamped at both ends.
 *
 * Returned unrounded on purpose. Rounding here would let a value a hair slower than the `good`
 * edge round back up to exactly 90 and read as Excellent while `metricBand` calls it acceptable —
 * the one disagreement the shared-anchor design exists to prevent. Round at the point of display
 * with `roundSpeedScore`, not in the maths.
 */
export function normalizeSpeed(
  seconds: number,
  metric: SpeedMetric,
  thresholds: SpeedThresholds = SPEED_THRESHOLDS[metric],
): number {
  if (!Number.isFinite(seconds)) return SPEED_ANCHOR_SCORES.floor;

  const anchors = anchorsFor(thresholds);
  const first = anchors[0];
  const last = anchors[anchors.length - 1];

  // A negative measurement is a clock artifact, not a time machine: clamp rather than extrapolate
  // past 100. (Same instinct as the workflow_steps clock-skew clamp.)
  if (seconds <= first.seconds) return first.score;
  if (seconds >= last.seconds) return last.score;

  for (let i = 1; i < anchors.length; i += 1) {
    const lower = anchors[i - 1];
    const upper = anchors[i];
    if (seconds <= upper.seconds) {
      const span = upper.seconds - lower.seconds;
      if (span <= 0) return upper.score;
      const ratio = (seconds - lower.seconds) / span;
      return lower.score + ratio * (upper.score - lower.score);
    }
  }

  return last.score;
}

/**
 * Band for a single measurement. Only the `good` and `acceptable` thresholds are band edges;
 * both are inclusive upper bounds, matching the existing `latencyBlock` counting rule
 * (`<= good` is good, `> acceptable` is slow, the remainder is acceptable).
 */
export function metricBand(
  seconds: number,
  metric: SpeedMetric,
  thresholds: SpeedThresholds = SPEED_THRESHOLDS[metric],
): SpeedBand {
  if (!Number.isFinite(seconds)) return 'slow';
  if (seconds <= thresholds.good) return 'good';
  if (seconds <= thresholds.acceptable) return 'acceptable';
  return 'slow';
}

/** Rating label for a 0-100 score. Words, never letters — see `SpeedRating`. */
export function speedRating(score: number): SpeedRating {
  for (const band of SPEED_RATING_BANDS) {
    if (score >= band.min) return band.rating;
  }
  return 'Very slow';
}

/**
 * The band/score equivalence spelled out as code so a future edit to the anchors or the band
 * edges fails a test instead of quietly producing a self-contradicting report.
 */
export function metricBandAgreesWithScore(band: SpeedBand, score: number): boolean {
  if (band === 'good') return score >= SPEED_ANCHOR_SCORES.good;
  if (band === 'acceptable') {
    return score >= SPEED_ANCHOR_SCORES.acceptable && score < SPEED_ANCHOR_SCORES.good;
  }
  return score < SPEED_ANCHOR_SCORES.acceptable;
}

/** Display rounding, kept out of the maths. One decimal, matching `./metrics.ts`. */
export function roundSpeedScore(score: number): number {
  return Math.round(score * 10) / 10;
}

/**
 * Advisory when a "seconds" value is implausible enough to be a unit mix-up. Names the suspected
 * cause explicitly, including what the value would be if it were milliseconds, so the reader can
 * confirm it in one glance instead of re-deriving it.
 */
export function implausibleSecondsWarning(
  seconds: number,
  metric: SpeedMetric,
): string | null {
  const ceiling = IMPLAUSIBLE_SECONDS[metric];
  if (!Number.isFinite(seconds) || seconds <= ceiling) return null;
  const secondsIfMilliseconds = roundSpeedScore(seconds / 1000);
  return (
    `${SPEED_METRIC_LABELS[metric]} of ${seconds}s exceeds the ${ceiling}s plausibility ceiling — ` +
    `this is most likely a raw millisecond value read as seconds (${seconds} ms = ${secondsIfMilliseconds}s). ` +
    `The value was scored as given; check the source field's unit.`
  );
}

export type SpeedSample = {
  ttftSeconds: number | null;
  totalSeconds: number | null;
};

export type ScoredSpeedMetric = {
  metric: SpeedMetric;
  seconds: number;
  score: number;
  band: SpeedBand;
  /** Renormalized weight actually applied, so the report can print the split it really used. */
  weight: number;
};

export type CombinedSpeed = {
  /** `null` when neither metric was measured — never a zero standing in for "no data". */
  score: number | null;
  rating: SpeedRating | null;
  metrics: ScoredSpeedMetric[];
  warnings: string[];
};

/**
 * Weighted combination of whichever metrics are present.
 *
 * A missing metric is dropped and the remaining weights renormalized to 1.0 — it is never
 * imputed. Zero-filling an unmeasured TTFT would score a run as `Very slow` for a data gap, and
 * substituting an average would invent a measurement that no run produced; either is worse than
 * reporting a one-metric score and saying so, which is what `metrics` lets the caller do.
 */
export function combineSpeedScores(
  sample: SpeedSample,
  thresholds: Readonly<Record<SpeedMetric, SpeedThresholds>> = SPEED_THRESHOLDS,
): CombinedSpeed {
  const seconds: Record<SpeedMetric, number | null> = {
    ttft: sample.ttftSeconds,
    total: sample.totalSeconds,
  };

  const warnings: string[] = [];
  const present: Array<{ metric: SpeedMetric; seconds: number }> = [];

  for (const metric of SPEED_METRICS) {
    const value = seconds[metric];
    if (value == null || !Number.isFinite(value)) continue;
    const warning = implausibleSecondsWarning(value, metric);
    if (warning) warnings.push(warning);
    present.push({ metric, seconds: value });
  }

  if (present.length === 0) {
    return { score: null, rating: null, metrics: [], warnings };
  }

  const weightTotal = present.reduce((sum, m) => sum + SPEED_WEIGHTS[m.metric], 0);
  const metrics: ScoredSpeedMetric[] = present.map((m) => ({
    metric: m.metric,
    seconds: m.seconds,
    score: normalizeSpeed(m.seconds, m.metric, thresholds[m.metric]),
    band: metricBand(m.seconds, m.metric, thresholds[m.metric]),
    weight: SPEED_WEIGHTS[m.metric] / weightTotal,
  }));

  const score = metrics.reduce((sum, m) => sum + m.score * m.weight, 0);
  return { score, rating: speedRating(score), metrics, warnings };
}

/**
 * 90th percentile in seconds, or `null` when there are fewer than `P90_MIN_N` samples.
 *
 * Linear interpolation between the two closest ranks (the common `numpy.percentile` default), so
 * the result is stable as samples are added rather than jumping between observed values.
 */
export function percentile90(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length < P90_MIN_N) return null;
  const position = 0.9 * (finite.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return finite[lower];
  return finite[lower] + (position - lower) * (finite[upper] - finite[lower]);
}

/** Formats a P90 for display, collapsing the under-sampled case to the `n/a` label. */
export function formatP90(values: number[]): string {
  const p90 = percentile90(values);
  return p90 == null ? P90_UNAVAILABLE_LABEL : `${roundSpeedScore(p90)}s`;
}

/**
 * Repairs a candidate threshold set rather than trusting it.
 *
 * `settings` rows are hand-editable strings with only a `value_type` CHECK behind them (see
 * `getRouterType`'s note), so an override can arrive non-numeric, negative, or out of order. A
 * non-monotonic curve is not merely wrong, it is incoherent — anchors would run backwards and
 * `normalizeSpeed` would return scores that rise with latency — so it is repaired to the shipped
 * default and the repair is reported, never silently honoured.
 *
 * Repair order: per-field (non-finite / non-positive → default), then monotonicity. If the set is
 * still not strictly increasing after per-field repair, the whole metric falls back to its
 * default, because there is no way to tell which of the four numbers the operator meant.
 */
export function repairSpeedThresholds(
  candidate: Partial<Record<keyof SpeedThresholds, number>>,
  metric: SpeedMetric,
): { thresholds: SpeedThresholds; warnings: string[] } {
  const defaults = SPEED_THRESHOLDS[metric];
  const warnings: string[] = [];
  const keys: Array<keyof SpeedThresholds> = ['good', 'acceptable', 'poor', 'floor'];

  const repaired = { ...defaults };
  for (const key of keys) {
    const value = candidate[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) {
      warnings.push(
        `${SPEED_METRIC_LABELS[metric]} "${key}" threshold override ${String(value)} is not a positive number — using the default ${defaults[key]}s.`,
      );
      continue;
    }
    repaired[key] = value;
  }

  const monotonic =
    repaired.good < repaired.acceptable &&
    repaired.acceptable < repaired.poor &&
    repaired.poor < repaired.floor;

  if (!monotonic) {
    warnings.push(
      `${SPEED_METRIC_LABELS[metric]} threshold overrides are not strictly increasing ` +
        `(good ${repaired.good}s, acceptable ${repaired.acceptable}s, poor ${repaired.poor}s, floor ${repaired.floor}s) — ` +
        `falling back to the defaults ${defaults.good}/${defaults.acceptable}/${defaults.poor}/${defaults.floor}s.`,
    );
    return { thresholds: { ...defaults }, warnings };
  }

  return { thresholds: repaired, warnings };
}

/** `settings` keys backing the optional overrides. No env vars — see B0-638. */
export const SPEED_THRESHOLD_SETTING_KEYS: Readonly<
  Record<SpeedMetric, Record<keyof SpeedThresholds, string>>
> = {
  ttft: {
    good: 'REPORT_SPEED_TTFT_GOOD_SECONDS',
    acceptable: 'REPORT_SPEED_TTFT_ACCEPTABLE_SECONDS',
    poor: 'REPORT_SPEED_TTFT_POOR_SECONDS',
    floor: 'REPORT_SPEED_TTFT_FLOOR_SECONDS',
  },
  total: {
    good: 'REPORT_SPEED_TOTAL_GOOD_SECONDS',
    acceptable: 'REPORT_SPEED_TOTAL_ACCEPTABLE_SECONDS',
    poor: 'REPORT_SPEED_TOTAL_POOR_SECONDS',
    floor: 'REPORT_SPEED_TOTAL_FLOOR_SECONDS',
  },
};

export type ResolvedSpeedThresholds = {
  thresholds: Readonly<Record<SpeedMetric, SpeedThresholds>>;
  warnings: string[];
};

/**
 * The only async function in this module, and the only place config is read. Callers resolve
 * thresholds once per report and thread them through the pure functions above, so scoring stays
 * synchronous and testable without a database.
 *
 * A missing row yields the shipped default (that is `getNumberSetting`'s fallback contract), so
 * with no rows configured this returns `SPEED_THRESHOLDS` unchanged and no warnings.
 */
export async function loadSpeedThresholds(): Promise<ResolvedSpeedThresholds> {
  // Imported here rather than at the top of the file: `settings-service` reaches the Supabase
  // service-role client, and this module's constants are read by client components (the report
  // cards and ledger). A static import would drag server-only code into their bundle for the sake
  // of a function they never call.
  const { getNumberSetting } = await import('~/lib/settings/settings-service');

  const warnings: string[] = [];
  const resolved: Record<SpeedMetric, SpeedThresholds> = {
    ttft: { ...SPEED_THRESHOLDS.ttft },
    total: { ...SPEED_THRESHOLDS.total },
  };

  for (const metric of SPEED_METRICS) {
    const keys = SPEED_THRESHOLD_SETTING_KEYS[metric];
    const defaults = SPEED_THRESHOLDS[metric];
    const [good, acceptable, poor, floor] = await Promise.all([
      getNumberSetting(keys.good, defaults.good),
      getNumberSetting(keys.acceptable, defaults.acceptable),
      getNumberSetting(keys.poor, defaults.poor),
      getNumberSetting(keys.floor, defaults.floor),
    ]);

    const repair = repairSpeedThresholds({ good, acceptable, poor, floor }, metric);
    resolved[metric] = repair.thresholds;
    warnings.push(...repair.warnings);
  }

  if (warnings.length > 0) {
    console.warn('[speed-rules]', warnings.join('; '));
  }

  return { thresholds: resolved, warnings };
}
