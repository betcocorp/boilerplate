/**
 * Aggregation — roll per-episode {@link ScoreResult}s up to a question set.
 *
 * The whole point of this module is that **a mean is not reportable without its denominator**. A
 * mean nDCG of 0.71 over 6 of 20 episodes and a mean nDCG of 0.71 over 20 of 20 are different
 * claims, and after a corpus migration the first is the likely one: stale chunk joins push episodes
 * under the coverage floor, unlabelled items drop out, backfilled runs have no `retrieval_calls` at
 * all. So every {@link MetricAggregate} carries `nScored`, `nUnscorable`, `scoredShare` and a full
 * per-reason breakdown alongside the mean — the breakdown is a required field with every reason key
 * present (zeroed when unused), so a reader cannot fail to see a bucket simply because it was
 * omitted from an object.
 *
 * Uncertainty is reported as a percentile bootstrap 95% CI rather than a normal-theory interval:
 * these metrics are bounded, discrete and skewed (hit@1 is Bernoulli; nDCG piles up at 0 and 1), so
 * mean ± 1.96·SE would routinely produce limits outside [0, 1]. The RNG is an injected parameter
 * with a seeded default, so a snapshot re-aggregated tomorrow reproduces byte-identical intervals.
 *
 * Pure: no DB, no clock, no unseeded randomness.
 */

import type { EpisodeRankScores } from './rank-metrics';
import { rankMetricKeys } from './rank-metrics';
import type { ScoreResult, UnscorableReason } from './types';

/** A deterministic uniform source in [0, 1). Injected so every interval is reproducible. */
export type Rng = () => number;

export const UNSCORABLE_REASONS: readonly UnscorableReason[] = [
  'no_retrieval_calls',
  'empty_retrieval',
  'no_judgement',
  'coverage_below_floor',
  'no_resolved_text',
  'reranker_absent',
];

/**
 * mulberry32 — a 32-bit PRNG chosen because it is four lines, has no dependency, and passes the
 * statistical bar a bootstrap resampler needs. Cryptographic quality is irrelevant here;
 * reproducibility is the whole requirement.
 */
export const createSeededRng = (seed: number): Rng => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Fixed default seed, so an aggregate is a pure function of its inputs unless a caller says otherwise. */
export const DEFAULT_BOOTSTRAP_SEED = 20260903;
export const DEFAULT_BOOTSTRAP_RESAMPLES = 2000;

export type ConfidenceInterval = {
  lower: number;
  upper: number;
  /** Always 0.95 here; carried explicitly so a snapshot is self-describing. */
  level: number;
  resamples: number;
  method: 'percentile_bootstrap';
  /** True when n === 1 and the "interval" is just the point value. */
  degenerate: boolean;
};

export type MetricAggregate = {
  metric: string;
  /** Episodes considered, scored or not. */
  n: number;
  nScored: number;
  nUnscorable: number;
  /** `nScored / n`. Null when `n === 0`. Read this before reading the mean. */
  scoredShare: number | null;
  unscorableByReason: Record<UnscorableReason, number>;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  /** Null when nothing was scored. */
  ci: ConfidenceInterval | null;
};

export type SetAggregate = {
  label: string | null;
  episodeCount: number;
  /** Episodes where every metric was unscorable for the same reason. */
  unscorableEpisodeCount: number;
  /** Distinct `itemId`s seen, for pairing sanity in {@link compare}. */
  itemCount: number;
  metrics: Record<string, MetricAggregate>;
  /** Report order for `metrics`; object key order is not a contract. */
  metricOrder: string[];
  bootstrap: { seed: number; resamples: number };
};

export type AggregateOptions = {
  label?: string | null;
  rng?: Rng;
  seed?: number;
  resamples?: number;
  /** Metric keys to report. Defaults to the union of keys present across the episodes. */
  metricKeys?: readonly string[];
};

const emptyReasonCounts = (): Record<UnscorableReason, number> => ({
  no_retrieval_calls: 0,
  empty_retrieval: 0,
  no_judgement: 0,
  coverage_below_floor: 0,
  no_resolved_text: 0,
  reranker_absent: 0,
});

/** Median of an unsorted array; even lengths take the midpoint of the two central values. */
export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

/** Type-safe percentile on a pre-sorted array, using the nearest-rank convention. */
const percentile = (sorted: readonly number[], p: number): number => {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
};

/**
 * Percentile bootstrap CI on the mean.
 *
 * With `n === 1` every resample is the same value, so the interval collapses to the point. Rather
 * than pretend that is an interval, it is returned with `degenerate: true` — a single-episode
 * "CI" that looks tight is the most misleading thing this module could emit.
 */
export const bootstrapMeanCi = (
  values: readonly number[],
  options: { rng?: Rng; seed?: number; resamples?: number; level?: number } = {},
): ConfidenceInterval | null => {
  if (values.length === 0) return null;
  const resamples = options.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const level = options.level ?? 0.95;
  const point = mean(values)!;

  if (values.length === 1) {
    return { lower: point, upper: point, level, resamples, method: 'percentile_bootstrap', degenerate: true };
  }

  const rng = options.rng ?? createSeededRng(options.seed ?? DEFAULT_BOOTSTRAP_SEED);
  const means: number[] = [];
  for (let i = 0; i < resamples; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) {
      sum += values[Math.floor(rng() * values.length)]!;
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return {
    lower: percentile(means, tail),
    upper: percentile(means, 1 - tail),
    level,
    resamples,
    method: 'percentile_bootstrap',
    degenerate: false,
  };
};

/** Aggregate one metric's per-episode results. */
export const aggregateMetric = (
  metric: string,
  results: readonly ScoreResult<number>[],
  options: { rng?: Rng; seed?: number; resamples?: number } = {},
): MetricAggregate => {
  const values: number[] = [];
  const unscorableByReason = emptyReasonCounts();
  for (const result of results) {
    if (result.scored) values.push(result.value);
    else unscorableByReason[result.reason] += 1;
  }

  return {
    metric,
    n: results.length,
    nScored: values.length,
    nUnscorable: results.length - values.length,
    scoredShare: results.length === 0 ? null : values.length / results.length,
    unscorableByReason,
    mean: mean(values),
    median: median(values),
    min: values.length === 0 ? null : Math.min(...values),
    max: values.length === 0 ? null : Math.max(...values),
    ci: bootstrapMeanCi(values, options),
  };
};

/**
 * Roll a set of scored episodes up to one report.
 *
 * An episode missing a metric key another episode has is *not* silently skipped: the key is
 * reported with that episode absent from `n`, and the mismatch shows up as differing `n` across
 * metrics. That only happens when episodes were scored with different `ks`, which is itself a bug
 * worth seeing.
 */
export const aggregateEpisodes = (
  episodes: readonly EpisodeRankScores[],
  options: AggregateOptions = {},
): SetAggregate => {
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const resamples = options.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;

  const keys =
    options.metricKeys !== undefined
      ? [...options.metricKeys]
      : defaultMetricOrder(episodes);

  const metrics: Record<string, MetricAggregate> = {};
  for (const key of keys) {
    const results = episodes
      .map((episode) => episode.metrics[key])
      .filter((result): result is ScoreResult<number> => result !== undefined);
    // With a seed (the default path) each metric gets its own fresh stream, so adding or removing a
    // metric cannot shift another metric's interval. An explicitly injected `rng` is shared across
    // metrics by design — the caller owns that stream and its ordering.
    metrics[key] = aggregateMetric(key, results, {
      rng: options.rng,
      seed,
      resamples,
    });
  }

  return {
    label: options.label ?? null,
    episodeCount: episodes.length,
    unscorableEpisodeCount: episodes.filter((episode) => episode.unscorable !== null).length,
    itemCount: new Set(episodes.map((episode) => episode.itemId)).size,
    metrics,
    metricOrder: keys,
    bootstrap: { seed, resamples },
  };
};

/**
 * Report order: the canonical order implied by the first episode's `ks` when available, then any
 * extra keys observed, so a snapshot's column order is stable rather than object-insertion order.
 */
const defaultMetricOrder = (episodes: readonly EpisodeRankScores[]): string[] => {
  const canonical = episodes.length === 0 ? [] : rankMetricKeys(episodes[0]!.options.ks);
  const order: string[] = [];
  const seen = new Set<string>();
  for (const key of canonical) {
    order.push(key);
    seen.add(key);
  }
  for (const episode of episodes) {
    for (const key of Object.keys(episode.metrics)) {
      if (seen.has(key)) continue;
      seen.add(key);
      order.push(key);
    }
  }
  return order;
};
