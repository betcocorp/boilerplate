/**
 * Hand-built {@link RetrievalEpisode} fixtures for the Phase 3 metric modules.
 *
 * Pure data. No database, no clock, no adapter — that is the point: `types.ts` puts the metric core
 * behind an in-memory shape precisely so metrics are testable without the local database, which is
 * not built from migrations (F7) and carries stuck runs and counter drift (F9). A metric only
 * testable against live rows is a metric nobody can debug.
 *
 * Each fixture isolates ONE condition a metric has to handle correctly, so a failing test names the
 * condition:
 *
 * - {@link cleanEpisode} — the happy path. One call, everything resolved, reranked.
 * - {@link nullCallsEpisode} — `calls: null`. Pre-`retrieval_calls` payload; rank metrics must skip
 *   it and must never read it as a zero.
 * - {@link emptyCallsEpisode} — `calls: []`. The turn genuinely retrieved nothing. Scoreable, and
 *   the counterpart the `null` case must be distinguished from.
 * - {@link lowCoverageEpisode} — `resolvedShare` far below any sane floor. A stale join after a
 *   re-ingest, not a retrieval failure.
 * - {@link multiCallOverlapEpisode} — two calls retrieving overlapping documents at different
 *   ranks. The fixture that separates `best_rank` / `first_call` / `concat` fusion.
 * - {@link noRerankEpisode} — the reranker did not run: every `rerankScore`/`rerankRank` is null.
 *   Under `basis: 'reranked'` there is no reranked order to read.
 * - {@link unresolvedTextEpisode} — candidates present and correctly ranked, but their text did not
 *   resolve. Rank metrics can score it; entity recall, which reads only `text`, cannot.
 *
 * Document ids are readable strings rather than uuids on purpose — a fixture that has to be
 * cross-referenced against a uuid table is a fixture nobody reads. Chunk ids ARE uuid-shaped where
 * the shape matters, because `synthetic` vs `missing` classification keys off it.
 */

import type { Coverage, RankedCandidate, RetrievalCall, RetrievalEpisode } from '../types';

const CHUNK = {
  a1: '11111111-1111-4111-8111-111111111111',
  a2: '11111111-1111-4111-8111-111111111112',
  b1: '22222222-2222-4222-8222-222222222221',
  b2: '22222222-2222-4222-8222-222222222222',
  c1: '33333333-3333-4333-8333-333333333331',
  gone: '44444444-4444-4444-8444-444444444444',
} as const;

/** Builds a coverage block from the four counts, deriving `resolvedShare` the way Phase 0 does. */
function coverageOf(counts: {
  resolved: number;
  missing: number;
  synthetic: number;
  noChunkId: number;
}): Coverage {
  const requested = counts.resolved + counts.missing + counts.synthetic + counts.noChunkId;
  const joinable = requested - counts.synthetic;
  return {
    requested,
    ...counts,
    resolvedShare: joinable > 0 ? counts.resolved / joinable : null,
  };
}

function candidate(overrides: Partial<RankedCandidate> & Pick<RankedCandidate, 'documentId' | 'rank'>): RankedCandidate {
  return {
    chunkId: null,
    documentKind: 'sds',
    documentTitle: `Title for ${overrides.documentId}`,
    similarity: null,
    rerankScore: null,
    rerankRank: null,
    text: null,
    resolution: 'resolved',
    ...overrides,
  };
}

function call(overrides: Partial<RetrievalCall> & Pick<RetrievalCall, 'candidates'>): RetrievalCall {
  return {
    toolName: 'search_product_knowledge',
    callId: 'call-1',
    strategy: 'hybrid',
    ...overrides,
  };
}

function episode(overrides: Partial<RetrievalEpisode> & Pick<RetrievalEpisode, 'episodeId' | 'itemId'>): RetrievalEpisode {
  return {
    runId: 'run-fixture',
    questionSetId: 'qs-fixture',
    questionSetName: 'phase3-fixtures',
    rowIndex: 0,
    question: 'What is the dilution ratio for this product?',
    answer: 'Dilute 2 oz per gallon of water.',
    reference: 'Dilute 2 oz per gallon of water.',
    passed: true,
    calls: [],
    coverage: coverageOf({ resolved: 0, missing: 0, synthetic: 0, noChunkId: 0 }),
    ...overrides,
  };
}

/** One call, three candidates, all resolved and reranked. The baseline every other fixture varies. */
export const cleanEpisode: RetrievalEpisode = episode({
  episodeId: 'fx-clean',
  itemId: 'item-clean',
  rowIndex: 0,
  calls: [
    call({
      candidates: [
        candidate({
          documentId: 'doc-label-a',
          chunkId: CHUNK.a1,
          rank: 0,
          similarity: 0.82,
          rerankScore: 0.94,
          rerankRank: 0,
          documentKind: 'label',
          text: 'Dilute 2 oz per gallon of water for general cleaning.',
        }),
        candidate({
          documentId: 'doc-sds-b',
          chunkId: CHUNK.b1,
          rank: 1,
          similarity: 0.71,
          rerankScore: 0.61,
          rerankRank: 2,
          text: 'Section 8: exposure controls and personal protection.',
        }),
        candidate({
          documentId: 'doc-label-c',
          chunkId: CHUNK.c1,
          rank: 2,
          similarity: 0.66,
          rerankScore: 0.78,
          rerankRank: 1,
          documentKind: 'label',
          text: 'EPA Reg. No. 1839-83. Contact time 10 minutes.',
        }),
      ],
    }),
  ],
  coverage: coverageOf({ resolved: 3, missing: 0, synthetic: 0, noChunkId: 0 }),
});

/**
 * `calls: null` — the payload predates `retrieval_calls`. Every backfilled run looks like this.
 * A rank metric must return `unscorable('no_retrieval_calls')`, never 0.
 */
export const nullCallsEpisode: RetrievalEpisode = episode({
  episodeId: 'fx-null-calls',
  itemId: 'item-null-calls',
  rowIndex: 1,
  calls: null,
  // Coverage is non-trivial: the forensic union still recorded chunks, so an implementation that
  // infers "no retrieval" from coverage rather than from `calls` will get this one wrong.
  coverage: coverageOf({ resolved: 4, missing: 0, synthetic: 0, noChunkId: 0 }),
});

/** `calls: []` — the turn ran no retrieval tool. Scoreable, and distinct from the above. */
export const emptyCallsEpisode: RetrievalEpisode = episode({
  episodeId: 'fx-empty-calls',
  itemId: 'item-empty-calls',
  rowIndex: 2,
  answer: 'I can only help with Betco product questions.',
  calls: [],
  coverage: coverageOf({ resolved: 0, missing: 0, synthetic: 0, noChunkId: 0 }),
});

/**
 * One of four joinable references resolved (0.25) — below any sane `coverageFloor`. The corpus was
 * re-ingested after the run; the unresolved chunks were retrieved perfectly well at the time.
 */
export const lowCoverageEpisode: RetrievalEpisode = episode({
  episodeId: 'fx-low-coverage',
  itemId: 'item-low-coverage',
  rowIndex: 3,
  calls: [
    call({
      candidates: [
        candidate({
          documentId: 'doc-label-a',
          chunkId: CHUNK.a1,
          rank: 0,
          similarity: 0.8,
          rerankScore: 0.9,
          rerankRank: 0,
          text: 'Dilute 2 oz per gallon of water.',
        }),
        candidate({
          documentId: 'doc-sds-b',
          chunkId: CHUNK.gone,
          rank: 1,
          similarity: 0.7,
          rerankScore: 0.7,
          rerankRank: 1,
          text: null,
          resolution: 'missing',
        }),
        candidate({
          documentId: 'doc-sds-b',
          chunkId: CHUNK.b2,
          rank: 2,
          similarity: 0.6,
          rerankScore: 0.5,
          rerankRank: 2,
          text: null,
          resolution: 'missing',
        }),
        candidate({
          documentId: 'doc-label-c',
          chunkId: CHUNK.c1,
          rank: 3,
          similarity: 0.5,
          rerankScore: 0.4,
          rerankRank: 3,
          text: null,
          resolution: 'missing',
        }),
      ],
    }),
  ],
  coverage: coverageOf({ resolved: 1, missing: 3, synthetic: 0, noChunkId: 0 }),
});

/**
 * Two calls whose result sets overlap, at deliberately different ranks:
 *
 * - `doc-sds-b` is rank 2 in call 1 and rank 0 in call 2 → `best_rank` puts it first, `first_call`
 *   keeps it third, `concat` keeps its first occurrence (rank 2 of call 1).
 * - `doc-facts-d` appears only in call 2, and is `synthetic` (a verified-facts block, non-uuid
 *   chunk id) with kind `facts` — the kind `excludeKinds: ['facts']` is meant to drop.
 *
 * The three fusion policies must produce three different orders here, or the fixture is not doing
 * its job.
 */
export const multiCallOverlapEpisode: RetrievalEpisode = episode({
  episodeId: 'fx-multi-call',
  itemId: 'item-multi-call',
  rowIndex: 4,
  calls: [
    call({
      callId: 'call-1',
      candidates: [
        candidate({
          documentId: 'doc-label-a',
          chunkId: CHUNK.a1,
          rank: 0,
          similarity: 0.9,
          rerankScore: 0.88,
          rerankRank: 0,
          documentKind: 'label',
          text: 'Dilute 2 oz per gallon of water.',
        }),
        candidate({
          documentId: 'doc-label-c',
          chunkId: CHUNK.c1,
          rank: 1,
          similarity: 0.75,
          rerankScore: 0.55,
          rerankRank: 2,
          documentKind: 'label',
          text: 'EPA Reg. No. 1839-83.',
        }),
        candidate({
          documentId: 'doc-sds-b',
          chunkId: CHUNK.b1,
          rank: 2,
          similarity: 0.7,
          rerankScore: 0.72,
          rerankRank: 1,
          text: 'Section 4: first-aid measures.',
        }),
      ],
    }),
    call({
      callId: 'call-2',
      strategy: 'vector',
      candidates: [
        candidate({
          documentId: 'doc-sds-b',
          chunkId: CHUNK.b2,
          rank: 0,
          similarity: 0.86,
          rerankScore: 0.81,
          rerankRank: 0,
          text: 'Section 8: exposure controls.',
        }),
        candidate({
          documentId: 'doc-label-a',
          chunkId: CHUNK.a2,
          rank: 1,
          similarity: 0.64,
          rerankScore: 0.6,
          rerankRank: 1,
          documentKind: 'label',
          text: 'Contact time 10 minutes on hard non-porous surfaces.',
        }),
        candidate({
          documentId: 'verified-facts',
          chunkId: 'verified-facts:foamy-q',
          rank: 2,
          similarity: null,
          rerankScore: null,
          rerankRank: null,
          documentKind: 'facts',
          documentTitle: 'Verified facts: Foamy Q',
          text: 'Dilution: 2 oz/gal.',
          resolution: 'synthetic',
        }),
      ],
    }),
  ],
  coverage: coverageOf({ resolved: 5, missing: 0, synthetic: 1, noChunkId: 0 }),
});

/**
 * The reranker did not run: `rerankScore` and `rerankRank` are null on every candidate, while
 * `similarity` and the retrieved order are intact. Under `basis: 'reranked'` there is no reranked
 * order to read — falling back to retrieved order silently would make `rerank-effect` report a
 * zero effect instead of "not measurable here".
 */
export const noRerankEpisode: RetrievalEpisode = episode({
  episodeId: 'fx-no-rerank',
  itemId: 'item-no-rerank',
  rowIndex: 5,
  calls: [
    call({
      strategy: 'keyword',
      candidates: [
        candidate({
          documentId: 'doc-sds-b',
          chunkId: CHUNK.b1,
          rank: 0,
          similarity: 0.58,
          text: 'Section 4: first-aid measures. Rinse cautiously with water.',
        }),
        candidate({
          documentId: 'doc-label-a',
          chunkId: CHUNK.a1,
          rank: 1,
          similarity: 0.55,
          documentKind: 'label',
          text: 'Dilute 2 oz per gallon of water.',
        }),
      ],
    }),
  ],
  coverage: coverageOf({ resolved: 2, missing: 0, synthetic: 0, noChunkId: 0 }),
});

/**
 * Ranked candidates whose text did not resolve, for three different reasons — `missing` (re-ingest),
 * `no_chunk_id` (a legacy `sources` fallback row) and one resolved chunk to stop the episode being
 * degenerate. Rank metrics work on it; entity recall, which reads only `text`, must report
 * `no_resolved_text` rather than scoring every requirement as a miss.
 *
 * Coverage here is 1/3 ≈ 0.33, so a metric that also enforces `coverageFloor` will skip it first —
 * which is why the two conditions are separated across this fixture and {@link lowCoverageEpisode}
 * only by intent, not by shape.
 */
export const unresolvedTextEpisode: RetrievalEpisode = episode({
  episodeId: 'fx-unresolved-text',
  itemId: 'item-unresolved-text',
  rowIndex: 6,
  calls: [
    call({
      candidates: [
        candidate({
          documentId: 'doc-sds-b',
          chunkId: CHUNK.gone,
          rank: 0,
          similarity: 0.83,
          rerankScore: 0.91,
          rerankRank: 0,
          text: null,
          resolution: 'missing',
        }),
        candidate({
          documentId: 'doc-legacy-e',
          chunkId: null,
          rank: 1,
          similarity: 0.6,
          rerankScore: 0.5,
          rerankRank: 1,
          documentTitle: 'Legacy source row',
          text: null,
          resolution: 'no_chunk_id',
        }),
        candidate({
          documentId: 'doc-label-a',
          chunkId: CHUNK.a1,
          rank: 2,
          similarity: 0.52,
          rerankScore: 0.33,
          rerankRank: 2,
          documentKind: 'label',
          text: 'Dilute 2 oz per gallon of water.',
        }),
      ],
    }),
  ],
  coverage: coverageOf({ resolved: 1, missing: 1, synthetic: 0, noChunkId: 1 }),
});

/** Named lookup, for tests that want one condition by name. */
export const EPISODE_FIXTURES = {
  clean: cleanEpisode,
  nullCalls: nullCallsEpisode,
  emptyCalls: emptyCallsEpisode,
  lowCoverage: lowCoverageEpisode,
  multiCallOverlap: multiCallOverlapEpisode,
  noRerank: noRerankEpisode,
  unresolvedText: unresolvedTextEpisode,
} as const;

/** Every fixture, in `rowIndex` order — a stand-in "run" for aggregate and snapshot tests. */
export const ALL_EPISODE_FIXTURES: RetrievalEpisode[] = [
  cleanEpisode,
  nullCallsEpisode,
  emptyCallsEpisode,
  lowCoverageEpisode,
  multiCallOverlapEpisode,
  noRerankEpisode,
  unresolvedTextEpisode,
];
