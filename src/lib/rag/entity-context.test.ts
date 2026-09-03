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
import {
  resolveEntityDisplayTitle,
  resolveProductEntityByName,
  resolveProductLineKeyByName,
} from '~/lib/rag/entity-context';

type ProductAliasRow = {
  alias_norm: string;
  alias: string;
  entity_id: string | null;
  product_line_key: string | null;
  verified?: boolean;
  /** B0-488: only asserted where a test cares about the matched-row id/confidence surfaced on
   * `resolveProductEntityByName`'s return value. */
  id?: string;
  confidence?: number;
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

/** B0-830: `legacy.prod_line` rows — the product LINE display name comes from `ProdLineDescr`. */
type ProdLineRow = { ProdLineKey: string; ProdLineDescr: string | null };

let productAliasRows: ProductAliasRow[] = [];
let entityRows: EntityRow[] = [];
let prodLineRows: ProdLineRow[] = [];
/** null = simulate the RPC being unavailable (falls through, like a pre-migration environment). */
let fuzzyTrgmRpcRows: FuzzyTrgmRpcRow[] | null = null;
/** B0-479: how many times the trigram RPC tier was actually invoked. */
let fuzzyTrgmRpcCalls = 0;

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
      from(table: 'product_alias' | 'entity' | 'prod_line') {
        return {
          select() {
            return createQueryBuilder(() =>
              table === 'product_alias'
                ? productAliasRows
                : table === 'prod_line'
                  ? prodLineRows
                  : entityRows,
            );
          },
        };
      },
      // B0-482: rag.match_product_alias_fuzzy. Real RPC would already filter by
      // similarity_threshold and rank descending -- fixtures below supply pre-filtered,
      // pre-ranked rows to match that contract, same as the real function's output shape.
      rpc(fn: string) {
        if (fn === 'match_product_alias_fuzzy') {
          fuzzyTrgmRpcCalls += 1;
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
  prodLineRows = [];
  fuzzyTrgmRpcRows = null;
  fuzzyTrgmRpcCalls = 0;
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(fakeSupabase as never);
});

describe('B0-830 — matchedTitle / resolveEntityDisplayTitle name a product LINE by legacy ProdLineDescr', () => {
  const AF79_ALIAS: ProductAliasRow = {
    alias_norm: 'af79 concentrate disinfectant',
    alias: 'AF79 Concentrate Disinfectant',
    entity_id: 'ent-af79-line',
    product_line_key: 'line-af79',
    verified: true,
    id: 'alias-af79',
    confidence: 0.98,
  };
  /** Real shape confirmed via Supabase: the product_line tier's `rag.entity.title` is the
   * marketing short_description, not the product name. */
  const AF79_LINE_ENTITY: EntityRow = {
    id: 'ent-af79-line',
    entity_type: 'product_line',
    product_line_key: 'line-af79',
    title: 'Concentrated Acid Free Bathroom Disinfectant',
  };

  it('prefers legacy.prod_line.ProdLineDescr over the marketing entity title for a product_line entity', async () => {
    productAliasRows = [AF79_ALIAS];
    entityRows = [AF79_LINE_ENTITY];
    // Duplicate legacy rows per key are real; the first NON-EMPTY description wins.
    prodLineRows = [
      { ProdLineKey: 'line-af79', ProdLineDescr: '   ' },
      { ProdLineKey: 'line-af79', ProdLineDescr: 'AF79 Concentrate Disinfectant' },
      { ProdLineKey: 'line-other', ProdLineDescr: 'Some Other Line' },
    ];

    const result = await resolveProductEntityByName('AF79 Concentrate Disinfectant');
    expect(result.resolutionSource).toBe('alias_exact');
    expect(result.matchedTitle).toBe('AF79 Concentrate Disinfectant');

    expect(await resolveEntityDisplayTitle('ent-af79-line')).toBe('AF79 Concentrate Disinfectant');
  });

  it('falls back to the entity title when the legacy table has no usable description for the key', async () => {
    productAliasRows = [AF79_ALIAS];
    entityRows = [AF79_LINE_ENTITY];
    prodLineRows = [{ ProdLineKey: 'line-af79', ProdLineDescr: null }];

    const result = await resolveProductEntityByName('AF79 Concentrate Disinfectant');
    expect(result.matchedTitle).toBe('Concentrated Acid Free Bathroom Disinfectant');
    expect(await resolveEntityDisplayTitle('ent-af79-line')).toBe(
      'Concentrated Acid Free Bathroom Disinfectant',
    );
  });

  it('leaves a SKU-tier product entity on its own title — never relabels it with the line name', async () => {
    productAliasRows = [{ ...AF79_ALIAS, entity_id: 'ent-af79-sku' }];
    entityRows = [
      {
        id: 'ent-af79-sku',
        entity_type: 'product',
        product_line_key: 'line-af79',
        product_key: '33104',
        title: 'AF 79Concentrate',
      },
    ];
    prodLineRows = [{ ProdLineKey: 'line-af79', ProdLineDescr: 'AF79 Concentrate Disinfectant' }];

    const result = await resolveProductEntityByName('AF79 Concentrate Disinfectant');
    expect(result.productKey).toBe('33104');
    expect(result.matchedTitle).toBe('AF 79Concentrate');
    expect(await resolveEntityDisplayTitle('ent-af79-sku')).toBe('AF 79Concentrate');
  });

  it('returns null for an unknown entity id', async () => {
    expect(await resolveEntityDisplayTitle('ent-missing')).toBeNull();
  });
});

describe('resolveProductEntityByName — exact alias_norm match (B0-200)', () => {
  it('returns the alias row product_line_key and, for a SKU-tier entity, its product_key', async () => {
    productAliasRows = [
      {
        alias_norm: 'zorbex',
        alias: 'Zorbex',
        entity_id: 'ent-1',
        product_line_key: 'line-1',
        verified: true,
        id: 'alias-1',
        confidence: 0.95,
      },
    ];
    entityRows = [{ id: 'ent-1', entity_type: 'product', product_key: 'sku-1' }];

    const result = await resolveProductEntityByName('Zorbex');

    expect(result).toEqual({
      productLineKey: 'line-1',
      productKey: 'sku-1',
      resolutionSource: 'alias_exact',
      ambiguousAlias: false,
      matchedAliasId: 'alias-1',
      matchedAliasConfidence: 0.95,
      matchedTitle: null,
    });
  });

  it('resolveProductLineKeyByName wraps the same lookup and returns just the key', async () => {
    productAliasRows = [
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-1', product_line_key: 'line-1', verified: true },
    ];
    entityRows = [{ id: 'ent-1', entity_type: 'product', product_key: 'sku-1' }];

    const key = await resolveProductLineKeyByName('Zorbex');

    expect(key).toBe('line-1');
  });

  it('returns null instead of resolving when the only exact alias_norm match is unverified (B0-696)', async () => {
    productAliasRows = [
      {
        alias_norm: 'trident 10x',
        alias: 'Trident 10x',
        entity_id: 'ent-corpus',
        product_line_key: 'line-corpus',
        verified: false,
        id: 'alias-corpus',
        confidence: 0.45,
      },
    ];
    entityRows = [{ id: 'ent-corpus', entity_type: 'product_line', product_line_key: 'line-corpus' }];

    const result = await resolveProductEntityByName('Trident 10x');

    expect(result).toEqual({
      productLineKey: null,
      productKey: null,
      resolutionSource: null,
      ambiguousAlias: false,
      matchedAliasId: null,
      matchedAliasConfidence: null,
      matchedTitle: null,
    });
  });

  it('normalizes trademark glyphs/case/whitespace before matching alias_norm', async () => {
    productAliasRows = [
      { alias_norm: 'super clean 500', alias: 'Super Clean 500', entity_id: null, product_line_key: 'line-9', verified: true },
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
      ambiguousAlias: false,
      matchedAliasId: null,
      matchedAliasConfidence: null,
      matchedTitle: null,
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
      ambiguousAlias: false,
      matchedAliasId: null,
      matchedAliasConfidence: null,
      matchedTitle: null,
    });
  });

  it('returns nulls when nothing matches at any stage', async () => {
    entityRows = [];
    productAliasRows = [];

    const result = await resolveProductEntityByName('Totally Unknown Product Name');

    expect(result).toEqual({
      productLineKey: null,
      productKey: null,
      resolutionSource: null,
      ambiguousAlias: false,
      matchedAliasId: null,
      matchedAliasConfidence: null,
      matchedTitle: null,
    });
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
        verified: true,
        id: 'alias-4',
        confidence: 0.8,
      },
    ];
    // ent-4 is a product_line-tier entity (not "product"), so productKey stays null.
    entityRows = [{ id: 'ent-4', entity_type: 'product_line', product_line_key: 'line-4' }];

    const result = await resolveProductEntityByName('GE Fight Bac RTU');

    expect(result).toEqual({
      productLineKey: 'line-4',
      productKey: null,
      resolutionSource: 'alias_fuzzy',
      ambiguousAlias: false,
      matchedAliasId: 'alias-4',
      matchedAliasConfidence: 0.8,
      matchedTitle: null,
    });
  });

  it('returns null instead of resolving when the only tokenized alias match is unverified (B0-696)', async () => {
    productAliasRows = [
      {
        alias_norm: 'corpus mined noun phrase disinfectant',
        alias: 'Corpus Mined Noun Phrase Disinfectant',
        entity_id: 'ent-corpus-2',
        product_line_key: 'line-corpus-2',
        verified: false,
        id: 'alias-corpus-2',
        confidence: 0.4,
      },
    ];
    entityRows = [{ id: 'ent-corpus-2', entity_type: 'product_line', product_line_key: 'line-corpus-2' }];

    const result = await resolveProductEntityByName('Corpus Mined Phrase Disinfectant');

    expect(result).toEqual({
      productLineKey: null,
      productKey: null,
      resolutionSource: null,
      ambiguousAlias: false,
      matchedAliasId: null,
      matchedAliasConfidence: null,
      matchedTitle: null,
    });
  });

  it('returns null instead of guessing when tokens match aliases across multiple product lines (ambiguous alias, B0-488)', async () => {
    productAliasRows = [
      { alias_norm: 'foo bar baz alpha', alias: 'Foo Bar Baz Alpha', entity_id: 'ent-5', product_line_key: 'line-5' },
      { alias_norm: 'foo bar baz beta', alias: 'Foo Bar Baz Beta', entity_id: 'ent-6', product_line_key: 'line-6' },
    ];
    // No entity titles match either, so the legacy fallbacks also can't resolve this — the
    // ambiguity must surface as null, not a guess, with `ambiguousAlias: true` distinguishing it
    // from a genuine no-match.
    entityRows = [];

    const result = await resolveProductEntityByName('Foo Bar Baz');

    expect(result).toEqual({
      productLineKey: null,
      productKey: null,
      resolutionSource: null,
      ambiguousAlias: true,
      matchedAliasId: null,
      matchedAliasConfidence: null,
      matchedTitle: null,
    });
  });
});

describe('resolveProductEntityByName — exact alias_norm match spanning multiple product lines (B0-481/B0-483)', () => {
  it('resolves to the single verified row when the exact alias_norm spans 2 product lines and exactly one is verified', async () => {
    // B0-481 relaxed UNIQUE(alias_norm) to UNIQUE(alias_norm, product_line_key), so this is now a
    // legal shape: a US variant (verified via trusted legacy backfill) and an unverified,
    // not-yet-reviewed Canada alias sharing the same display name.
    productAliasRows = [
      {
        alias_norm: 'zorbex',
        alias: 'Zorbex',
        entity_id: 'ent-us',
        product_line_key: 'line-us',
        verified: true,
        id: 'alias-us',
        confidence: 1,
      },
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-ca', product_line_key: 'line-ca', verified: false },
    ];
    entityRows = [{ id: 'ent-us', entity_type: 'product_line', product_line_key: 'line-us' }];

    const result = await resolveProductEntityByName('Zorbex');

    expect(result).toEqual({
      productLineKey: 'line-us',
      productKey: null,
      resolutionSource: 'alias_exact',
      ambiguousAlias: false,
      matchedAliasId: 'alias-us',
      matchedAliasConfidence: 1,
      matchedTitle: null,
    });
  });

  it('returns null when the exact alias_norm spans multiple product lines and none is verified (ambiguous alias, B0-488)', async () => {
    productAliasRows = [
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-us', product_line_key: 'line-us', verified: false },
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-ca', product_line_key: 'line-ca', verified: false },
    ];
    entityRows = [];

    const result = await resolveProductEntityByName('Zorbex');

    expect(result).toEqual({
      productLineKey: null,
      productKey: null,
      resolutionSource: null,
      ambiguousAlias: true,
      matchedAliasId: null,
      matchedAliasConfidence: null,
      matchedTitle: null,
    });
  });

  it('returns null when the exact alias_norm spans multiple product lines and more than one is verified (ambiguous alias, B0-488)', async () => {
    productAliasRows = [
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-us', product_line_key: 'line-us', verified: true },
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-ca', product_line_key: 'line-ca', verified: true },
    ];
    entityRows = [];

    const result = await resolveProductEntityByName('Zorbex');

    expect(result).toEqual({
      productLineKey: null,
      productKey: null,
      resolutionSource: null,
      ambiguousAlias: true,
      matchedAliasId: null,
      matchedAliasConfidence: null,
      matchedTitle: null,
    });
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

    expect(result).toEqual({
      productLineKey: 'line-7',
      productKey: null,
      resolutionSource: 'alias_fuzzy_trgm',
      ambiguousAlias: false,
      // The RPC never returns the alias row id.
      matchedAliasId: null,
      matchedAliasConfidence: 0.9,
      matchedTitle: null,
    });
  });

  it('returns null when top-scoring fuzzy candidates within the ambiguity margin span multiple product lines with no single verified winner (ambiguous alias, B0-488)', async () => {
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

    expect(result).toEqual({
      productLineKey: null,
      productKey: null,
      resolutionSource: null,
      ambiguousAlias: true,
      matchedAliasId: null,
      matchedAliasConfidence: null,
      matchedTitle: null,
    });
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

    expect(result).toEqual({
      productLineKey: 'line-10',
      productKey: null,
      resolutionSource: 'alias_fuzzy_trgm',
      ambiguousAlias: false,
      matchedAliasId: null,
      matchedAliasConfidence: 0.9,
      matchedTitle: null,
    });
  });

  it('does not fire the fuzzy RPC tier when an earlier tier (exact/tokenized alias) already matched', async () => {
    productAliasRows = [
      { alias_norm: 'zorbex', alias: 'Zorbex', entity_id: 'ent-1', product_line_key: 'line-1', verified: true },
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

    expect(result).toEqual({
      productLineKey: 'line-1',
      productKey: 'sku-1',
      resolutionSource: 'alias_exact',
      ambiguousAlias: false,
      matchedAliasId: null,
      matchedAliasConfidence: null,
      matchedTitle: null,
    });
  });
});

describe('resolveProductEntityByName — EXP- experimental alias exclusion (B0-791)', () => {
  it('skips an EXP- superstring match in the trigram fuzzy tier for a bare product name, resolving to the real product line instead', async () => {
    // Real data: "DENSICLEAN" scores 0.73 against "EXP-DENSICLEAN" (a verified but
    // experimental/discontinued line) and only 0.37 against the real
    // "DensicleanT Cleaner with Densifier" alias -- without the EXP- exclusion the wrong,
    // higher-scoring line would win outright (single distinct product line, no ambiguity path).
    fuzzyTrgmRpcRows = [
      {
        alias_norm: 'exp-densiclean',
        alias: 'EXP-DENSICLEAN',
        entity_id: 'ent-exp',
        product_line_key: 'line-exp',
        verified: true,
        alias_type: 'title',
        confidence: 0.9,
        similarity: 0.733333,
      },
      {
        alias_norm: 'densicleant cleaner with densifier',
        alias: 'DensicleanT Cleaner with Densifier',
        entity_id: 'ent-real',
        product_line_key: 'line-real',
        verified: true,
        alias_type: 'title',
        confidence: 0.9,
        similarity: 0.37037,
      },
    ];
    entityRows = [{ id: 'ent-real', entity_type: 'product_line', product_line_key: 'line-real' }];

    const result = await resolveProductEntityByName('DENSICLEAN');

    expect(result).toEqual({
      productLineKey: 'line-real',
      productKey: null,
      resolutionSource: 'alias_fuzzy_trgm',
      ambiguousAlias: false,
      matchedAliasId: null,
      matchedAliasConfidence: 0.9,
      matchedTitle: null,
    });
  });

  it('still resolves an EXP- line when the query itself is an EXP- lookup', async () => {
    fuzzyTrgmRpcRows = [
      {
        alias_norm: 'exp-densiclean',
        alias: 'EXP-DENSICLEAN',
        entity_id: 'ent-exp',
        product_line_key: 'line-exp',
        verified: true,
        alias_type: 'title',
        confidence: 0.9,
        similarity: 0.95,
      },
    ];
    entityRows = [{ id: 'ent-exp', entity_type: 'product_line', product_line_key: 'line-exp' }];

    const result = await resolveProductEntityByName('EXP-DENSICLEAN');

    expect(result.productLineKey).toBe('line-exp');
    expect(result.resolutionSource).toBe('alias_fuzzy_trgm');
  });

  it('returns null instead of matching when every trigram candidate is an EXP- line and the query is not', async () => {
    fuzzyTrgmRpcRows = [
      {
        alias_norm: 'exp-drain gel',
        alias: 'EXP-DRAIN GEL',
        entity_id: 'ent-exp-2',
        product_line_key: 'line-exp-2',
        verified: true,
        alias_type: 'title',
        confidence: 0.9,
        similarity: 0.5,
      },
    ];
    entityRows = [];

    const result = await resolveProductEntityByName('DRAIN GEL');

    expect(result).toEqual({
      productLineKey: null,
      productKey: null,
      resolutionSource: null,
      ambiguousAlias: false,
      matchedAliasId: null,
      matchedAliasConfidence: null,
      matchedTitle: null,
    });
  });

  it('skips an EXP- candidate in the tokenized alias fallback tier too', async () => {
    productAliasRows = [
      {
        alias_norm: 'exp-untouchable sr technology',
        alias: 'EXP-Untouchable SR Technology',
        entity_id: 'ent-exp-3',
        product_line_key: 'line-exp-3',
        verified: true,
      },
      {
        alias_norm: 'untouchable sr technology floor finish',
        alias: 'Untouchable SR Technology Floor Finish',
        entity_id: 'ent-real-3',
        product_line_key: 'line-real-3',
        verified: true,
      },
    ];
    entityRows = [{ id: 'ent-real-3', entity_type: 'product_line', product_line_key: 'line-real-3' }];

    const result = await resolveProductEntityByName('untouchable sr technology');

    expect(result.productLineKey).toBe('line-real-3');
    expect(result.resolutionSource).toBe('alias_fuzzy');
  });
});

/**
 * B0-479 — `{ mode: 'freeform' }`: the resolution attempt `search_product_docs` now makes against
 * raw `freeformQuery` text (it previously passed `''` and skipped resolution entirely, letting an
 * unfiltered similarity probe pick the product line — which is how a bare SKU query got served a
 * different product's SDS). Only the two high-precision alias tiers may run, and only on an
 * unambiguous match.
 */
describe('resolveProductEntityByName — freeform mode restricts resolution to precise tiers (B0-479)', () => {
  it('resolves an exact alias hit on freeform text and tags it alias_exact_freeform', async () => {
    // Real shape from rag.product_alias: the SKU that the B0-480 gold-set case queries.
    productAliasRows = [
      {
        alias_norm: '07512-00',
        alias: '07512-00',
        entity_id: 'ent-kling',
        product_line_key: 'line-kling',
        verified: true,
        id: 'alias-kling',
        confidence: 1,
      },
    ];
    entityRows = [{ id: 'ent-kling', entity_type: 'product', product_key: 'sku-kling' }];

    const result = await resolveProductEntityByName('07512-00', { mode: 'freeform' });

    expect(result).toEqual({
      productLineKey: 'line-kling',
      productKey: 'sku-kling',
      resolutionSource: 'alias_exact_freeform',
      ambiguousAlias: false,
      matchedAliasId: 'alias-kling',
      matchedAliasConfidence: 1,
      matchedTitle: null,
    });
  });

  it('resolves a tokenized alias hit on freeform text and tags it alias_fuzzy_freeform', async () => {
    productAliasRows = [
      {
        alias_norm: 'ge fight bact rtu disinfectant',
        alias: 'GE Fight BacT RTU Disinfectant',
        entity_id: 'ent-4',
        product_line_key: 'line-4',
        verified: true,
        id: 'alias-4',
        confidence: 0.8,
      },
    ];
    entityRows = [{ id: 'ent-4', entity_type: 'product_line', product_line_key: 'line-4' }];

    const result = await resolveProductEntityByName('GE Fight Bac RTU', { mode: 'freeform' });

    expect(result).toEqual({
      productLineKey: 'line-4',
      productKey: null,
      resolutionSource: 'alias_fuzzy_freeform',
      ambiguousAlias: false,
      matchedAliasId: 'alias-4',
      matchedAliasConfidence: 0.8,
      matchedTitle: null,
    });
  });

  it('never fires the trigram fuzzy RPC in freeform mode, even when it would have locked a line', async () => {
    // A long natural-language question is exactly the input whole-string trigram similarity can
    // spuriously match: this fixture clears the 0.35 threshold and would lock retrieval onto
    // line-trgm in the default (name) mode.
    fuzzyTrgmRpcRows = [
      {
        alias_norm: 'grout and tile restroom cleaner',
        alias: 'Grout and Tile Restroom Cleaner',
        entity_id: 'ent-trgm',
        product_line_key: 'line-trgm',
        verified: true,
        alias_type: 'title',
        confidence: 0.9,
        similarity: 0.44,
      },
    ];
    const question = 'what should I use to clean grout in a restroom?';

    const freeform = await resolveProductEntityByName(question, { mode: 'freeform' });

    expect(fuzzyTrgmRpcCalls).toBe(0);
    expect(freeform).toEqual({
      productLineKey: null,
      productKey: null,
      resolutionSource: null,
      ambiguousAlias: false,
      matchedAliasId: null,
      matchedAliasConfidence: null,
      matchedTitle: null,
    });

    // Control: the same fixture and query DO reach (and resolve through) the RPC in name mode —
    // proving the assertion above is the tier restriction, not an inert fixture.
    const nameMode = await resolveProductEntityByName(question);
    expect(fuzzyTrgmRpcCalls).toBe(1);
    expect(nameMode.productLineKey).toBe('line-trgm');
    expect(nameMode.resolutionSource).toBe('alias_fuzzy_trgm');
  });

  it('returns no lock when freeform text hits an alias spanning multiple product lines, even with exactly one verified candidate', async () => {
    // The B0-483 verified-tiebreak is deliberately NOT applied in freeform mode: the user never
    // asserted this product name, so electing the verified line would be a guess.
    productAliasRows = [
      {
        alias_norm: 'zorbex',
        alias: 'Zorbex',
        entity_id: 'ent-us',
        product_line_key: 'line-us',
        verified: true,
        id: 'alias-us',
        confidence: 1,
      },
      {
        alias_norm: 'zorbex',
        alias: 'Zorbex',
        entity_id: 'ent-ca',
        product_line_key: 'line-ca',
        verified: false,
      },
    ];
    entityRows = [{ id: 'ent-us', entity_type: 'product_line', product_line_key: 'line-us' }];

    const freeform = await resolveProductEntityByName('Zorbex', { mode: 'freeform' });

    expect(freeform).toEqual({
      productLineKey: null,
      productKey: null,
      resolutionSource: null,
      ambiguousAlias: true,
      matchedAliasId: null,
      matchedAliasConfidence: null,
      matchedTitle: null,
    });

    // Control: name mode still applies the verified-tiebreak, unchanged by B0-479.
    const nameMode = await resolveProductEntityByName('Zorbex');
    expect(nameMode.productLineKey).toBe('line-us');
    expect(nameMode.resolutionSource).toBe('alias_exact');
  });

  it('returns no lock when tokenized freeform candidates span multiple product lines', async () => {
    // "Foaming Hand Sanitizer" (B0-480 gold-set case): six real aliases across six product lines
    // share these tokens, so the correct outcome is no lock at all.
    productAliasRows = [
      { alias_norm: 'alcohol foaming hand sanitizer', alias: 'Alcohol Foaming Hand Sanitizer', entity_id: 'ent-a', product_line_key: 'line-a', verified: true },
      { alias_norm: 'alcohol free foaming hand sanitizer', alias: 'Alcohol Free Foaming Hand Sanitizer', entity_id: 'ent-b', product_line_key: 'line-b', verified: false },
    ];
    entityRows = [];

    const result = await resolveProductEntityByName('Foaming Hand Sanitizer', { mode: 'freeform' });

    expect(result.productLineKey).toBeNull();
    expect(result.resolutionSource).toBeNull();
    expect(result.ambiguousAlias).toBe(true);
  });

  it('does not fall back to the legacy prod_line_id / title tiers in freeform mode', async () => {
    entityRows = [
      {
        id: 'ent-line-2',
        entity_type: 'product_line',
        product_line_key: 'line-2',
        title: 'SuperClean 500',
        metadata: { prod_line_id: '4020' },
      },
    ];

    // Both of these resolve in name mode (prod_line_id and title_exact respectively).
    expect((await resolveProductEntityByName('4020')).resolutionSource).toBe('prod_line_id');
    expect((await resolveProductEntityByName('SuperClean 500')).resolutionSource).toBe('title_exact');

    expect(await resolveProductEntityByName('4020', { mode: 'freeform' })).toEqual({
      productLineKey: null,
      productKey: null,
      resolutionSource: null,
      ambiguousAlias: false,
      matchedAliasId: null,
      matchedAliasConfidence: null,
      matchedTitle: null,
    });
    expect(
      (await resolveProductEntityByName('SuperClean 500', { mode: 'freeform' })).productLineKey,
    ).toBeNull();
  });
});
