import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import {
  assembleChunkIndexSetBody,
  assembleNeighborChunkBodies,
  chunkWindowKey,
  NEIGHBOR_CHUNK_RADIUS,
} from '~/lib/retrieval/document-assembly';

/**
 * B0-547 — `assembleNeighborChunkBodies` replaces whole-document assembly for the product-support
 * retrieval tools: it should fetch only the matched chunk plus its immediate neighbors, not every
 * chunk belonging to the document.
 */

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

type ChunkRow = {
  id: string;
  document_id: string;
  chunk_index: number;
  heading: string | null;
  chunk_text: string;
  token_count: number | null;
};

function row(overrides: Partial<ChunkRow> & Pick<ChunkRow, 'id' | 'document_id' | 'chunk_index'>): ChunkRow {
  return {
    heading: null,
    chunk_text: `text for ${overrides.id}`,
    token_count: 10,
    ...overrides,
  };
}

/** Mocks the `.schema('rag').from('document_chunk').select().or().order().order()` chain. */
function mockChunkQuery(rows: ChunkRow[], error: { message: string } | null = null) {
  const orSpy = vi.fn();
  const builder: {
    or: (filter: string) => typeof builder;
    order: () => typeof builder;
    then: (resolve: (value: { data: ChunkRow[] | null; error: typeof error }) => unknown) => unknown;
  } = {
    or: (filter: string) => {
      orSpy(filter);
      return builder;
    },
    order: () => builder,
    then: (resolve) => resolve({ data: error ? null : rows, error }),
  };
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    schema: () => ({
      from: () => ({
        select: () => builder,
      }),
    }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
  return orSpy;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('chunkWindowKey', () => {
  it('is documentId:chunkIndex, so two matches in the same document never collide', () => {
    expect(chunkWindowKey({ documentId: 'doc-1', chunkIndex: 3 })).toBe('doc-1:3');
    expect(chunkWindowKey({ documentId: 'doc-1', chunkIndex: 3 })).not.toBe(
      chunkWindowKey({ documentId: 'doc-1', chunkIndex: 7 }),
    );
  });
});

describe('assembleNeighborChunkBodies (B0-547)', () => {
  it('returns an empty map without querying when given no requests', async () => {
    const result = await assembleNeighborChunkBodies([]);
    expect(result.size).toBe(0);
    expect(getSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it('windows to the matched chunk plus its immediate neighbors, excluding chunks further out', async () => {
    // Document has 5 chunks (index 0-4); the match is chunk_index 2. Only 1,2,3 should end up in
    // the assembled body even though the mocked query response (deliberately) returns every chunk
    // in the document, simulating an over-broad `.or()` result the app-layer window must still trim.
    const rows = [0, 1, 2, 3, 4].map((i) =>
      row({ id: `c${i}`, document_id: 'doc-1', chunk_index: i, chunk_text: `chunk ${i} text` }),
    );
    const orSpy = mockChunkQuery(rows);

    const result = await assembleNeighborChunkBodies([{ documentId: 'doc-1', chunkIndex: 2 }]);

    expect(NEIGHBOR_CHUNK_RADIUS).toBe(1);
    const body = result.get(chunkWindowKey({ documentId: 'doc-1', chunkIndex: 2 }));
    expect(body).toBeDefined();
    expect(body!.chunkIds).toEqual(['c1', 'c2', 'c3']);
    expect(body!.body).toBe('chunk 1 text\n\nchunk 2 text\n\nchunk 3 text');
    expect(body!.chunkCount).toBe(3);

    // The or-filter targets exactly this document/index range, not the whole document.
    expect(orSpy).toHaveBeenCalledWith(
      'and(document_id.eq.doc-1,chunk_index.gte.1,chunk_index.lte.3)',
    );
  });

  it('clamps the low end of the window at 0 for a match on the first chunk', async () => {
    const rows = [0, 1].map((i) => row({ id: `c${i}`, document_id: 'doc-1', chunk_index: i }));
    const orSpy = mockChunkQuery(rows);

    await assembleNeighborChunkBodies([{ documentId: 'doc-1', chunkIndex: 0 }]);

    expect(orSpy).toHaveBeenCalledWith(
      'and(document_id.eq.doc-1,chunk_index.gte.0,chunk_index.lte.1)',
    );
  });

  it('gives each distinct matched chunk in the same document its own window/key', async () => {
    const rows = [0, 1, 2, 3, 4].map((i) =>
      row({ id: `c${i}`, document_id: 'doc-1', chunk_index: i }),
    );
    mockChunkQuery(rows);

    const result = await assembleNeighborChunkBodies([
      { documentId: 'doc-1', chunkIndex: 0 },
      { documentId: 'doc-1', chunkIndex: 4 },
    ]);

    expect(result.get('doc-1:0')?.chunkIds).toEqual(['c0', 'c1']);
    expect(result.get('doc-1:4')?.chunkIds).toEqual(['c3', 'c4']);
  });

  it('deduplicates identical (documentId, chunkIndex) requests into a single window/query term', async () => {
    const rows = [row({ id: 'c0', document_id: 'doc-1', chunk_index: 0 })];
    const orSpy = mockChunkQuery(rows);

    const result = await assembleNeighborChunkBodies([
      { documentId: 'doc-1', chunkIndex: 0 },
      { documentId: 'doc-1', chunkIndex: 0 },
    ]);

    expect(result.size).toBe(1);
    expect(orSpy).toHaveBeenCalledTimes(1);
    const filterArg = orSpy.mock.calls[0]?.[0] as string;
    expect(filterArg.split(',and(')).toHaveLength(1);
  });

  it('respects a custom radius', async () => {
    const rows = [0, 1, 2, 3, 4].map((i) =>
      row({ id: `c${i}`, document_id: 'doc-1', chunk_index: i }),
    );
    mockChunkQuery(rows);

    const result = await assembleNeighborChunkBodies(
      [{ documentId: 'doc-1', chunkIndex: 2 }],
      { radius: 2 },
    );

    expect(result.get('doc-1:2')?.chunkIds).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });

  it('throws when the query errors, rather than silently returning an empty window', async () => {
    mockChunkQuery([], { message: 'boom' });

    await expect(
      assembleNeighborChunkBodies([{ documentId: 'doc-1', chunkIndex: 0 }]),
    ).rejects.toThrow(/boom/);
  });

  it('drops requests with an empty documentId', async () => {
    mockChunkQuery([]);
    const result = await assembleNeighborChunkBodies([{ documentId: '', chunkIndex: 0 }]);
    expect(result.size).toBe(0);
  });
});

/** Mocks the `.schema('rag').from('document_chunk').select().eq().in().order()` chain. */
function mockIndexSetQuery(rows: ChunkRow[], error: { message: string } | null = null) {
  const eqSpy = vi.fn();
  const inSpy = vi.fn();
  // Simulate the DB honouring the IN filter, so the test proves the requested set is right.
  let requestedIndexes: number[] | null = null;
  const builder: {
    eq: (column: string, value: string) => typeof builder;
    in: (column: string, values: number[]) => typeof builder;
    order: () => typeof builder;
    then: (resolve: (value: { data: ChunkRow[] | null; error: typeof error }) => unknown) => unknown;
  } = {
    eq: (column, value) => {
      eqSpy(column, value);
      return builder;
    },
    in: (column, values) => {
      inSpy(column, values);
      requestedIndexes = values;
      return builder;
    },
    order: () => builder,
    then: (resolve) =>
      resolve({
        data: error
          ? null
          : rows.filter((r) => requestedIndexes === null || requestedIndexes.includes(r.chunk_index)),
        error,
      }),
  };
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    schema: () => ({
      from: () => ({
        select: () => builder,
      }),
    }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
  return { eqSpy, inSpy };
}

/**
 * B0-874 — one body for one document, seeded by several chunk indexes (the pooled siblings of the
 * top knowledge hit) and padded by a radius around each.
 */
describe('assembleChunkIndexSetBody (B0-874)', () => {
  const docRows = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) =>
    row({ id: `c${i}`, document_id: 'doc-1', chunk_index: i, chunk_text: `chunk ${i}` }),
  );

  it('unions the radius window around every seed, clamped at 0, in chunk order', async () => {
    const { eqSpy, inSpy } = mockIndexSetQuery(docRows);

    const body = await assembleChunkIndexSetBody(
      { documentId: 'doc-1', chunkIndexes: [10, 1] },
      { radius: 2 },
    );

    expect(eqSpy).toHaveBeenCalledWith('document_id', 'doc-1');
    expect(inSpy).toHaveBeenCalledWith('chunk_index', [0, 1, 2, 3, 8, 9, 10, 11, 12]);
    expect(body.chunkIds).toEqual(['c0', 'c1', 'c2', 'c3', 'c8', 'c9', 'c10', 'c11', 'c12']);
    expect(body.chunkCount).toBe(9);
    expect(body.body.startsWith('chunk 0\n\nchunk 1')).toBe(true);
  });

  it('defaults to NEIGHBOR_CHUNK_RADIUS and deduplicates overlapping seeds', async () => {
    const { inSpy } = mockIndexSetQuery(docRows);

    const body = await assembleChunkIndexSetBody({ documentId: 'doc-1', chunkIndexes: [4, 5, 5] });

    expect(NEIGHBOR_CHUNK_RADIUS).toBe(1);
    expect(inSpy).toHaveBeenCalledWith('chunk_index', [3, 4, 5, 6]);
    expect(body.chunkIds).toEqual(['c3', 'c4', 'c5', 'c6']);
  });

  it('returns an empty body without querying for an empty seed set or documentId', async () => {
    mockIndexSetQuery(docRows);

    const noSeeds = await assembleChunkIndexSetBody({ documentId: 'doc-1', chunkIndexes: [] });
    const noDoc = await assembleChunkIndexSetBody({ documentId: '', chunkIndexes: [1] });

    expect(noSeeds.chunkCount).toBe(0);
    expect(noDoc.chunkCount).toBe(0);
    expect(getSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it('honours the char cap and reports truncation', async () => {
    mockIndexSetQuery(docRows);

    const body = await assembleChunkIndexSetBody(
      { documentId: 'doc-1', chunkIndexes: [5] },
      { radius: 2, maxChars: 20 },
    );

    expect(body.truncated).toBe(true);
    expect(body.body.length).toBeLessThanOrEqual(20);
    expect(body.chunkIds.length).toBeLessThan(5);
  });

  it('throws when the query errors, rather than silently returning an empty body', async () => {
    mockIndexSetQuery([], { message: 'boom' });

    await expect(
      assembleChunkIndexSetBody({ documentId: 'doc-1', chunkIndexes: [1] }),
    ).rejects.toThrow(/boom/);
  });
});
