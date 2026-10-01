import { beforeEach, describe, expect, it, vi } from 'vitest';

import { searchBetcoProducts } from '~/lib/recommendations/product-picker';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-441 — regression coverage for the product picker's server-backed search: `rag.entity`
 * (entity_type='product') only, matches on title OR sku, merges/dedupes, and never returns
 * results for an empty query (the picker should read "type to search", not a default list).
 */

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

type Row = { product_key: string; sku: string | null; title: string };

/** Mocks the `.schema('rag').from('entity').select().eq('entity_type','product').ilike(col, pattern)…`
 * chain. Rows are keyed by which column (`title` | `sku`) the ilike call targets. */
function mockEntitySearch(byColumn: { title?: Row[]; sku?: Row[] }) {
  const eqApi = {
    ilike: (column: 'title' | 'sku') => {
      const rows = byColumn[column] ?? [];
      const orderApi = {
        limit: () => Promise.resolve({ data: rows, error: null }),
      };
      return { order: () => orderApi };
    },
  };
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    schema: () => ({
      from: () => ({
        select: () => ({ eq: () => eqApi }),
      }),
    }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('searchBetcoProducts (B0-441)', () => {
  it('returns [] for an empty/whitespace query without querying the database', async () => {
    const result = await searchBetcoProducts('   ');
    expect(result).toEqual([]);
    expect(getSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it('merges title and sku matches, deduping by product key', async () => {
    mockEntitySearch({
      title: [{ product_key: 'PK1', sku: 'SKU1', title: 'Green Earth Peroxide Cleaner' }],
      sku: [
        { product_key: 'PK1', sku: 'SKU1', title: 'Green Earth Peroxide Cleaner' }, // dup of title hit
        { product_key: 'PK2', sku: 'GEP-2', title: 'Another Product' },
      ],
    });

    const result = await searchBetcoProducts('green');
    expect(result).toEqual([
      { productKey: 'PK1', sku: 'SKU1', title: 'Green Earth Peroxide Cleaner' },
      { productKey: 'PK2', sku: 'GEP-2', title: 'Another Product' },
    ]);
  });

  it('drops rows missing a product key or title', async () => {
    mockEntitySearch({
      title: [{ product_key: null as unknown as string, sku: null, title: 'No key' }],
      sku: [],
    });
    const result = await searchBetcoProducts('x');
    expect(result).toEqual([]);
  });
});
