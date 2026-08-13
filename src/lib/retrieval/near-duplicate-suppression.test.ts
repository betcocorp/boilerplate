import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RagSearchMatch } from '~/lib/rag/search';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import { suppressNearDuplicateMatches } from './near-duplicate-suppression';

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

type SimilarityRow = { chunk_id_a: string; chunk_id_b: string; cosine_similarity: number };

function mockSimilarityRpc(rows: SimilarityRow[] | null, error: { message: string } | null = null) {
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    schema: () => ({
      rpc: vi.fn().mockResolvedValue({ data: rows, error }),
    }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
}

let idCounter = 0;
function match(overrides: Partial<RagSearchMatch>): RagSearchMatch {
  idCounter += 1;
  return {
    chunk_id: `chunk-${idCounter}`,
    chunk_key: `key-${idCounter}`,
    chunk_index: 0,
    heading: null,
    chunk_text: 'text',
    section_path: null,
    section_type: 'hazards',
    token_count: 10,
    document_id: `doc-${idCounter}`,
    document_key: `dockey-${idCounter}`,
    document_title: `Document ${idCounter}`,
    entity_id: 'entity-1',
    product_key: null,
    sku: null,
    product_line_key: null,
    source_pk: `pk-${idCounter}`,
    document_kind: 'product_line_profile',
    similarity: 0.5,
    ...overrides,
  };
}

beforeEach(() => {
  idCounter = 0;
  vi.clearAllMocks();
});

describe('suppressNearDuplicateMatches', () => {
  it('returns matches unchanged when fewer than 2 are given', async () => {
    const matches = [match({})];
    const result = await suppressNearDuplicateMatches(matches);
    expect(result).toEqual(matches);
    expect(getSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it('does not suppress matches from different (product, section_type) groups', async () => {
    const a = match({ entity_id: 'entity-1', section_type: 'hazards' });
    const b = match({ entity_id: 'entity-2', section_type: 'hazards' });
    mockSimilarityRpc([]);
    const result = await suppressNearDuplicateMatches([a, b]);
    expect(result).toEqual([a, b]);
  });

  it('never groups (and never suppresses) matches with no resolvable product identifier', async () => {
    const a = match({ entity_id: null, product_key: null, product_line_key: null });
    const b = match({ entity_id: null, product_key: null, product_line_key: null });
    const result = await suppressNearDuplicateMatches([a, b]);
    expect(result).toEqual([a, b]);
    expect(getSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it('keeps the highest-authority match (sds over product_line_profile) when near-duplicate', async () => {
    const sdsMatch = match({
      chunk_id: 'sds-chunk',
      document_kind: 'sds',
      entity_id: 'entity-1',
      section_type: 'hazards',
      similarity: 0.6,
    });
    const productMatch = match({
      chunk_id: 'product-chunk',
      document_kind: 'product_line_profile',
      entity_id: 'entity-1',
      section_type: 'hazards',
      similarity: 0.9,
    });
    mockSimilarityRpc([
      { chunk_id_a: 'product-chunk', chunk_id_b: 'sds-chunk', cosine_similarity: 0.97 },
    ]);

    const result = await suppressNearDuplicateMatches([productMatch, sdsMatch]);
    expect(result).toHaveLength(1);
    expect(result[0].chunk_id).toBe('sds-chunk');
  });

  it('keeps label over a generic product/knowledge chunk when near-duplicate', async () => {
    const labelMatch = match({ chunk_id: 'label-chunk', document_kind: 'label', section_type: 'first_aid' });
    const knowledgeMatch = match({ chunk_id: 'knowledge-chunk', document_kind: 'knowledge', section_type: 'first_aid' });
    mockSimilarityRpc([
      { chunk_id_a: 'knowledge-chunk', chunk_id_b: 'label-chunk', cosine_similarity: 0.95 },
    ]);

    const result = await suppressNearDuplicateMatches([knowledgeMatch, labelMatch]);
    expect(result.map((m) => m.chunk_id)).toEqual(['label-chunk']);
  });

  it('keeps both matches when similarity is below the threshold', async () => {
    const a = match({ chunk_id: 'a', document_kind: 'sds', section_type: 'hazards' });
    const b = match({ chunk_id: 'b', document_kind: 'product_line_profile', section_type: 'hazards' });
    mockSimilarityRpc([{ chunk_id_a: 'a', chunk_id_b: 'b', cosine_similarity: 0.5 }]);

    const result = await suppressNearDuplicateMatches([a, b]);
    expect(result).toHaveLength(2);
  });

  it('breaks ties by similarity-to-query when authority rank is equal', async () => {
    const higherRelevance = match({
      chunk_id: 'higher',
      document_kind: 'product_line_profile',
      similarity: 0.9,
    });
    const lowerRelevance = match({
      chunk_id: 'lower',
      document_kind: 'product_line_profile',
      similarity: 0.4,
    });
    mockSimilarityRpc([{ chunk_id_a: 'higher', chunk_id_b: 'lower', cosine_similarity: 0.99 }]);

    const result = await suppressNearDuplicateMatches([lowerRelevance, higherRelevance]);
    expect(result.map((m) => m.chunk_id)).toEqual(['higher']);
  });

  it('degrades to a no-op when the similarity RPC errors', async () => {
    const a = match({ chunk_id: 'a' });
    const b = match({ chunk_id: 'b' });
    mockSimilarityRpc(null, { message: 'boom' });

    const result = await suppressNearDuplicateMatches([a, b]);
    expect(result).toEqual([a, b]);
  });

  it('preserves original relative order of surviving matches', async () => {
    const a = match({ chunk_id: 'a', entity_id: 'e1', section_type: 's1' });
    const b = match({ chunk_id: 'b', entity_id: 'e2', section_type: 's2' });
    const c = match({ chunk_id: 'c', entity_id: 'e3', section_type: 's3' });
    mockSimilarityRpc([]);

    const result = await suppressNearDuplicateMatches([a, b, c]);
    expect(result.map((m) => m.chunk_id)).toEqual(['a', 'b', 'c']);
  });
});
