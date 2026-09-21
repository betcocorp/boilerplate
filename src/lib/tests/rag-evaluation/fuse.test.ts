import { describe, expect, it } from 'vitest';

import { fuseCalls, fuseEpisode } from './fuse';
import type { FusionOptions } from './fuse';
import type { Coverage, RankedCandidate, RetrievalCall, RetrievalEpisode } from './types';

const candidate = (overrides: Partial<RankedCandidate> & { documentId: string; rank: number }): RankedCandidate => ({
  chunkId: null,
  documentKind: 'sds',
  documentTitle: null,
  similarity: null,
  rerankScore: null,
  rerankRank: null,
  text: null,
  resolution: 'resolved',
  ...overrides,
});

const call = (candidates: RankedCandidate[], overrides: Partial<RetrievalCall> = {}): RetrievalCall => ({
  toolName: 'search_products',
  callId: null,
  strategy: null,
  candidates,
  ...overrides,
});

const coverage: Coverage = {
  requested: 3,
  resolved: 3,
  missing: 0,
  synthetic: 0,
  noChunkId: 0,
  resolvedShare: 1,
};

const options = (overrides: Partial<FusionOptions> = {}): FusionOptions => ({
  fusion: 'best_rank',
  basis: 'retrieved',
  excludeKinds: [],
  ...overrides,
});

describe('fuseCalls', () => {
  it('returns an empty, pure ranking for no calls', () => {
    const fused = fuseCalls([], options());
    expect(fused.candidates).toEqual([]);
    expect(fused.calls).toEqual([]);
    expect(fused.basisIsPure).toBe(true);
    expect(fused.duplicatesDropped).toBe(0);
  });

  it('handles a call with an empty candidate list', () => {
    const fused = fuseCalls([call([])], options());
    expect(fused.candidates).toHaveLength(0);
    expect(fused.calls[0]?.candidateCount).toBe(0);
  });

  it('assigns dense 0-based fused ranks', () => {
    const fused = fuseCalls(
      [call([candidate({ documentId: 'a', rank: 0 }), candidate({ documentId: 'b', rank: 1 })])],
      options(),
    );
    expect(fused.candidates.map((c) => c.fusedRank)).toEqual([0, 1]);
  });

  describe('best_rank', () => {
    it('keeps the best rank across calls and dedupes', () => {
      const fused = fuseCalls(
        [
          call([candidate({ documentId: 'a', rank: 0 }), candidate({ documentId: 'b', rank: 1 })]),
          call([candidate({ documentId: 'b', rank: 0 }), candidate({ documentId: 'c', rank: 1 })]),
        ],
        options(),
      );
      expect(fused.candidates.map((c) => c.documentId)).toEqual(['a', 'b', 'c']);
      expect(fused.candidates.map((c) => c.basisRank)).toEqual([0, 0, 1]);
      expect(fused.duplicatesDropped).toBe(1);
      expect(fused.candidates[1]?.duplicatesAbsorbed).toBe(1);
      // b's improved placement came from the second call.
      expect(fused.candidates[1]?.callIndex).toBe(1);
    });

    it('breaks ties by earlier call, then by first occurrence', () => {
      const fused = fuseCalls(
        [
          call([candidate({ documentId: 'a', rank: 0 }), candidate({ documentId: 'b', rank: 0 })]),
          call([candidate({ documentId: 'c', rank: 0 })]),
        ],
        options(),
      );
      expect(fused.candidates.map((c) => c.documentId)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('first_call', () => {
    it('ignores every call after the first', () => {
      const fused = fuseCalls(
        [
          call([candidate({ documentId: 'a', rank: 0 })]),
          call([candidate({ documentId: 'z', rank: 0 })]),
        ],
        options({ fusion: 'first_call' }),
      );
      expect(fused.candidates.map((c) => c.documentId)).toEqual(['a']);
      expect(fused.calls).toHaveLength(1);
    });

    it('yields an empty list when the first call is empty, even if later calls found things', () => {
      const fused = fuseCalls(
        [call([]), call([candidate({ documentId: 'a', rank: 0 })])],
        options({ fusion: 'first_call' }),
      );
      expect(fused.candidates).toEqual([]);
    });
  });

  describe('concat', () => {
    it('preserves encounter order and drops later duplicates', () => {
      const fused = fuseCalls(
        [
          call([candidate({ documentId: 'a', rank: 0 }), candidate({ documentId: 'b', rank: 1 })]),
          call([candidate({ documentId: 'b', rank: 0 }), candidate({ documentId: 'c', rank: 1 })]),
        ],
        options({ fusion: 'concat' }),
      );
      expect(fused.candidates.map((c) => c.documentId)).toEqual(['a', 'b', 'c']);
      // Unlike best_rank, b keeps its first-call placement.
      expect(fused.candidates[1]?.basisRank).toBe(1);
      expect(fused.candidates[1]?.callIndex).toBe(0);
      expect(fused.duplicatesDropped).toBe(1);
    });
  });

  describe('dedupe key', () => {
    it('keeps two chunks of the same document as two positions', () => {
      const fused = fuseCalls(
        [
          call([
            candidate({ documentId: 'a', chunkId: 'a#1', rank: 0 }),
            candidate({ documentId: 'a', chunkId: 'a#2', rank: 1 }),
          ]),
        ],
        options(),
      );
      expect(fused.candidates).toHaveLength(2);
      expect(fused.duplicatesDropped).toBe(0);
    });

    it('collapses repeats of a chunkless document', () => {
      const fused = fuseCalls(
        [
          call([candidate({ documentId: 'a', rank: 0 })]),
          call([candidate({ documentId: 'a', rank: 0 })]),
        ],
        options(),
      );
      expect(fused.candidates).toHaveLength(1);
      expect(fused.duplicatesDropped).toBe(1);
    });

    it('collapses the same chunk id seen in two calls', () => {
      const fused = fuseCalls(
        [
          call([candidate({ documentId: 'a', chunkId: 'a#1', rank: 2 })]),
          call([candidate({ documentId: 'a', chunkId: 'a#1', rank: 0 })]),
        ],
        options(),
      );
      expect(fused.candidates).toHaveLength(1);
      expect(fused.candidates[0]?.basisRank).toBe(0);
    });
  });

  describe('excludeKinds', () => {
    it('filters before ranks are recomputed, leaving dense positions', () => {
      const fused = fuseCalls(
        [
          call([
            candidate({ documentId: 'f1', documentKind: 'facts', rank: 0 }),
            candidate({ documentId: 'a', rank: 1 }),
            candidate({ documentId: 'f2', documentKind: 'facts', rank: 2 }),
            candidate({ documentId: 'b', rank: 3 }),
          ]),
        ],
        options({ excludeKinds: ['facts'] }),
      );
      expect(fused.candidates.map((c) => c.documentId)).toEqual(['a', 'b']);
      expect(fused.candidates.map((c) => c.fusedRank)).toEqual([0, 1]);
      expect(fused.excludedByKind).toBe(2);
    });

    it('never excludes a candidate with a null documentKind', () => {
      const fused = fuseCalls(
        [call([candidate({ documentId: 'a', documentKind: null, rank: 0 })])],
        options({ excludeKinds: ['facts'] }),
      );
      expect(fused.candidates).toHaveLength(1);
    });

    it('lets exclusion suppress a null rerankRank so the call no longer falls back', () => {
      const fused = fuseCalls(
        [
          call([
            candidate({ documentId: 'a', rank: 0, rerankRank: 1 }),
            candidate({ documentId: 'f', documentKind: 'facts', rank: 1, rerankRank: null }),
            candidate({ documentId: 'b', rank: 2, rerankRank: 0 }),
          ]),
        ],
        options({ basis: 'reranked', excludeKinds: ['facts'] }),
      );
      expect(fused.basisIsPure).toBe(true);
      expect(fused.candidates.map((c) => c.documentId)).toEqual(['b', 'a']);
    });
  });

  describe('rank basis', () => {
    it('orders by rerankRank under a reranked basis', () => {
      const fused = fuseCalls(
        [
          call([
            candidate({ documentId: 'a', rank: 0, rerankRank: 2 }),
            candidate({ documentId: 'b', rank: 1, rerankRank: 0 }),
            candidate({ documentId: 'c', rank: 2, rerankRank: 1 }),
          ]),
        ],
        options({ basis: 'reranked' }),
      );
      expect(fused.candidates.map((c) => c.documentId)).toEqual(['b', 'c', 'a']);
      expect(fused.basisIsPure).toBe(true);
      expect(fused.rerankFallbackCandidates).toBe(0);
    });

    it('ignores rerankRank entirely under a retrieved basis', () => {
      const fused = fuseCalls(
        [
          call([
            candidate({ documentId: 'a', rank: 0, rerankRank: 2 }),
            candidate({ documentId: 'b', rank: 1, rerankRank: 0 }),
          ]),
        ],
        options({ basis: 'retrieved' }),
      );
      expect(fused.candidates.map((c) => c.documentId)).toEqual(['a', 'b']);
      expect(fused.basisIsPure).toBe(true);
    });

    it('falls back to rank for the whole call when any rerankRank is null, and records it', () => {
      const fused = fuseCalls(
        [
          call([
            candidate({ documentId: 'a', rank: 0, rerankRank: 2 }),
            candidate({ documentId: 'b', rank: 1, rerankRank: null }),
          ]),
        ],
        options({ basis: 'reranked' }),
      );
      expect(fused.candidates.map((c) => c.documentId)).toEqual(['a', 'b']);
      expect(fused.basisIsPure).toBe(false);
      expect(fused.rerankFallbackCalls).toBe(1);
      expect(fused.rerankFallbackCandidates).toBe(2);
      expect(fused.calls[0]?.nullRerankRankCount).toBe(1);
      expect(fused.candidates.every((c) => c.rerankFallback)).toBe(true);
    });

    it('scopes the fallback to the call that lacked reranking', () => {
      const fused = fuseCalls(
        [
          call([candidate({ documentId: 'a', rank: 0, rerankRank: null })]),
          call([candidate({ documentId: 'b', rank: 5, rerankRank: 0 })]),
        ],
        options({ basis: 'reranked' }),
      );
      expect(fused.rerankFallbackCalls).toBe(1);
      expect(fused.rerankFallbackCandidates).toBe(1);
      expect(fused.calls[1]?.rerankFallback).toBe(false);
      expect(fused.basisIsPure).toBe(false);
    });
  });

  it('echoes the policy and basis it was asked for', () => {
    const fused = fuseCalls([], options({ fusion: 'concat', basis: 'reranked' }));
    expect(fused.policy).toBe('concat');
    expect(fused.basis).toBe('reranked');
  });
});

describe('fuseEpisode', () => {
  const episode = (calls: RetrievalCall[] | null): RetrievalEpisode => ({
    episodeId: 'e1',
    itemId: 'i1',
    runId: 'r1',
    questionSetId: 'qs1',
    questionSetName: null,
    rowIndex: 0,
    question: 'q',
    answer: null,
    reference: null,
    passed: true,
    calls,
    coverage,
  });

  it('returns null for a pre-Phase-0 episode with null calls', () => {
    expect(fuseEpisode(episode(null), options())).toBeNull();
  });

  it('distinguishes null calls from an empty call list', () => {
    const fused = fuseEpisode(episode([]), options());
    expect(fused).not.toBeNull();
    expect(fused?.candidates).toEqual([]);
  });
});
