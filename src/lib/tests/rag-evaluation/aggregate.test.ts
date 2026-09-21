import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOOTSTRAP_SEED,
  aggregateEpisodes,
  aggregateMetric,
  bootstrapMeanCi,
  createSeededRng,
  mean,
  median,
  UNSCORABLE_REASONS,
} from './aggregate';
import type { EpisodeRankScores } from './rank-metrics';
import {
  DEFAULT_SCORING_OPTIONS,
  scored,
  unscorable,
  type ScoreResult,
  type ScoringOptions,
  type UnscorableReason,
} from './types';

const opts: ScoringOptions = { ...DEFAULT_SCORING_OPTIONS, ks: [1, 3] };

const episodeScores = (
  itemId: string,
  metrics: Record<string, ScoreResult<number>>,
  overrides: Partial<EpisodeRankScores> = {},
): EpisodeRankScores => ({
  episodeId: `ep-${itemId}`,
  itemId,
  runId: 'run-1',
  options: opts,
  fused: null,
  unscorable: null,
  metrics,
  rankOfFirstRelevant: scored(1),
  ...overrides,
});

describe('createSeededRng', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = createSeededRng(7);
    const b = createSeededRng(7);
    const c = createSeededRng(8);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
  });

  it('stays inside [0, 1)', () => {
    const rng = createSeededRng(1);
    for (let i = 0; i < 500; i += 1) {
      const draw = rng();
      expect(draw).toBeGreaterThanOrEqual(0);
      expect(draw).toBeLessThan(1);
    }
  });
});

describe('mean and median', () => {
  it('returns null for an empty set rather than NaN', () => {
    expect(mean([])).toBeNull();
    expect(median([])).toBeNull();
  });

  it('takes the midpoint for an even count and does not mutate the input', () => {
    const values = [3, 1, 4, 2];
    expect(median(values)).toBe(2.5);
    expect(values).toEqual([3, 1, 4, 2]);
  });

  it('takes the central value for an odd count', () => {
    expect(median([5, 1, 3])).toBe(3);
  });
});

describe('bootstrapMeanCi', () => {
  it('is null with no values', () => {
    expect(bootstrapMeanCi([])).toBeNull();
  });

  it('collapses to the point value and flags itself degenerate for n = 1', () => {
    const ci = bootstrapMeanCi([0.4]);
    expect(ci).toMatchObject({ lower: 0.4, upper: 0.4, degenerate: true });
  });

  it('is reproducible for a seed and brackets the mean', () => {
    const values = [0, 0, 1, 1, 0.5, 0.75, 0.25, 1];
    const a = bootstrapMeanCi(values, { seed: 42, resamples: 500 });
    const b = bootstrapMeanCi(values, { seed: 42, resamples: 500 });
    expect(a).toEqual(b);
    expect(a!.lower).toBeLessThanOrEqual(mean(values)!);
    expect(a!.upper).toBeGreaterThanOrEqual(mean(values)!);
    expect(a!.degenerate).toBe(false);
  });

  it('collapses when every value is identical', () => {
    const ci = bootstrapMeanCi([1, 1, 1, 1], { seed: 3, resamples: 200 });
    expect(ci!.lower).toBe(1);
    expect(ci!.upper).toBe(1);
  });

  it('accepts an injected rng instead of a seed', () => {
    const ci = bootstrapMeanCi([0, 1], { rng: createSeededRng(9), resamples: 100 });
    expect(ci!.resamples).toBe(100);
    expect(ci!.method).toBe('percentile_bootstrap');
  });
});

describe('aggregateMetric', () => {
  it('reports zero counts for every reason even when nothing is unscorable', () => {
    const result = aggregateMetric('hit@1', [scored(1), scored(0)]);
    for (const reason of UNSCORABLE_REASONS) {
      expect(result.unscorableByReason[reason]).toBe(0);
    }
    expect(result.nScored).toBe(2);
    expect(result.mean).toBe(0.5);
    expect(result.scoredShare).toBe(1);
  });

  it('excludes unscorables from the mean and breaks them down by reason', () => {
    const result = aggregateMetric('recall@3', [
      scored(1),
      scored(0),
      unscorable('no_judgement'),
      unscorable('no_judgement'),
      unscorable('coverage_below_floor'),
    ]);
    expect(result.n).toBe(5);
    expect(result.nScored).toBe(2);
    expect(result.nUnscorable).toBe(3);
    expect(result.scoredShare).toBe(0.4);
    expect(result.mean).toBe(0.5);
    expect(result.unscorableByReason.no_judgement).toBe(2);
    expect(result.unscorableByReason.coverage_below_floor).toBe(1);
    expect(result.unscorableByReason.empty_retrieval).toBe(0);
  });

  it('reports nulls, not zeros, when nothing scored', () => {
    const reasons: UnscorableReason[] = ['no_retrieval_calls', 'empty_retrieval'];
    const result = aggregateMetric('ndcg@3', reasons.map((reason) => unscorable(reason)));
    expect(result.mean).toBeNull();
    expect(result.median).toBeNull();
    expect(result.min).toBeNull();
    expect(result.max).toBeNull();
    expect(result.ci).toBeNull();
    expect(result.scoredShare).toBe(0);
  });

  it('reports scoredShare null for an empty set', () => {
    expect(aggregateMetric('hit@1', []).scoredShare).toBeNull();
  });

  it('reports min and max alongside the mean', () => {
    const result = aggregateMetric('ndcg@1', [scored(0.2), scored(0.9), scored(0.5)]);
    expect(result.min).toBe(0.2);
    expect(result.max).toBe(0.9);
    expect(result.median).toBe(0.5);
  });
});

describe('aggregateEpisodes', () => {
  const episodes: EpisodeRankScores[] = [
    episodeScores('i1', {
      reciprocal_rank: scored(1),
      average_precision: scored(1),
      'hit@1': scored(1),
      'recall@1': scored(1),
      'precision@1': scored(1),
      'ndcg@1': scored(1),
      'hit@3': scored(1),
      'recall@3': scored(1),
      'precision@3': scored(0.5),
      'ndcg@3': scored(1),
    }),
    episodeScores(
      'i2',
      Object.fromEntries(
        [
          'reciprocal_rank',
          'average_precision',
          'hit@1',
          'recall@1',
          'precision@1',
          'ndcg@1',
          'hit@3',
          'recall@3',
          'precision@3',
          'ndcg@3',
        ].map((key) => [key, unscorable('coverage_below_floor')]),
      ),
      { unscorable: unscorable('coverage_below_floor'), rankOfFirstRelevant: unscorable('coverage_below_floor') },
    ),
    episodeScores('i3', {
      reciprocal_rank: scored(0),
      average_precision: scored(0),
      'hit@1': scored(0),
      'recall@1': scored(0),
      'precision@1': scored(0),
      'ndcg@1': scored(0),
      'hit@3': scored(0),
      'recall@3': scored(0),
      'precision@3': scored(0),
      'ndcg@3': scored(0),
    }),
  ];

  it('makes the denominator impossible to miss', () => {
    const aggregate = aggregateEpisodes(episodes, { label: 'pre-docling' });
    const hit = aggregate.metrics['hit@1']!;
    expect(aggregate.episodeCount).toBe(3);
    expect(aggregate.unscorableEpisodeCount).toBe(1);
    expect(hit.n).toBe(3);
    expect(hit.nScored).toBe(2);
    expect(hit.mean).toBe(0.5);
    expect(hit.unscorableByReason.coverage_below_floor).toBe(1);
    expect(aggregate.label).toBe('pre-docling');
    expect(aggregate.itemCount).toBe(3);
  });

  it('uses the canonical metric order from the episodes ks', () => {
    const aggregate = aggregateEpisodes(episodes);
    expect(aggregate.metricOrder.slice(0, 4)).toEqual([
      'reciprocal_rank',
      'average_precision',
      'hit@1',
      'hit@3',
    ]);
  });

  it('handles a single-episode set with a degenerate CI', () => {
    const aggregate = aggregateEpisodes([episodes[0]!]);
    const hit = aggregate.metrics['hit@1']!;
    expect(hit.n).toBe(1);
    expect(hit.mean).toBe(1);
    expect(hit.ci).toMatchObject({ lower: 1, upper: 1, degenerate: true });
  });

  it('handles an empty set without throwing', () => {
    const aggregate = aggregateEpisodes([]);
    expect(aggregate.episodeCount).toBe(0);
    expect(aggregate.metricOrder).toEqual([]);
    expect(aggregate.metrics).toEqual({});
  });

  it('is reproducible across runs with the default seed', () => {
    expect(aggregateEpisodes(episodes)).toEqual(aggregateEpisodes(episodes));
    expect(aggregateEpisodes(episodes).bootstrap.seed).toBe(DEFAULT_BOOTSTRAP_SEED);
  });

  it('honours an explicit metricKeys list, including a key no episode has', () => {
    const aggregate = aggregateEpisodes(episodes, { metricKeys: ['hit@1', 'ndcg@99'] });
    expect(aggregate.metricOrder).toEqual(['hit@1', 'ndcg@99']);
    expect(aggregate.metrics['ndcg@99']!.n).toBe(0);
    expect(aggregate.metrics['ndcg@99']!.mean).toBeNull();
  });

  it('surfaces a metric only some episodes carry, rather than dropping it', () => {
    const extra = episodeScores('i4', { 'hit@1': scored(1), custom_metric: scored(0.25) });
    const aggregate = aggregateEpisodes([...episodes, extra]);
    expect(aggregate.metricOrder).toContain('custom_metric');
    expect(aggregate.metrics['custom_metric']!.n).toBe(1);
    expect(aggregate.metrics['hit@1']!.n).toBe(4);
  });
});
