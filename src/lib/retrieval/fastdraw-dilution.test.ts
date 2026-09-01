import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import { fetchFastDrawDilution } from '~/lib/retrieval/fastdraw-dilution';

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

type QueryResult = { data: unknown[] | null; error: { message: string } | null };

/** A minimal chainable + thenable stand-in for a supabase-js query builder. */
function chainable(result: QueryResult) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    then: (
      onFulfilled: (value: QueryResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

/**
 * `rag.entity` is queried once per truthy key (product tier first, then product_line tier — see
 * `resolveFastDrawEntityIds`); `entityCalls` supplies one result per expected call, in that order.
 */
function stubSupabase(config: {
  entityCalls: QueryResult[];
  document?: QueryResult;
  documentChunk?: QueryResult;
}) {
  let entityCallIndex = 0;
  const from = (table: string) => {
    if (table === 'entity') {
      const result = config.entityCalls[entityCallIndex] ?? { data: [], error: null };
      entityCallIndex += 1;
      return chainable(result);
    }
    if (table === 'document') {
      return chainable(config.document ?? { data: [], error: null });
    }
    if (table === 'document_chunk') {
      return chainable(config.documentChunk ?? { data: [], error: null });
    }
    throw new Error(`unexpected table in test stub: ${table}`);
  };

  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    schema: () => ({ from }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
}

const VALID_METADATA = {
  dilution: '1:256',
  spray_dilution: '1:128',
  gallon_yield_per_2_liter: 66.5,
  gallon_yield_per_2_liter_spray: 33.25,
  context: 'fastdraw_dispenser',
  source: 'FastDraw dilution/yield workbook',
  conflicts_with_legacy_dilution_code: true,
  has_dilution_info: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchFastDrawDilution (B0-636)', () => {
  it('returns null with no productLineKey/productKey (no entity to anchor on)', async () => {
    const result = await fetchFastDrawDilution(null, null);
    expect(result).toBeNull();
    expect(getSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it('returns null when the entity resolves but has no documents', async () => {
    stubSupabase({
      entityCalls: [{ data: [{ id: 'entity-product-1' }], error: null }],
      document: { data: [], error: null },
    });
    const result = await fetchFastDrawDilution(null, 'PK-1');
    expect(result).toBeNull();
  });

  it('returns null when documents exist but none has a dilution-section chunk', async () => {
    stubSupabase({
      entityCalls: [{ data: [{ id: 'entity-product-1' }], error: null }],
      document: { data: [{ id: 'doc-1', entity_id: 'entity-product-1', title: 'pH7Q Label' }], error: null },
      documentChunk: { data: [], error: null },
    });
    const result = await fetchFastDrawDilution(null, 'PK-1');
    expect(result).toBeNull();
  });

  it('maps a valid chunk to camelCase fields and carries the real document/chunk ids for citation', async () => {
    stubSupabase({
      entityCalls: [{ data: [{ id: 'entity-product-1' }], error: null }],
      document: { data: [{ id: 'doc-1', entity_id: 'entity-product-1', title: 'pH7Q FastDraw Sheet' }], error: null },
      documentChunk: {
        data: [
          {
            id: 'chunk-1',
            document_id: 'doc-1',
            chunk_text: 'FastDraw dilution: 1:256, spray 1:128.',
            metadata: VALID_METADATA,
          },
        ],
        error: null,
      },
    });

    const result = await fetchFastDrawDilution(null, 'PK-1');

    expect(result).toEqual({
      fastDrawDilution: {
        dilution: '1:256',
        sprayDilution: '1:128',
        gallonYieldPer2Liter: 66.5,
        gallonYieldPer2LiterSpray: 33.25,
        conflictsWithLegacyDilutionCode: true,
      },
      documentId: 'doc-1',
      chunkId: 'chunk-1',
      title: 'pH7Q FastDraw Sheet',
      documentBody: 'FastDraw dilution: 1:256, spray 1:128.',
    });
  });

  it('degrades to null (never fabricates) when a dilution-section chunk has malformed metadata', async () => {
    stubSupabase({
      entityCalls: [{ data: [{ id: 'entity-product-1' }], error: null }],
      document: { data: [{ id: 'doc-1', entity_id: 'entity-product-1', title: 'pH7Q Label' }], error: null },
      documentChunk: {
        data: [
          {
            id: 'chunk-1',
            document_id: 'doc-1',
            chunk_text: 'some other dilution section',
            // Missing required numeric yield fields — not FastDraw ingestion's shape.
            metadata: { dilution: '1:256', context: 'fastdraw_dispenser' },
          },
        ],
        error: null,
      },
    });

    const result = await fetchFastDrawDilution(null, 'PK-1');
    expect(result).toBeNull();
  });

  it('ignores a dilution chunk whose metadata.context is not fastdraw_dispenser', async () => {
    stubSupabase({
      entityCalls: [{ data: [{ id: 'entity-product-1' }], error: null }],
      document: { data: [{ id: 'doc-1', entity_id: 'entity-product-1', title: 'pH7Q Label' }], error: null },
      documentChunk: {
        data: [
          {
            id: 'chunk-1',
            document_id: 'doc-1',
            chunk_text: 'general-use dilution section',
            metadata: { ...VALID_METADATA, context: 'general_use' },
          },
        ],
        error: null,
      },
    });

    const result = await fetchFastDrawDilution(null, 'PK-1');
    expect(result).toBeNull();
  });

  it('prefers the product-tier entity chunk over the product_line-tier one when both exist', async () => {
    stubSupabase({
      // Product-tier call first, then product_line-tier call (resolveFastDrawEntityIds order).
      entityCalls: [
        { data: [{ id: 'entity-product-1' }], error: null },
        { data: [{ id: 'entity-line-1' }], error: null },
      ],
      document: {
        data: [
          { id: 'doc-line', entity_id: 'entity-line-1', title: 'Line-level FastDraw Sheet' },
          { id: 'doc-product', entity_id: 'entity-product-1', title: 'SKU-specific FastDraw Sheet' },
        ],
        error: null,
      },
      documentChunk: {
        data: [
          {
            id: 'chunk-line',
            document_id: 'doc-line',
            chunk_text: 'line-level fastdraw dilution',
            metadata: { ...VALID_METADATA, dilution: '1:128' },
          },
          {
            id: 'chunk-product',
            document_id: 'doc-product',
            chunk_text: 'sku-specific fastdraw dilution',
            metadata: { ...VALID_METADATA, dilution: '1:256' },
          },
        ],
        error: null,
      },
    });

    const result = await fetchFastDrawDilution('PL-1', 'PK-1');
    expect(result?.documentId).toBe('doc-product');
    expect(result?.fastDrawDilution.dilution).toBe('1:256');
  });
});
