import { describe, expect, it, vi } from 'vitest';

/**
 * B0-655 — `insertTestItems` chunks inserts at 500 rows. A bad row anywhere in a chunk aborts the
 * whole insert for that chunk (Postgrest surfaces one opaque error), so previously there was no way
 * to tell which rows caused it. This tests that a chunk failure now throws an error naming the
 * row_index span of the failing chunk. Cleaning up any rows already inserted from earlier chunks is
 * NOT this function's job — that's `runCreatedRecordOrCleanup` (see upload-cleanup.test.ts), which
 * deletes the parent `tests` row and cascades away any partial `test_items`.
 */

type InsertResult = { data: unknown; error: { message: string } | null };

let insertResponses: InsertResult[] = [];
let insertCallCount = 0;

function makeRow(rowIndex: number) {
  return { row_index: rowIndex, test_id: 'test-1', prompt: `prompt ${rowIndex}` };
}

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => ({
    from: () => ({
      insert: () => ({
        select: async () => {
          const response = insertResponses[insertCallCount] ?? { data: [], error: null };
          insertCallCount += 1;
          return response;
        },
      }),
    }),
  }),
}));

import { insertTestItems } from '~/lib/tests/repository';

describe('insertTestItems (B0-655)', () => {
  it('inserts a single chunk and returns the inserted rows', async () => {
    insertCallCount = 0;
    const items = [makeRow(1), makeRow(2), makeRow(3)];
    insertResponses = [{ data: items.map((r) => ({ id: `id-${r.row_index}`, ...r })), error: null }];

    const result = await insertTestItems(items as never);
    expect(result).toHaveLength(3);
  });

  it('throws an error naming the row_index span of the failing chunk, on a second-chunk failure', async () => {
    insertCallCount = 0;
    // 500 rows in chunk 1 (row_index 1-500), 3 rows in chunk 2 (row_index 501-503) that fails.
    const chunk1 = Array.from({ length: 500 }, (_, i) => makeRow(i + 1));
    const chunk2 = [makeRow(501), makeRow(502), makeRow(503)];
    const items = [...chunk1, ...chunk2];

    insertResponses = [
      { data: chunk1.map((r) => ({ id: `id-${r.row_index}`, ...r })), error: null },
      { data: null, error: { message: 'duplicate key value violates unique constraint' } },
    ];

    await expect(insertTestItems(items as never)).rejects.toThrow(
      /row_index 501-503.*duplicate key value violates unique constraint/,
    );
  });

  it('returns an empty array without querying Supabase when given no items', async () => {
    insertCallCount = 0;
    insertResponses = [];
    const result = await insertTestItems([]);
    expect(result).toEqual([]);
    expect(insertCallCount).toBe(0);
  });
});
