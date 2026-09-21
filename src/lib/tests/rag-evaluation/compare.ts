/**
 * A/B comparison of two scored question sets — the pre- vs post-docling comparison this phase
 * exists to serve.
 *
 * Two rules shape everything here.
 *
 * **Pair by `itemId`, never by position.** The two runs are separate executions of the same set;
 * row order, retries and skipped items make index i on one side a different question on the other.
 * A positional comparison would compute deltas between unrelated questions and still produce a
 * confident-looking p-value.
 *
 * **Asymmetry is the finding, not the noise.** After a corpus migration the interesting facts are
 * usually "these 9 items only scored on one side" and "the new side's unscorable rate tripled" —
 * exactly the facts that a silent inner join deletes. So unpaired items are returned as an explicit
 * list, per-metric drop-outs are counted, and a {@link CoverageWarning} fires when the two sides'
 * unscorable rates diverge materially.
 *
 * Statistics: a percentile bootstrap CI on the mean *paired* delta (resampling pairs, which keeps
 * the pairing intact) and an exact two-sided sign test on the direction of the deltas. The sign
 * test is deliberately weak — it assumes almost nothing and only asks whether improvements
 * outnumber regressions. On question sets of 20–60 items, with metrics that are Bernoulli or
 * heavily tied, that is about as much as the data honestly supports.
 *
 * Pure: no DB, no clock, no unseeded randomness.
 */

import {
  DEFAULT_BOOTSTRAP_RESAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  aggregateEpisodes,
  bootstrapMeanCi,
  mean,
  median,
  type ConfidenceInterval,
  type Rng,
  type SetAggregate,
} from './aggregate';
import type { EpisodeRankScores } from './rank-metrics';
import type { UnscorableReason } from './types';

export type ComparisonSide = 'baseline' | 'candidate';

export type UnpairedItem = {
  itemId: string;
  /** The side the item was present on; it is missing from the other. */
  presentIn: ComparisonSide;
  episodeId: string;
};

export type SignTestResult = {
  /** Pairs with a non-zero delta. Ties carry no directional information and are excluded. */
  n: number;
  positive: number;
  negative: number;
  ties: number;
  /** Exact two-sided binomial p-value at p = 0.5. 1 when `n === 0`. */
  pValue: number;
};

export type MetricComparison = {
  metric: string;
  /** Items present on both sides AND scored on both sides — the only ones a delta exists for. */
  nPaired: number;
  /** Items present on both sides but scored on only one, by the side that lost them. */
  nDroppedBaselineUnscorable: number;
  nDroppedCandidateUnscorable: number;
  /** Items present on both sides and unscorable on both. */
  nDroppedBothUnscorable: number;
  baselineMean: number | null;
  candidateMean: number | null;
  /** Mean of `candidate - baseline` over paired items. Positive = candidate is better. */
  meanDelta: number | null;
  medianDelta: number | null;
  deltaCi: ConfidenceInterval | null;
  signTest: SignTestResult;
  improved: number;
  regressed: number;
  unchanged: number;
};

export type CoverageWarning = {
  metric: string;
  baselineUnscorableRate: number;
  candidateUnscorableRate: number;
  /** Absolute difference in unscorable rate, in proportion points. */
  difference: number;
  /** Reason buckets that differ by at least one episode, for pointing at the cause. */
  reasonDeltas: Partial<Record<UnscorableReason, number>>;
  message: string;
};

export type ComparisonResult = {
  baselineLabel: string | null;
  candidateLabel: string | null;
  baseline: SetAggregate;
  candidate: SetAggregate;
  /** Items present on both sides, regardless of whether either side scored. */
  pairedItemCount: number;
  unpaired: UnpairedItem[];
  /** Item ids that appeared more than once on a side; only the first episode was used. */
  duplicateItemIds: string[];
  metrics: Record<string, MetricComparison>;
  metricOrder: string[];
  coverageWarnings: CoverageWarning[];
  bootstrap: { seed: number; resamples: number };
};

export type CompareOptions = {
  baselineLabel?: string | null;
  candidateLabel?: string | null;
  rng?: Rng;
  seed?: number;
  resamples?: number;
  metricKeys?: readonly string[];
  /** See {@link COVERAGE_WARNING_THRESHOLD}. */
  coverageWarningThreshold?: number;
};

/**
 * Unscorable-rate divergence that triggers a {@link CoverageWarning}: **10 proportion points**.
 *
 * The threshold is a judgement call, set from what the failure looks like rather than from theory.
 * A migration that leaves chunk joins stale pushes episodes under `coverageFloor` on one side only;
 * on a 20–60 item set, 10 points is 2–6 episodes — small enough to catch the drift early, large
 * enough that one flaky item on a 20-item set (5 points) does not cry wolf. When it fires, the two
 * means are computed over materially different subsets of questions and the delta is not a
 * like-for-like comparison: fix the join, re-export, re-compare. It is a warning and not an error
 * because the asymmetry is sometimes the true result (a run that genuinely stopped retrieving).
 */
export const COVERAGE_WARNING_THRESHOLD = 0.1;

/** log of n choose k, via lgamma-free factorial logs — keeps exact-binomial tails stable for large n. */
const logChoose = (n: number, k: number): number => {
  let result = 0;
  for (let i = 1; i <= k; i += 1) result += Math.log(n - k + i) - Math.log(i);
  return result;
};

/**
 * Exact two-sided sign test: `min(1, 2 * P(X >= max(pos, neg)))` for `X ~ Binomial(n, 0.5)`,
 * n being the non-tied pairs.
 *
 * Ties are dropped rather than split, the standard treatment. That matters a lot here because
 * hit@1 and low-k metrics are mostly ties, so a set of 40 items can yield an n of 6 — which the
 * `n` field reports so the p-value is never read without it.
 */
export const signTest = (deltas: readonly number[]): SignTestResult => {
  const positive = deltas.filter((delta) => delta > 0).length;
  const negative = deltas.filter((delta) => delta < 0).length;
  const ties = deltas.length - positive - negative;
  const n = positive + negative;
  if (n === 0) return { n, positive, negative, ties, pValue: 1 };

  const extreme = Math.max(positive, negative);
  let tail = 0;
  for (let i = extreme; i <= n; i += 1) tail += Math.exp(logChoose(n, i) + n * Math.log(0.5));
  return { n, positive, negative, ties, pValue: Math.min(1, 2 * tail) };
};

type Indexed = { byItem: Map<string, EpisodeRankScores>; duplicates: string[] };

const indexByItem = (episodes: readonly EpisodeRankScores[]): Indexed => {
  const byItem = new Map<string, EpisodeRankScores>();
  const duplicates: string[] = [];
  for (const episode of episodes) {
    if (byItem.has(episode.itemId)) {
      if (!duplicates.includes(episode.itemId)) duplicates.push(episode.itemId);
      continue; // First episode wins; the duplicate is reported, not silently merged.
    }
    byItem.set(episode.itemId, episode);
  }
  return { byItem, duplicates };
};

const unscorableRate = (
  episodes: readonly EpisodeRankScores[],
  metric: string,
): { rate: number; reasons: Partial<Record<UnscorableReason, number>>; n: number } => {
  const reasons: Partial<Record<UnscorableReason, number>> = {};
  let unscorableCount = 0;
  let n = 0;
  for (const episode of episodes) {
    const result = episode.metrics[metric];
    if (result === undefined) continue;
    n += 1;
    if (result.scored) continue;
    unscorableCount += 1;
    reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
  }
  return { rate: n === 0 ? 0 : unscorableCount / n, reasons, n };
};

/**
 * Compare two scored sets.
 *
 * Deltas are `candidate - baseline`, so a positive `meanDelta` always means the candidate improved,
 * for every metric here (all are oriented so higher is better).
 */
export const compareEpisodeSets = (
  baselineEpisodes: readonly EpisodeRankScores[],
  candidateEpisodes: readonly EpisodeRankScores[],
  options: CompareOptions = {},
): ComparisonResult => {
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const resamples = options.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const threshold = options.coverageWarningThreshold ?? COVERAGE_WARNING_THRESHOLD;

  const baselineIndex = indexByItem(baselineEpisodes);
  const candidateIndex = indexByItem(candidateEpisodes);

  const unpaired: UnpairedItem[] = [];
  const pairs: Array<{ itemId: string; baseline: EpisodeRankScores; candidate: EpisodeRankScores }> = [];
  for (const [itemId, baseline] of baselineIndex.byItem) {
    const candidate = candidateIndex.byItem.get(itemId);
    if (candidate === undefined) {
      unpaired.push({ itemId, presentIn: 'baseline', episodeId: baseline.episodeId });
      continue;
    }
    pairs.push({ itemId, baseline, candidate });
  }
  for (const [itemId, candidate] of candidateIndex.byItem) {
    if (baselineIndex.byItem.has(itemId)) continue;
    unpaired.push({ itemId, presentIn: 'candidate', episodeId: candidate.episodeId });
  }

  const baselineAggregate = aggregateEpisodes(baselineEpisodes, {
    label: options.baselineLabel ?? null,
    rng: options.rng,
    seed,
    resamples,
    metricKeys: options.metricKeys,
  });
  const candidateAggregate = aggregateEpisodes(candidateEpisodes, {
    label: options.candidateLabel ?? null,
    rng: options.rng,
    seed,
    resamples,
    metricKeys: options.metricKeys,
  });

  const metricOrder =
    options.metricKeys !== undefined
      ? [...options.metricKeys]
      : [
          ...baselineAggregate.metricOrder,
          ...candidateAggregate.metricOrder.filter((key) => !baselineAggregate.metricOrder.includes(key)),
        ];

  const metrics: Record<string, MetricComparison> = {};
  const coverageWarnings: CoverageWarning[] = [];

  for (const metric of metricOrder) {
    const deltas: number[] = [];
    const baselineValues: number[] = [];
    const candidateValues: number[] = [];
    let nDroppedBaselineUnscorable = 0;
    let nDroppedCandidateUnscorable = 0;
    let nDroppedBothUnscorable = 0;

    for (const pair of pairs) {
      const left = pair.baseline.metrics[metric];
      const right = pair.candidate.metrics[metric];
      const leftValue = left !== undefined && left.scored ? left.value : null;
      const rightValue = right !== undefined && right.scored ? right.value : null;
      if (leftValue !== null && rightValue !== null) {
        baselineValues.push(leftValue);
        candidateValues.push(rightValue);
        deltas.push(rightValue - leftValue);
        continue;
      }
      if (leftValue === null && rightValue === null) nDroppedBothUnscorable += 1;
      else if (leftValue === null) nDroppedBaselineUnscorable += 1;
      else nDroppedCandidateUnscorable += 1;
    }

    metrics[metric] = {
      metric,
      nPaired: deltas.length,
      nDroppedBaselineUnscorable,
      nDroppedCandidateUnscorable,
      nDroppedBothUnscorable,
      baselineMean: mean(baselineValues),
      candidateMean: mean(candidateValues),
      meanDelta: mean(deltas),
      medianDelta: median(deltas),
      // Resampling the delta vector is a paired bootstrap: each draw keeps a question's two scores
      // together, so between-question variance never leaks into the interval on the difference.
      deltaCi: bootstrapMeanCi(deltas, { rng: options.rng, seed, resamples }),
      signTest: signTest(deltas),
      improved: deltas.filter((delta) => delta > 0).length,
      regressed: deltas.filter((delta) => delta < 0).length,
      unchanged: deltas.filter((delta) => delta === 0).length,
    };

    const left = unscorableRate(baselineEpisodes, metric);
    const right = unscorableRate(candidateEpisodes, metric);
    const difference = Math.abs(left.rate - right.rate);
    if (difference >= threshold) {
      const reasonDeltas: Partial<Record<UnscorableReason, number>> = {};
      const reasonKeys = new Set<UnscorableReason>([
        ...(Object.keys(left.reasons) as UnscorableReason[]),
        ...(Object.keys(right.reasons) as UnscorableReason[]),
      ]);
      for (const reason of reasonKeys) {
        const delta = (right.reasons[reason] ?? 0) - (left.reasons[reason] ?? 0);
        if (delta !== 0) reasonDeltas[reason] = delta;
      }
      coverageWarnings.push({
        metric,
        baselineUnscorableRate: left.rate,
        candidateUnscorableRate: right.rate,
        difference,
        reasonDeltas,
        message:
          `${metric}: unscorable rate differs by ${(difference * 100).toFixed(1)} points ` +
          `(baseline ${(left.rate * 100).toFixed(1)}%, candidate ${(right.rate * 100).toFixed(1)}%). ` +
          'The two means are over materially different subsets; treat the delta as unreliable.',
      });
    }
  }

  const duplicateItemIds = [
    ...new Set([...baselineIndex.duplicates, ...candidateIndex.duplicates]),
  ];

  return {
    baselineLabel: options.baselineLabel ?? null,
    candidateLabel: options.candidateLabel ?? null,
    baseline: baselineAggregate,
    candidate: candidateAggregate,
    pairedItemCount: pairs.length,
    unpaired,
    duplicateItemIds,
    metrics,
    metricOrder,
    coverageWarnings,
    bootstrap: { seed, resamples },
  };
};
