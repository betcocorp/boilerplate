import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-1048 — coverage for the ingestion-time index-table alias capture path, mocked at the
 * `resolveProductEntityByName` and `getSupabaseServiceRoleClient()` boundaries (same pattern as
 * `~/lib/rag/product-alias-review-repository.test.ts`).
 */

vi.mock('~/lib/rag/entity-context', () => ({ resolveProductEntityByName: vi.fn() }));
vi.mock('~/supabase/clients/service-role', () => ({ getSupabaseServiceRoleClient: vi.fn() }));

import { resolveProductEntityByName } from '~/lib/rag/entity-context';
import { captureIndexTableAliasCandidates } from '~/lib/rag/index-table-alias-capture';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

const mockResolve = vi.mocked(resolveProductEntityByName);
const mockGetClient = vi.mocked(getSupabaseServiceRoleClient);

type LooseRow = Record<string, unknown>;

let existingRows: LooseRow[] = [];
let insertedRows: LooseRow[] = [];
let upsertedRows: LooseRow[] = [];

function makeSupabaseMock() {
  return {
    schema() {
      return {
        from() {
          return {
            select() {
              return {
                in(_col: string, values: string[]) {
                  return Promise.resolve({
                    data: existingRows.filter((r) => values.includes(String(r.alias_norm))),
                    error: null,
                  });
                },
              };
            },
            insert(rows: LooseRow[]) {
              insertedRows.push(...rows);
              return Promise.resolve({ error: null });
            },
            upsert(rows: LooseRow[]) {
              upsertedRows.push(...rows);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

beforeEach(() => {
  existingRows = [];
  insertedRows = [];
  upsertedRows = [];
  mockResolve.mockReset();
  mockGetClient.mockReturnValue(makeSupabaseMock() as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
});

describe('captureIndexTableAliasCandidates (B0-1048)', () => {
  it('inserts a new unverified candidate row for an entry that resolves', async () => {
    mockResolve.mockResolvedValue({ productLineKey: 'PL-1', productKey: null });

    const result = await captureIndexTableAliasCandidates([
      { name: 'Kling', description: 'Toilet bowl cleaner' },
    ]);

    expect(result).toEqual({ captured: 1, unresolved: 0, skippedProtected: 0 });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      alias: 'Kling',
      alias_norm: 'kling',
      product_line_key: 'PL-1',
      source: 'index_table_ingest',
      verified: false,
    });
  });

  it('drops an entry that does not resolve to a known product/product-line (never fabricates a key)', async () => {
    mockResolve.mockResolvedValue({ productLineKey: null, productKey: null });

    const result = await captureIndexTableAliasCandidates([
      { name: 'Some Unknown Thing', description: null },
    ]);

    expect(result).toEqual({ captured: 0, unresolved: 1, skippedProtected: 0 });
    expect(insertedRows).toHaveLength(0);
  });

  it('does not overwrite a row a human has verified', async () => {
    mockResolve.mockResolvedValue({ productLineKey: 'PL-1', productKey: null });
    existingRows = [
      { alias_norm: 'kling', product_line_key: 'PL-1', source: 'index_table_ingest', verified: true },
    ];

    const result = await captureIndexTableAliasCandidates([
      { name: 'Kling', description: 'Toilet bowl cleaner' },
    ]);

    expect(result).toEqual({ captured: 0, unresolved: 0, skippedProtected: 1 });
    expect(insertedRows).toHaveLength(0);
    expect(upsertedRows).toHaveLength(0);
  });

  it('does not overwrite a row owned by a different source', async () => {
    mockResolve.mockResolvedValue({ productLineKey: 'PL-1', productKey: null });
    existingRows = [
      {
        alias_norm: 'kling',
        product_line_key: 'PL-1',
        source: 'corpus_scan_noun_phrase',
        verified: false,
      },
    ];

    const result = await captureIndexTableAliasCandidates([
      { name: 'Kling', description: 'Toilet bowl cleaner' },
    ]);

    expect(result).toEqual({ captured: 0, unresolved: 0, skippedProtected: 1 });
    expect(insertedRows).toHaveLength(0);
    expect(upsertedRows).toHaveLength(0);
  });

  it('updates its own prior unverified row on re-ingest', async () => {
    mockResolve.mockResolvedValue({ productLineKey: 'PL-1', productKey: null });
    existingRows = [
      { alias_norm: 'kling', product_line_key: 'PL-1', source: 'index_table_ingest', verified: false },
    ];

    const result = await captureIndexTableAliasCandidates([
      { name: 'Kling', description: 'Toilet bowl cleaner' },
    ]);

    expect(result).toEqual({ captured: 1, unresolved: 0, skippedProtected: 0 });
    expect(upsertedRows).toHaveLength(1);
    expect(insertedRows).toHaveLength(0);
  });

  it('dedupes repeated names in the same table before resolving', async () => {
    mockResolve.mockResolvedValue({ productLineKey: 'PL-1', productKey: null });

    await captureIndexTableAliasCandidates([
      { name: 'Kling', description: 'A' },
      { name: 'Kling', description: 'B (duplicate row in the index table)' },
    ]);

    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for an empty entry list', async () => {
    const result = await captureIndexTableAliasCandidates([]);
    expect(result).toEqual({ captured: 0, unresolved: 0, skippedProtected: 0 });
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
