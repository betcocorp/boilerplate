import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-478 — dedicated coverage for `resolveProductEntityByName` /
 * `resolveProductLineKeyByName`'s real alias-lookup behavior against `rag.product_alias`.
 *
 * The ticket's premise (that the resolver never consults `rag.product_alias`) is stale — the
 * exact-match (B0-200) and tokenized fuzzy-match (B0-272) alias lookups are already implemented
 * in ~/lib/rag/entity-context.ts. This suite exercises that real logic against a faked Supabase
 * client rather than mocking `resolveProductEntityByName` itself (as
 * ~/lib/tools/product-tool-inputs.test.ts does), so a regression in the actual alias-matching
 * code would be caught here.
 */

vi.mock('~/supabase/clients/service-role', () => ({ getSupabaseServiceRoleClient: vi.fn() }));

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import { resolveProductEntityByName, resolveProductLineKeyByName } from '~/lib/rag/entity-context';

type ProductAliasRow = {
  alias_norm: string;
  alias: string;
  entity_id: string | null;
  product_line_key: string | null;
};

type EntityRow = {
  id: string;
  entity_type: string;
  product_line_key?: string | null;
  product_key?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown>;
};

type Filter =
  | { kind: 'eq'; column: string; value: string }
  | { kind: 'ilike'; column: string; value: string }
  | { kind: 'jsonFilter'; column: string; op: string; value: string };

let productAliasRows: ProductAliasRow[] = [];
let entityRows: EntityRow[] = [];

function matchesFilter(row: Record<string, unknown>, filter: Filter): boolean {
  if (filter.kind === 'eq') {
    return row[filter.column] === filter.value;
  }
  if (filter.kind === 'ilike') {
    const raw = row[filter.column];
    if (typeof raw !== 'string') return false;
    const inner = filter.value.replace(/^%/, '').replace(/%$/, '').toLowerCase();
    return raw.toLowerCase().includes(inner);
  }
  // jsonFilter: column like "metadata->>prod_line_id"
  const key = filter.column.split('->>')[1];
  const metadata = row.metadata as Record<string, unknown> | undefined;
  const nested = metadata?.[key];
  return filter.op === 'eq' && nested === filter.value;
}

function createQueryBuilder(getRows: () => Record<string, unknown>[]) {
  const filters: Filter[] = [];
  const builder = {
    eq(column: string, value: string) {
      filters.push({ kind: 'eq', column, value });
      return builder;
    },
    ilike(column: string, value: string) {
      filters.push({ kind: 'ilike', column, value });
      return builder;
    },
    filter(column: string, op: string, value: string) {
      filters.push({ kind: 'jsonFilter', column, op, value });
      return builder;
    },
    limit(n: number) {
      const rows = getRows().filter((row) => filters.every((f) => matchesFilter(row, f)));
      return Promise.resolve({ data: rows.slice(0, n), error: null });
    },
  };
  return builder;
}

const fakeSupabase = {
  schema() {
    return {
      from(table: 'product_alias' | 'entity') {
        return {
          select() {
            return createQueryBuilder(() =>
              table === 'product_alias' ? productAliasRows : entityRows,
            );
          },
        };
      },
    };
  },
};

beforeEach(() => {
  productAliasRows = [];
  entityRows = [];
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(fakeSupabase as never);
});

describe('resolveProductEntityByName — exact alias_norm match (B0-200)', () => {
  it('returns the alias row product_line_key and, for a SKU-tier entity, its product_key', async () => {
    productAliasRows = [
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-1', product_line_key: 'line-1' },
    ];
    entityRows = [{ id: 'ent-1', entity_type: 'product', product_key: 'sku-1' }];

    const result = await resolveProductEntityByName('Zorbex');

    expect(result).toEqual({
      productLineKey: 'line-1',
      productKey: 'sku-1',
      resolutionSource: 'alias_exact',
    });
  });

  it('resolveProductLineKeyByName wraps the same lookup and returns just the key', async () => {
    productAliasRows = [
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-1', product_line_key: 'line-1' },
    ];
    entityRows = [{ id: 'ent-1', entity_type: 'product', product_key: 'sku-1' }];

    const key = await resolveProductLineKeyByName('Zorbex');

    expect(key).toBe('line-1');
  });

  it('normalizes trademark glyphs/case/whitespace before matching alias_norm', async () => {
    productAliasRows = [
      { alias_norm: 'super clean 500', alias: 'Super Clean 500', entity_id: null, product_line_key: 'line-9' },
    ];

    const result = await resolveProductEntityByName('  SUPER   CLEAN® 500™  ');

    expect(result.productLineKey).toBe('line-9');
  });
});

describe('resolveProductEntityByName — legacy fallback behavior unchanged when no alias matches', () => {
  it('falls back to exact prod_line_id match against rag.entity', async () => {
    entityRows = [
      {
        id: 'ent-line-2',
        entity_type: 'product_line',
        product_line_key: 'line-2',
        title: 'Something Unrelated',
        metadata: { prod_line_id: '4020' },
      },
    ];

    const result = await resolveProductEntityByName('4020');

    expect(result).toEqual({
      productLineKey: 'line-2',
      productKey: null,
      resolutionSource: 'prod_line_id',
    });
  });

  it('falls back to a unique title ILIKE match when no alias or prod_line_id matches', async () => {
    entityRows = [
      {
        id: 'ent-line-3',
        entity_type: 'product_line',
        product_line_key: 'line-3',
        title: 'SuperClean 500',
        metadata: {},
      },
    ];

    const result = await resolveProductEntityByName('SuperClean 500');

    expect(result).toEqual({
      productLineKey: 'line-3',
      productKey: null,
      resolutionSource: 'title_exact',
    });
  });

  it('returns nulls when nothing matches at any stage', async () => {
    entityRows = [];
    productAliasRows = [];

    const result = await resolveProductEntityByName('Totally Unknown Product Name');

    expect(result).toEqual({ productLineKey: null, productKey: null, resolutionSource: null });
  });
});

describe('resolveProductEntityByName — tokenized fuzzy alias fallback (B0-272)', () => {
  it('resolves a near-miss query against a single-line alias via token AND-matching', async () => {
    productAliasRows = [
      {
        alias_norm: 'ge fight bact rtu disinfectant',
        alias: 'GE Fight BacT RTU Disinfectant',
        entity_id: 'ent-4',
        product_line_key: 'line-4',
      },
    ];
    // ent-4 is a product_line-tier entity (not "product"), so productKey stays null.
    entityRows = [{ id: 'ent-4', entity_type: 'product_line', product_line_key: 'line-4' }];

    const result = await resolveProductEntityByName('GE Fight Bac RTU');

    expect(result).toEqual({
      productLineKey: 'line-4',
      productKey: null,
      resolutionSource: 'alias_fuzzy',
    });
  });

  it('returns null instead of guessing when tokens match aliases across multiple product lines', async () => {
    productAliasRows = [
      { alias_norm: 'foo bar baz alpha', alias: 'Foo Bar Baz Alpha', entity_id: 'ent-5', product_line_key: 'line-5' },
      { alias_norm: 'foo bar baz beta', alias: 'Foo Bar Baz Beta', entity_id: 'ent-6', product_line_key: 'line-6' },
    ];
    // No entity titles match either, so the legacy fallbacks also can't resolve this — the
    // ambiguity must surface as null, not a guess.
    entityRows = [];

    const result = await resolveProductEntityByName('Foo Bar Baz');

    expect(result).toEqual({ productLineKey: null, productKey: null, resolutionSource: null });
  });
});
