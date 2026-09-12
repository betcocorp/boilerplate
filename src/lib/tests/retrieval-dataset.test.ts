import { describe, expect, it } from 'vitest';

import { resolveContext, summarizeCoverage } from '~/lib/tests/retrieval-dataset';
import { extractRetrievalCalls } from '~/lib/tests/response-payload';

const CHUNK_A = '11111111-2222-3333-4444-555555555555';
const CHUNK_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function chunkRow(id: string, text: string) {
  return { id, document_id: 'doc-1', chunk_text: text, heading: 'Directions', chunk_index: 3 };
}

describe('resolveContext', () => {
  it('resolves a live chunk to its text', () => {
    const rows = new Map([[CHUNK_A, chunkRow(CHUNK_A, 'Dilute 1:64 for daily cleaning.')]]);
    const resolved = resolveContext(
      { document_id: 'doc-1', chunk_id: CHUNK_A, document_title: 'Label' },
      rows,
    );

    expect(resolved.resolution).toBe('resolved');
    expect(resolved.text).toBe('Dilute 1:64 for daily cleaning.');
    expect(resolved.heading).toBe('Directions');
    expect(resolved.chunk_index).toBe(3);
  });

  it('marks a uuid chunk that no longer exists as missing, not synthetic', () => {
    const resolved = resolveContext({ document_id: 'doc-1', chunk_id: CHUNK_B }, new Map());

    // A re-ingested corpus and a verified-facts block are different failures with different
    // responses (discard the run vs. ignore the row), so they must never collapse into one bucket.
    expect(resolved.resolution).toBe('missing');
    expect(resolved.text).toBeNull();
  });

  it('marks a non-uuid source id as synthetic', () => {
    const resolved = resolveContext(
      { document_id: 'verified-facts', chunk_id: 'verified-facts:fastdraw' },
      new Map(),
    );

    expect(resolved.resolution).toBe('synthetic');
  });

  it('marks a reference with no chunk id', () => {
    const resolved = resolveContext({ document_id: 'doc-1', chunk_id: null }, new Map());

    expect(resolved.resolution).toBe('no_chunk_id');
  });
});

describe('summarizeCoverage', () => {
  it('excludes synthetic refs from the resolved share denominator', () => {
    const rows = new Map([[CHUNK_A, chunkRow(CHUNK_A, 'text')]]);
    const contexts = [
      resolveContext({ document_id: 'd', chunk_id: CHUNK_A }, rows),
      resolveContext({ document_id: 'd', chunk_id: CHUNK_B }, rows),
      resolveContext({ document_id: 'verified-facts', chunk_id: 'verified-facts' }, rows),
    ];

    const coverage = summarizeCoverage(contexts);

    expect(coverage.requested).toBe(3);
    expect(coverage.resolved).toBe(1);
    expect(coverage.missing).toBe(1);
    expect(coverage.synthetic).toBe(1);
    // 1 resolved of 2 joinable — the synthetic ref could never have had a chunk row, so counting it
    // against the join would understate coverage and trigger the staleness warning on a healthy run.
    expect(coverage.resolvedShare).toBe(0.5);
  });

  it('reports a null share when nothing was joinable', () => {
    const contexts = [
      resolveContext({ document_id: 'verified-facts', chunk_id: 'verified-facts' }, new Map()),
    ];

    expect(summarizeCoverage(contexts).resolvedShare).toBeNull();
  });
});

describe('extractRetrievalCalls', () => {
  it('returns null for a payload written before the field existed', () => {
    expect(extractRetrievalCalls({ answerText: 'hi', sources: [] })).toBeNull();
  });

  it('distinguishes an empty array from an absent field', () => {
    // `[]` = this turn ran no retrieval. `null` = we cannot know. A rank metric that reads the
    // second as the first scores every historical run as retrieving nothing.
    expect(extractRetrievalCalls({ retrieval_calls: [] })).toEqual([]);
    expect(extractRetrievalCalls({})).toBeNull();
  });

  it('parses ordered per-call records with rerank positions', () => {
    const calls = extractRetrievalCalls({
      retrieval_calls: [
        {
          tool_name: 'search_product_docs',
          call_id: 'call-1',
          retrieval_strategy: 'hybrid+reranked',
          chunks: [
            { document_id: 'd1', chunk_id: CHUNK_A, similarity: 0.41, rerank_score: 0.98, rerank_rank: 0 },
            { document_id: 'd2', chunk_id: CHUNK_B, similarity: 0.63, rerank_score: 0.12, rerank_rank: 7 },
          ],
        },
      ],
    });

    expect(calls).toHaveLength(1);
    // The chunk with the HIGHER cosine similarity is ranked worse by the cross-encoder — exactly the
    // disagreement that is invisible without this field, since the persisted order is cosine order.
    expect(calls?.[0]?.chunks.map((c) => c.rerank_rank)).toEqual([0, 7]);
    expect(calls?.[0]?.chunks.map((c) => c.similarity)).toEqual([0.41, 0.63]);
  });

  it('returns null rather than throwing on a malformed field', () => {
    expect(extractRetrievalCalls({ retrieval_calls: [{ tool_name: 42 }] })).toBeNull();
  });
});
