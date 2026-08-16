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
  verified?: boolean;
};

/** Shape of a row returned by the `rag.match_product_alias_fuzzy` RPC (B0-482). */
type FuzzyTrgmRpcRow = {
  alias_norm: string;
  alias: string;
  entity_id: string | null;
  product_line_key: string | null;
  verified: boolean;
  alias_type: string | null;
  confidence: number | null;
  similarity: number;
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
/** null = simulate the RPC being unavailable (falls through, like a pre-migration environment). */
let fuzzyTrgmRpcRows: FuzzyTrgmRpcRow[] | null = null;

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
      // B0-482: rag.match_product_alias_fuzzy. Real RPC would already filter by
      // similarity_threshold and rank descending -- fixtures below supply pre-filtered,
      // pre-ranked rows to match that contract, same as the real function's output shape.
      rpc(fn: string) {
        if (fn === 'match_product_alias_fuzzy') {
          return Promise.resolve({ data: fuzzyTrgmRpcRows, error: null });
        }
        return Promise.resolve({ data: null, error: new Error(`unexpected rpc: ${fn}`) });
      },
    };
  },
};

beforeEach(() => {
  productAliasRows = [];
  entityRows = [];
  fuzzyTrgmRpcRows = null;
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

describe('resolveProductEntityByName — exact alias_norm match spanning multiple product lines (B0-481/B0-483)', () => {
  it('resolves to the single verified row when the exact alias_norm spans 2 product lines and exactly one is verified', async () => {
    // B0-481 relaxed UNIQUE(alias_norm) to UNIQUE(alias_norm, product_line_key), so this is now a
    // legal shape: a US variant (verified via trusted legacy backfill) and an unverified,
    // not-yet-reviewed Canada alias sharing the same display name.
    productAliasRows = [
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-us', product_line_key: 'line-us', verified: true },
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-ca', product_line_key: 'line-ca', verified: false },
    ];
    entityRows = [{ id: 'ent-us', entity_type: 'product_line', product_line_key: 'line-us' }];

    const result = await resolveProductEntityByName('Zorbex');

    expect(result).toEqual({ productLineKey: 'line-us', productKey: null, resolutionSource: 'alias_exact' });
  });

  it('returns null when the exact alias_norm spans multiple product lines and none is verified', async () => {
    productAliasRows = [
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-us', product_line_key: 'line-us', verified: false },
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-ca', product_line_key: 'line-ca', verified: false },
    ];
    entityRows = [];

    const result = await resolveProductEntityByName('Zorbex');

    expect(result).toEqual({ productLineKey: null, productKey: null, resolutionSource: null });
  });

  it('returns null when the exact alias_norm spans multiple product lines and more than one is verified', async () => {
    productAliasRows = [
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-us', product_line_key: 'line-us', verified: true },
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-ca', product_line_key: 'line-ca', verified: true },
    ];
    entityRows = [];

    const result = await resolveProductEntityByName('Zorbex');

    expect(result).toEqual({ productLineKey: null, productKey: null, resolutionSource: null });
  });
});

describe('resolveProductEntityByName — trigram fuzzy alias RPC fallback (B0-482)', () => {
  it('resolves via the fuzzy RPC when the top candidate clears the threshold with no competing product line nearby', async () => {
    fuzzyTrgmRpcRows = [
      {
        alias_norm: 'acrylic polymer floor finish',
        alias: 'Acrylic Polymer Floor Finish',
        entity_id: 'ent-7',
        product_line_key: 'line-7',
        verified: true,
        alias_type: 'title',
        confidence: 0.9,
        similarity: 0.9,
      },
      {
        alias_norm: 'metal interlocked acrylic polymer floor finish',
        alias: 'Metal Interlocked Acrylic Polymer Floor Finish',
        entity_id: 'ent-8',
        product_line_key: 'line-8',
        verified: true,
        alias_type: 'title',
        confidence: 0.9,
        similarity: 0.55,
      },
    ];
    entityRows = [{ id: 'ent-7', entity_type: 'product_line', product_line_key: 'line-7' }];

    // Query has no exact/tokenized alias match (typo breaks the tokenized AND-match), so this
    // falls through to the fuzzy RPC tier.
    const result = await resolveProductEntityByName('acrylic polymer flor finish');

    expect(result).toEqual({ productLineKey: 'line-7', productKey: null, resolutionSource: 'alias_fuzzy_trgm' });
  });

  it('returns null when top-scoring fuzzy candidates within the ambiguity margin span multiple product lines with no single verified winner', async () => {
    fuzzyTrgmRpcRows = [
      {
        alias_norm: 'alcohol foaming hand sanitizer',
        alias: 'Alcohol Foaming Hand Sanitizer',
        entity_id: 'ent-9',
        product_line_key: 'line-9',
        verified: true,
        alias_type: 'title',
        confidence: 0.9,
        similarity: 0.85,
      },
      {
        alias_norm: 'foaming alcohol hand sanitizer',
        alias: 'Foaming Alcohol Hand Sanitizer',
        entity_id: 'ent-10',
        product_line_key: 'line-10',
        verified: true,
        alias_type: 'title',
        confidence: 0.9,
        similarity: 0.85,
      },
    ];
    entityRows = [];

    const result = await resolveProductEntityByName('alcohol foming hand sanitizer');

    expect(result).toEqual({ productLineKey: null, productKey: null, resolutionSource: null });
  });

  it('resolves to the single verified candidate when close fuzzy candidates span multiple product lines', async () => {
    fuzzyTrgmRpcRows = [
      {
        alias_norm: 'alcohol foaming hand sanitizer',
        alias: 'Alcohol Foaming Hand Sanitizer',
        entity_id: 'ent-9',
        product_line_key: 'line-9',
        verified: false,
        alias_type: 'title',
        confidence: 0.9,
        similarity: 0.85,
      },
      {
        alias_norm: 'foaming alcohol hand sanitizer',
        alias: 'Foaming Alcohol Hand Sanitizer',
        entity_id: 'ent-10',
        product_line_key: 'line-10',
        verified: true,
        alias_type: 'title',
        confidence: 0.9,
        similarity: 0.84,
      },
    ];
    entityRows = [{ id: 'ent-10', entity_type: 'product_line', product_line_key: 'line-10' }];

    const result = await resolveProductEntityByName('alcohol foming hand sanitizer');

    expect(result).toEqual({ productLineKey: 'line-10', productKey: null, resolutionSource: 'alias_fuzzy_trgm' });
  });

  it('does not fire the fuzzy RPC tier when an earlier tier (exact/tokenized alias) already matched', async () => {
    productAliasRows = [
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-1', product_line_key: 'line-1' },
    ];
    entityRows = [{ id: 'ent-1', entity_type: 'product', product_key: 'sku-1' }];
    // If the fuzzy RPC were consulted despite the exact match already resolving, this would
    // resolve to a different product line -- proving the exact-match tier short-circuits first.
    fuzzyTrgmRpcRows = [
      {
        alias_norm: 'zorbex extra',
        alias: 'Zorbex Extra',
        entity_id: 'ent-99',
        product_line_key: 'line-99',
        verified: true,
        alias_type: 'title',
        confidence: 0.9,
        similarity: 0.99,
      },
    ];

    const result = await resolveProductEntityByName('Zorbex');

    expect(result).toEqual({ productLineKey: 'line-1', productKey: 'sku-1', resolutionSource: 'alias_exact' });
  });
});
