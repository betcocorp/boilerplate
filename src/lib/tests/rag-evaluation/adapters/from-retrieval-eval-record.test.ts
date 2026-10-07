import { describe, expect, it } from 'vitest';

import type { ResolvedContext, RetrievalEvalRecord } from '~/lib/tests/retrieval-dataset';

import {
  classifyUnmatchedChunk,
  indexContexts,
  toRetrievalEpisode,
  toRetrievalEpisodes,
  type EpisodeContext,
} from './from-retrieval-eval-record';

const CONTEXT: EpisodeContext = {
  runId: 'run-1',
  questionSetId: 'qs-1',
  questionSetName: 'product-specialist-25',
};

const CHUNK_A = '11111111-1111-4111-8111-111111111111';
const CHUNK_B = '22222222-2222-4222-8222-222222222222';
const CHUNK_GONE = '33333333-3333-4333-8333-333333333333';

function resolvedContext(overrides: Partial<ResolvedContext> = {}): ResolvedContext {
  return {
    document_id: 'doc-a',
    chunk_id: CHUNK_A,
    document_title: 'Doc A',
    document_kind: 'sds',
    product_line_key: 'pl-a',
    text: 'chunk a text',
    heading: 'Section 4',
    chunk_index: 3,
    resolution: 'resolved',
    ...overrides,
  };
}

function record(overrides: Partial<RetrievalEvalRecord> = {}): RetrievalEvalRecord {
  return {
    test_result_item_id: 'tri-1',
    test_item_id: 'item-1',
    row_index: 7,
    user_input: 'What is the dilution?',
    response_text: 'One ounce per gallon.',
    reference: 'One ounce per gallon.',
    passed: true,
    error_message: null,
    workflow_run_id: 'wf-1',
    retrieved_context_ids: [CHUNK_A],
    retrieved_contexts: ['chunk a text'],
    contexts: [resolvedContext()],
    retrieval_calls: [
      {
        tool_name: 'search_product_knowledge',
        call_id: 'call-1',
        retrieval_strategy: 'hybrid',
        chunks: [
          { document_id: 'doc-a', chunk_id: CHUNK_A, similarity: 0.4, rerank_score: 0.9, rerank_rank: 0 },
        ],
      },
    ],
    coverage: {
      requested: 1,
      resolved: 1,
      missing: 0,
      synthetic: 0,
      noChunkId: 0,
      resolvedShare: 1,
    },
    ...overrides,
  };
}

describe('toRetrievalEpisode', () => {
  it('maps the scalar fields and the run context onto the episode', () => {
    const episode = toRetrievalEpisode(record(), CONTEXT);

    expect(episode).toMatchObject({
      episodeId: 'tri-1',
      itemId: 'item-1',
      runId: 'run-1',
      questionSetId: 'qs-1',
      questionSetName: 'product-specialist-25',
      rowIndex: 7,
      question: 'What is the dilution?',
      answer: 'One ounce per gallon.',
      reference: 'One ounce per gallon.',
      passed: true,
    });
  });

  it('joins chunk text from contexts onto the ranked candidate', () => {
    const episode = toRetrievalEpisode(record(), CONTEXT);
    const candidate = episode.calls?.[0]?.candidates[0];

    expect(candidate).toEqual({
      documentId: 'doc-a',
      chunkId: CHUNK_A,
      documentKind: 'sds',
      documentTitle: 'Doc A',
      rank: 0,
      similarity: 0.4,
      rerankScore: 0.9,
      rerankRank: 0,
      text: 'chunk a text',
      resolution: 'resolved',
    });
  });

  it('carries coverage through unchanged', () => {
    const coverage = {
      requested: 9,
      resolved: 4,
      missing: 3,
      synthetic: 2,
      noChunkId: 0,
      resolvedShare: 4 / 7,
    };
    const episode = toRetrievalEpisode(record({ coverage }), CONTEXT);

    expect(episode.coverage).toEqual(coverage);
    expect(episode.coverage).not.toBe(coverage);
  });

  describe('null vs empty retrieval_calls', () => {
    it('keeps null as null — an unknowable payload is never an empty retrieval', () => {
      const episode = toRetrievalEpisode(record({ retrieval_calls: null }), CONTEXT);

      expect(episode.calls).toBeNull();
      expect(episode.calls).not.toEqual([]);
    });

    it('keeps [] as [] — a turn that genuinely ran no retrieval stays scoreable', () => {
      const episode = toRetrievalEpisode(record({ retrieval_calls: [] }), CONTEXT);

      expect(episode.calls).toEqual([]);
      expect(episode.calls).not.toBeNull();
    });
  });

  describe('rank', () => {
    it('is the retriever order, 0-based per call, not a score-derived order', () => {
      const episode = toRetrievalEpisode(
        record({
          retrieval_calls: [
            {
              tool_name: 'search_product_knowledge',
              call_id: 'call-1',
              retrieval_strategy: 'hybrid',
              chunks: [
                { document_id: 'doc-a', chunk_id: CHUNK_A, similarity: 0.1, rerank_score: 0.1, rerank_rank: 0 },
                { document_id: 'doc-b', chunk_id: CHUNK_B, similarity: 0.9, rerank_score: 0.9, rerank_rank: 1 },
              ],
            },
            {
              tool_name: 'search_product_knowledge',
              call_id: 'call-2',
              retrieval_strategy: 'hybrid',
              chunks: [
                { document_id: 'doc-b', chunk_id: CHUNK_B, similarity: 0.5, rerank_score: null, rerank_rank: null },
              ],
            },
          ],
        }),
        CONTEXT,
      );

      // Returned order wins even though doc-b scores higher on both scores.
      expect(episode.calls?.[0]?.candidates.map((c) => [c.documentId, c.rank])).toEqual([
        ['doc-a', 0],
        ['doc-b', 1],
      ]);
      // Rank restarts per call; fusion — not the adapter — decides how calls combine.
      expect(episode.calls?.[1]?.candidates.map((c) => [c.documentId, c.rank])).toEqual([['doc-b', 0]]);
    });

    it('does not invent a rerankRank when the reranker did not run', () => {
      const episode = toRetrievalEpisode(
        record({
          retrieval_calls: [
            {
              tool_name: 'search_product_knowledge',
              call_id: null,
              retrieval_strategy: null,
              chunks: [
                { document_id: 'doc-a', chunk_id: CHUNK_A, similarity: 0.4, rerank_score: null, rerank_rank: null },
              ],
            },
          ],
        }),
        CONTEXT,
      );

      const candidate = episode.calls?.[0]?.candidates[0];
      expect(candidate?.rank).toBe(0);
      expect(candidate?.rerankRank).toBeNull();
      expect(candidate?.rerankScore).toBeNull();
    });
  });

  describe('unresolved candidates', () => {
    it('keeps a ranked chunk whose id resolved to nothing, marked missing', () => {
      const episode = toRetrievalEpisode(
        record({
          contexts: [resolvedContext()],
          retrieval_calls: [
            {
              tool_name: 'search_product_knowledge',
              call_id: 'call-1',
              retrieval_strategy: 'hybrid',
              chunks: [
                { document_id: 'doc-a', chunk_id: CHUNK_A, similarity: 0.4, rerank_score: 0.9, rerank_rank: 0 },
                { document_id: 'doc-a', chunk_id: CHUNK_GONE, similarity: 0.3, rerank_score: 0.8, rerank_rank: 1 },
              ],
            },
          ],
        }),
        CONTEXT,
      );

      const candidates = episode.calls?.[0]?.candidates ?? [];
      // Dropping it would shorten the list and flatter precision@k.
      expect(candidates).toHaveLength(2);
      expect(candidates[1]).toMatchObject({
        chunkId: CHUNK_GONE,
        rank: 1,
        text: null,
        resolution: 'missing',
        // Metadata falls back to a sibling context on the same document; text and resolution never do.
        documentTitle: 'Doc A',
        documentKind: 'sds',
      });
    });

    it('carries the context resolution when the context exists but has no text', () => {
      const episode = toRetrievalEpisode(
        record({
          contexts: [resolvedContext({ text: null, resolution: 'missing' })],
        }),
        CONTEXT,
      );

      expect(episode.calls?.[0]?.candidates[0]).toMatchObject({
        text: null,
        resolution: 'missing',
      });
    });

    it('classifies a non-uuid chunk id as synthetic rather than missing', () => {
      const episode = toRetrievalEpisode(
        record({
          contexts: [],
          retrieval_calls: [
            {
              tool_name: 'lookup_verified_facts',
              call_id: 'call-1',
              retrieval_strategy: null,
              chunks: [
                {
                  document_id: 'verified-facts',
                  chunk_id: 'verified-facts:foamy-q',
                  similarity: null,
                  rerank_score: null,
                  rerank_rank: null,
                },
              ],
            },
          ],
        }),
        CONTEXT,
      );

      expect(episode.calls?.[0]?.candidates[0]?.resolution).toBe('synthetic');
    });

    it('classifies a candidate with no chunk id as no_chunk_id', () => {
      const episode = toRetrievalEpisode(
        record({
          contexts: [],
          retrieval_calls: [
            {
              tool_name: 'search_product_knowledge',
              call_id: 'call-1',
              retrieval_strategy: null,
              chunks: [
                { document_id: 'doc-a', chunk_id: null, similarity: 0.2, rerank_score: null, rerank_rank: null },
              ],
            },
          ],
        }),
        CONTEXT,
      );

      expect(episode.calls?.[0]?.candidates[0]?.resolution).toBe('no_chunk_id');
    });
  });

  it('resolves the same chunk for every call that retrieved it', () => {
    const episode = toRetrievalEpisode(
      record({
        contexts: [resolvedContext()],
        retrieval_calls: [
          {
            tool_name: 'search_product_knowledge',
            call_id: 'call-1',
            retrieval_strategy: 'hybrid',
            chunks: [
              { document_id: 'doc-a', chunk_id: CHUNK_A, similarity: 0.4, rerank_score: null, rerank_rank: null },
            ],
          },
          {
            tool_name: 'search_product_knowledge',
            call_id: 'call-2',
            retrieval_strategy: 'hybrid',
            chunks: [
              { document_id: 'doc-a', chunk_id: CHUNK_A, similarity: 0.6, rerank_score: null, rerank_rank: null },
            ],
          },
        ],
      }),
      CONTEXT,
    );

    expect(episode.calls?.[0]?.candidates[0]?.text).toBe('chunk a text');
    expect(episode.calls?.[1]?.candidates[0]?.text).toBe('chunk a text');
  });
});

describe('toRetrievalEpisodes', () => {
  it('preserves record order', () => {
    const episodes = toRetrievalEpisodes(
      [
        record({ test_result_item_id: 'a', row_index: 0 }),
        record({ test_result_item_id: 'b', row_index: 1 }),
      ],
      CONTEXT,
    );

    expect(episodes.map((e) => e.episodeId)).toEqual(['a', 'b']);
  });
});

describe('classifyUnmatchedChunk', () => {
  it('maps id shape to the resolution resolveContext would have produced', () => {
    expect(classifyUnmatchedChunk(null)).toBe('no_chunk_id');
    expect(classifyUnmatchedChunk('verified-facts')).toBe('synthetic');
    expect(classifyUnmatchedChunk(CHUNK_GONE)).toBe('missing');
  });
});

describe('indexContexts', () => {
  it('indexes by chunk id and keeps the first context per document for metadata fallback', () => {
    const index = indexContexts([
      resolvedContext({ chunk_id: CHUNK_A, document_title: 'first' }),
      resolvedContext({ chunk_id: CHUNK_B, document_title: 'second' }),
    ]);

    expect(index.byChunkId.get(CHUNK_A)?.document_title).toBe('first');
    expect(index.byChunkId.get(CHUNK_B)?.document_title).toBe('second');
    expect(index.byDocumentId.get('doc-a')?.document_title).toBe('first');
  });
});
