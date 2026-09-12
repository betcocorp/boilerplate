import { describe, expect, it } from 'vitest';

import { RERANKER_ABSENT_DETAIL, rerankEffectMetrics, scoreRerankEffect } from './rerank-effect';
import type { Coverage, DocumentRelevance, Judgement, RankedCandidate, RetrievalEpisode } from './types';

/* Fixtures inline, so these tests do not depend on another agent's fixture module. */

const candidate = (
  documentId: string,
  rank: number,
  rerankRank: number | null,
  overrides: Partial<RankedCandidate> = {},
): RankedCandidate => ({
  documentId,
  chunkId: `${documentId}-c${rank}`,
  documentKind: 'sds',
  documentTitle: null,
  rank,
  similarity: 1 - rank / 100,
  rerankScore: rerankRank === null ? null : 1 - rerankRank / 100,
  rerankRank,
  text: 'body',
  resolution: 'resolved',
  ...overrides,
});

const relevant = (...ids: string[]): DocumentRelevance[] =>
  ids.map((documentId) => ({ documentId, gain: 1 }));

describe('scoreRerankEffect', () => {
  it('measures displacement, MRR lift and top-k crossings when the reranker promotes', () => {
    // Retrieved order: noise, noise, noise, rel-a. Reranked order: rel-a first.
    const candidates = [
      candidate('noise-1', 0, 1),
      candidate('noise-2', 1, 2),
      candidate('noise-3', 2, 3),
      candidate('rel-a', 3, 0),
    ];

    const result = scoreRerankEffect(candidates, relevant('rel-a'), { ks: [1, 3], excludeKinds: [] });
    expect(result.scored).toBe(true);
    if (!result.scored) return;

    expect(result.value.comparedCandidates).toBe(4);
    expect(result.value.relevantCompared).toBe(1);
    expect(result.value.displacements[0]).toMatchObject({
      documentId: 'rel-a',
      retrievedRank: 4,
      rerankedRank: 1,
      displacement: 3,
    });
    expect(result.value.meanDisplacement).toBe(3);
    expect(result.value.mrrRetrieved).toBeCloseTo(1 / 4, 10);
    expect(result.value.mrrReranked).toBe(1);
    expect(result.value.mrrLift).toBeCloseTo(0.75, 10);
    expect(result.value.crossings).toEqual([
      { k: 1, relevantInTopKRetrieved: 0, relevantInTopKReranked: 1, entered: 1, left: 0, delta: 1 },
      { k: 3, relevantInTopKRetrieved: 0, relevantInTopKReranked: 1, entered: 1, left: 0, delta: 1 },
    ]);
  });

  it('reports negative displacement and a negative lift when the reranker demotes', () => {
    const candidates = [
      candidate('rel-a', 0, 3),
      candidate('noise-1', 1, 0),
      candidate('noise-2', 2, 1),
      candidate('noise-3', 3, 2),
    ];
    const result = scoreRerankEffect(candidates, relevant('rel-a'), { ks: [3], excludeKinds: [] });
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.meanDisplacement).toBe(-3);
    expect(result.value.mrrLift).toBeCloseTo(1 / 4 - 1, 10);
    expect(result.value.crossings[0]).toMatchObject({ entered: 0, left: 1, delta: -1 });
  });

  it('averages signed movement across several relevant documents', () => {
    const candidates = [
      candidate('rel-a', 0, 2), // 1 -> 3, demoted by 2
      candidate('rel-b', 1, 0), // 2 -> 1, promoted by 1
      candidate('noise-1', 2, 1),
    ];
    const result = scoreRerankEffect(candidates, relevant('rel-a', 'rel-b'), {
      ks: [1],
      excludeKinds: [],
    });
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.meanDisplacement).toBeCloseTo(-0.5, 10);
    // The mean hides the spread, which is why the per-document rows are reported too.
    expect(result.value.displacements.map((row) => row.displacement).sort()).toEqual([-2, 1]);
  });

  it('scores a document at its best position when it contributes several chunks', () => {
    const candidates = [
      candidate('noise-1', 0, 0),
      candidate('rel-a', 1, 3),
      candidate('rel-a', 2, 1),
    ];
    const result = scoreRerankEffect(candidates, relevant('rel-a'), { ks: [2], excludeKinds: [] });
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.displacements[0]).toMatchObject({ retrievedRank: 2, rerankedRank: 2 });
  });

  it('recomputes dense positions after filtering, so gaps cannot skew MRR', () => {
    // rank 0 has no rerankRank and drops out; rel-a is then position 1 in both orders.
    const candidates = [candidate('noise-1', 0, null), candidate('rel-a', 5, 9)];
    const result = scoreRerankEffect(candidates, relevant('rel-a'), { ks: [1], excludeKinds: [] });
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.comparedCandidates).toBe(1);
    expect(result.value.mrrRetrieved).toBe(1);
    expect(result.value.mrrReranked).toBe(1);
    expect(result.value.mrrLift).toBe(0);
  });

  it('is unscorable — not zero — when the reranker did not run', () => {
    const candidates = [candidate('rel-a', 0, null), candidate('noise-1', 1, null)];
    expect(scoreRerankEffect(candidates, relevant('rel-a'))).toEqual({
      scored: false,
      reason: 'reranker_absent',
      detail: RERANKER_ABSENT_DETAIL,
    });
  });

  it('is unscorable when there are no candidates at all', () => {
    expect(scoreRerankEffect([], relevant('rel-a'))).toMatchObject({
      scored: false,
      reason: 'empty_retrieval',
      detail: 'ranked candidate list is empty',
    });
  });

  it('is unscorable when nothing is labelled relevant', () => {
    expect(scoreRerankEffect([candidate('doc-a', 0, 0)], [])).toMatchObject({
      scored: false,
      reason: 'no_judgement',
    });
    expect(
      scoreRerankEffect([candidate('doc-a', 0, 0)], [{ documentId: 'doc-a', gain: 0 }]),
    ).toMatchObject({ scored: false, reason: 'no_judgement' });
  });

  it('reports MRR 0 on both sides when nothing relevant was retrieved at all', () => {
    const result = scoreRerankEffect([candidate('noise-1', 0, 0)], relevant('rel-a'), {
      ks: [1],
      excludeKinds: [],
    });
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.mrrRetrieved).toBe(0);
    expect(result.value.mrrReranked).toBe(0);
    expect(result.value.relevantCompared).toBe(0);
    expect(result.value.meanDisplacement).toBeNull();
  });

  it('drops excluded document kinds before comparing', () => {
    const candidates = [
      candidate('facts-1', 0, 0, { documentKind: 'facts' }),
      candidate('rel-a', 1, 1),
    ];
    const result = scoreRerankEffect(candidates, relevant('rel-a'), {
      ks: [1],
      excludeKinds: ['facts'],
    });
    expect(result.scored).toBe(true);
    if (!result.scored) return;
    expect(result.value.comparedCandidates).toBe(1);
    expect(result.value.mrrRetrieved).toBe(1);
  });
});

describe('rerankEffectMetrics', () => {
  const coverage: Coverage = {
    requested: 2,
    resolved: 2,
    missing: 0,
    synthetic: 0,
    noChunkId: 0,
    resolvedShare: 1,
  };

  const judgement: Judgement = {
    itemId: 'item-1',
    relevantDocuments: [{ documentId: 'rel-a', gain: 2 }],
    entities: [],
    isNegative: false,
    notes: null,
  };

  const episode = (calls: RetrievalEpisode['calls']): RetrievalEpisode => ({
    episodeId: 'ep-1',
    itemId: 'item-1',
    runId: 'run-1',
    questionSetId: 'qs-1',
    questionSetName: null,
    rowIndex: 0,
    question: 'q',
    answer: null,
    reference: null,
    passed: true,
    calls,
    coverage,
  });

  const options = { ...({ fusion: 'best_rank', basis: 'reranked' } as const), ks: [1], coverageFloor: 0.8, excludeKinds: [] };

  it('flattens the promoted case onto snapshot metric keys', () => {
    const metrics = rerankEffectMetrics(
      episode([
        {
          toolName: 'search',
          callId: '1',
          strategy: 'hybrid',
          candidates: [candidate('noise-1', 0, 1), candidate('rel-a', 1, 0)],
        },
      ]),
      judgement,
      options,
    );
    expect(metrics['rerank.mrr_retrieved']).toEqual({ scored: true, value: 0.5 });
    expect(metrics['rerank.mrr_reranked']).toEqual({ scored: true, value: 1 });
    expect(metrics['rerank.mrr_lift']).toEqual({ scored: true, value: 0.5 });
    expect(metrics['rerank.entered_top_1']).toEqual({ scored: true, value: 1 });
    expect(metrics['rerank.left_top_1']).toEqual({ scored: true, value: 0 });
  });

  it('marks every metric unscorable when the reranker did not run', () => {
    const metrics = rerankEffectMetrics(
      episode([
        {
          toolName: 'search',
          callId: '1',
          strategy: 'hybrid',
          candidates: [candidate('rel-a', 0, null)],
        },
      ]),
      judgement,
      options,
    );
    for (const value of Object.values(metrics)) {
      expect(value).toEqual({
        scored: false,
        reason: 'reranker_absent',
        detail: RERANKER_ABSENT_DETAIL,
      });
    }
  });

  it('distinguishes a payload with no retrieval calls at all', () => {
    const metrics = rerankEffectMetrics(episode(null), judgement, options);
    expect(metrics['rerank.mrr_lift']).toMatchObject({
      scored: false,
      reason: 'no_retrieval_calls',
    });
  });
});
