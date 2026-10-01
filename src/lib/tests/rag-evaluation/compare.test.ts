import { describe, expect, it } from 'vitest';

import { COVERAGE_WARNING_THRESHOLD, compareEpisodeSets, signTest } from './compare';
import type { EpisodeRankScores } from './rank-metrics';
import {
  DEFAULT_SCORING_OPTIONS,
  scored,
  unscorable,
  type ScoreResult,
  type ScoringOptions,
  type UnscorableReason,
} from './types';

const opts: ScoringOptions = { ...DEFAULT_SCORING_OPTIONS, ks: [1] };

/** One episode carrying a single metric, which is all a comparison test needs. */
const ep = (itemId: string, hit: ScoreResult<number>, run = 'run-a'): EpisodeRankScores => ({
  episodeId: `${run}:${itemId}`,
  itemId,
  runId: run,
  options: opts,
  fused: null,
  unscorable: hit.scored ? null : hit,
  metrics: { 'hit@1': hit },
  rankOfFirstRelevant: hit.scored ? scored(1) : hit,
});

const keys = { metricKeys: ['hit@1'] as const };

describe('signTest', () => {
  it('is p = 1 with no non-tied pairs', () => {
    expect(signTest([0, 0, 0])).toEqual({ n: 0, positive: 0, negative: 0, ties: 3, pValue: 1 });
  });

  it('gives the exact two-sided binomial tail for a unanimous direction', () => {
    // 2 * P(X >= 5 | n = 5, p = 0.5) = 2 * 1/32.
    expect(signTest([1, 1, 1, 1, 1]).pValue).toBeCloseTo(0.0625);
  });

  it('drops ties from n but reports them', () => {
    const result = signTest([1, 1, 1, -1, 0, 0]);
    expect(result).toMatchObject({ n: 4, positive: 3, negative: 1, ties: 2 });
    // 2 * (C(4,3) + C(4,4)) / 16.
    expect(result.pValue).toBeCloseTo(0.625);
  });

  it('is symmetric in direction', () => {
    expect(signTest([1, 1, -1]).pValue).toBeCloseTo(signTest([-1, -1, 1]).pValue);
  });

  it('never exceeds 1 for an even split', () => {
    expect(signTest([1, -1]).pValue).toBe(1);
  });
});

describe('compareEpisodeSets', () => {
  it('pairs by itemId, not by position', () => {
    const baseline = [ep('a', scored(0)), ep('b', scored(1))];
    // Same items, opposite order, with `a` improved.
    const candidate = [ep('b', scored(1), 'run-b'), ep('a', scored(1), 'run-b')];
    const result = compareEpisodeSets(baseline, candidate, keys);
    const hit = result.metrics['hit@1']!;
    expect(result.pairedItemCount).toBe(2);
    expect(hit.nPaired).toBe(2);
    expect(hit.meanDelta).toBe(0.5);
    expect(hit.improved).toBe(1);
    expect(hit.unchanged).toBe(1);
    expect(hit.regressed).toBe(0);
  });

  it('lists items present on only one side instead of dropping them', () => {
    const baseline = [ep('a', scored(1)), ep('gone', scored(1))];
    const candidate = [ep('a', scored(1), 'run-b'), ep('new', scored(0), 'run-b')];
    const result = compareEpisodeSets(baseline, candidate, keys);
    expect(result.pairedItemCount).toBe(1);
    expect(result.unpaired).toEqual([
      { itemId: 'gone', presentIn: 'baseline', episodeId: 'run-a:gone' },
      { itemId: 'new', presentIn: 'candidate', episodeId: 'run-b:new' },
    ]);
    expect(result.metrics['hit@1']!.nPaired).toBe(1);
  });

  it('handles zero paired items without producing a delta', () => {
    const result = compareEpisodeSets([ep('a', scored(1))], [ep('b', scored(0), 'run-b')], keys);
    const hit = result.metrics['hit@1']!;
    expect(result.pairedItemCount).toBe(0);
    expect(hit.nPaired).toBe(0);
    expect(hit.meanDelta).toBeNull();
    expect(hit.medianDelta).toBeNull();
    expect(hit.deltaCi).toBeNull();
    expect(hit.signTest.pValue).toBe(1);
    expect(result.unpaired).toHaveLength(2);
  });

  it('handles two empty sides', () => {
    const result = compareEpisodeSets([], [], keys);
    expect(result.pairedItemCount).toBe(0);
    expect(result.unpaired).toEqual([]);
    expect(result.metrics['hit@1']!.nPaired).toBe(0);
    expect(result.coverageWarnings).toEqual([]);
  });

  it('counts a paired item that only one side could score, per side', () => {
    const baseline = [ep('a', scored(1)), ep('b', unscorable('coverage_below_floor')), ep('c', scored(1))];
    const candidate = [
      ep('a', unscorable('empty_retrieval'), 'run-b'),
      ep('b', scored(1), 'run-b'),
      ep('c', unscorable('no_judgement'), 'run-b'),
    ];
    const result = compareEpisodeSets(baseline, candidate, keys);
    const hit = result.metrics['hit@1']!;
    expect(hit.nPaired).toBe(0);
    expect(hit.nDroppedCandidateUnscorable).toBe(2);
    expect(hit.nDroppedBaselineUnscorable).toBe(1);
    expect(hit.nDroppedBothUnscorable).toBe(0);
  });

  it('counts an item unscorable on both sides separately', () => {
    const baseline = [ep('a', unscorable('no_judgement'))];
    const candidate = [ep('a', unscorable('no_judgement'), 'run-b')];
    const hit = compareEpisodeSets(baseline, candidate, keys).metrics['hit@1']!;
    expect(hit.nDroppedBothUnscorable).toBe(1);
    expect(hit.nPaired).toBe(0);
  });

  it('orients deltas as candidate minus baseline', () => {
    const baseline = [ep('a', scored(1)), ep('b', scored(1))];
    const candidate = [ep('a', scored(0), 'run-b'), ep('b', scored(0), 'run-b')];
    const hit = compareEpisodeSets(baseline, candidate, keys).metrics['hit@1']!;
    expect(hit.meanDelta).toBe(-1);
    expect(hit.regressed).toBe(2);
    expect(hit.baselineMean).toBe(1);
    expect(hit.candidateMean).toBe(0);
  });

  it('produces a reproducible bootstrap CI on the paired delta', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    const baseline = items.map((id, index) => ep(id, scored(index % 2)));
    const candidate = items.map((id, index) => ep(id, scored((index + 1) % 2), 'run-b'));
    const first = compareEpisodeSets(baseline, candidate, { ...keys, resamples: 300 });
    const second = compareEpisodeSets(baseline, candidate, { ...keys, resamples: 300 });
    expect(first.metrics['hit@1']!.deltaCi).toEqual(second.metrics['hit@1']!.deltaCi);
    expect(first.metrics['hit@1']!.deltaCi!.resamples).toBe(300);
  });

  it('warns when the two sides unscorable rates diverge materially', () => {
    const items = ['a', 'b', 'c', 'd'];
    const baseline = items.map((id) => ep(id, scored(1)));
    const candidate = items.map((id, index) =>
      ep(id, index < 2 ? scored(1) : unscorable('coverage_below_floor'), 'run-b'),
    );
    const result = compareEpisodeSets(baseline, candidate, keys);
    expect(result.coverageWarnings).toHaveLength(1);
    const warning = result.coverageWarnings[0]!;
    expect(warning.metric).toBe('hit@1');
    expect(warning.baselineUnscorableRate).toBe(0);
    expect(warning.candidateUnscorableRate).toBe(0.5);
    expect(warning.difference).toBeGreaterThanOrEqual(COVERAGE_WARNING_THRESHOLD);
    expect(warning.reasonDeltas.coverage_below_floor).toBe(2);
    expect(warning.message).toContain('unscorable rate differs');
  });

  it('stays quiet when the unscorable rates match', () => {
    const reasons: UnscorableReason[] = ['no_judgement', 'no_judgement'];
    const baseline = ['a', 'b', 'c', 'd'].map((id, index) =>
      ep(id, index < 2 ? scored(1) : unscorable(reasons[index - 2]!)),
    );
    const candidate = ['a', 'b', 'c', 'd'].map((id, index) =>
      ep(id, index < 2 ? scored(0) : unscorable(reasons[index - 2]!), 'run-b'),
    );
    expect(compareEpisodeSets(baseline, candidate, keys).coverageWarnings).toEqual([]);
  });

  it('respects a caller-supplied warning threshold', () => {
    const baseline = ['a', 'b', 'c', 'd'].map((id) => ep(id, scored(1)));
    const candidate = ['a', 'b', 'c', 'd'].map((id, index) =>
      ep(id, index < 3 ? scored(1) : unscorable('empty_retrieval'), 'run-b'),
    );
    // 25 points of divergence: warned at the default, silent at a 50-point threshold.
    expect(compareEpisodeSets(baseline, candidate, keys).coverageWarnings).toHaveLength(1);
    expect(
      compareEpisodeSets(baseline, candidate, { ...keys, coverageWarningThreshold: 0.5 }).coverageWarnings,
    ).toHaveLength(0);
  });

  it('reports duplicate itemIds and uses the first episode', () => {
    const baseline = [ep('a', scored(1)), ep('a', scored(0))];
    const candidate = [ep('a', scored(1), 'run-b')];
    const result = compareEpisodeSets(baseline, candidate, keys);
    expect(result.duplicateItemIds).toEqual(['a']);
    expect(result.metrics['hit@1']!.nPaired).toBe(1);
    expect(result.metrics['hit@1']!.meanDelta).toBe(0);
  });

  it('carries both side aggregates and their labels', () => {
    const result = compareEpisodeSets([ep('a', scored(1))], [ep('a', scored(0), 'run-b')], {
      ...keys,
      baselineLabel: 'pre-docling',
      candidateLabel: 'post-docling',
    });
    expect(result.baseline.label).toBe('pre-docling');
    expect(result.candidate.label).toBe('post-docling');
    expect(result.baseline.metrics['hit@1']!.mean).toBe(1);
    expect(result.candidate.metrics['hit@1']!.mean).toBe(0);
    expect(result.metricOrder).toEqual(['hit@1']);
  });

  it('unions metric keys across the two sides when none are supplied', () => {
    const baseline = [ep('a', scored(1))];
    const candidate = [
      { ...ep('a', scored(1), 'run-b'), metrics: { 'hit@1': scored(1), 'ndcg@1': scored(0.5) } },
    ];
    const result = compareEpisodeSets(baseline, candidate);
    expect(result.metricOrder).toContain('hit@1');
    expect(result.metricOrder).toContain('ndcg@1');
  });
});
