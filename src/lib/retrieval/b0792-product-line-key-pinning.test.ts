import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-792 — a `product_line_key` grouping can bucket UNRELATED finished-goods products together
 * (confirmed live: `product_line_key` 1FFF1D45-36AC-4D67-9BC5-CDC8626830E3, titled "Drain
 * Maintainer", groups ~10 unrelated products — Push Lemon & Sage, Bioda Multi-Purpose Enzyme
 * Cleaner, Velocity Gear Odor Eliminator, Drain Field Cleaner, several "Liquid Enzyme Cleaner"
 * rows, and a "Test Title" placeholder — under one bogus legacy `prod_line_id` "2607"). Merging
 * product-tier facts across the WHOLE group (the pre-fix `fetchFactsForProductLineKey` behaviour)
 * can surface one product's dilution as another's. `fetchFactsForProduct` /
 * `fetchFactsForProductBatch` fix this by pinning to the caller's own resolved `productKey`'s
 * entity row, never a sibling's, and falling back to the line-wide merge only when no specific
 * product was resolved.
 */

const supa = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: unknown }>,
  fromCalls: [] as string[],
}));

vi.mock('~/supabase/clients/service-role', () => {
  const makeQuery = (result: { data: unknown; error: unknown }) => {
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'in', 'is', 'eq', 'limit', 'order']) {
      query[method] = () => query;
    }
    query.maybeSingle = () => Promise.resolve(result);
    query.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return query;
  };

  return {
    getSupabaseServiceRoleClient: () => ({
      schema: () => ({
        from: (table: string) => {
          supa.fromCalls.push(table);
          return makeQuery(supa.tables[table] ?? { data: [], error: null });
        },
      }),
    }),
  };
});

import { fetchFactsForProduct, fetchFactsForProductBatch } from '~/lib/retrieval/product-facts';

const LINE_KEY = '1FFF1D45-36AC-4D67-9BC5-CDC8626830E3';
const LINE_ENTITY = 'drain-maintainer-line';

// Two unrelated finished-goods products, both wrongly bucketed under LINE_KEY, exactly like the
// live "Drain Maintainer" bug: PUSH Lemon & Sage (5 oz/gal) vs. a sibling product with its own,
// different dilution.
const PUSH_PRODUCT_ENTITY = 'push-entity';
const PUSH_PRODUCT_KEY = '260704';
const SIBLING_PRODUCT_ENTITY = 'sibling-entity';
const SIBLING_PRODUCT_KEY = 'D45EC76B-CB9F-46EF-B576-BA3ACB02713D'; // Velocity Gear Odor Eliminator

type EntityRow = {
  id: string;
  entity_type: string;
  product_line_key: string | null;
  product_key: string | null;
};

const ENTITIES: EntityRow[] = [
  { id: LINE_ENTITY, entity_type: 'product_line', product_line_key: LINE_KEY, product_key: null },
  {
    id: PUSH_PRODUCT_ENTITY,
    entity_type: 'product',
    product_line_key: LINE_KEY,
    product_key: PUSH_PRODUCT_KEY,
  },
  {
    id: SIBLING_PRODUCT_ENTITY,
    entity_type: 'product',
    product_line_key: LINE_KEY,
    product_key: SIBLING_PRODUCT_KEY,
  },
];

function factRow(overrides: Record<string, unknown>) {
  return {
    entity_id: LINE_ENTITY,
    product_key: null,
    dilution_oz_per_gal: null,
    dilution_display: null,
    coverage_sq_ft: null,
    chemistry_class: null,
    product_application: null,
    product_application_confidence: null,
    epa_registration: null,
    contact_time_seconds: null,
    confidence: 1,
    ...overrides,
  };
}

function seed(options: { entities?: EntityRow[]; facts?: unknown[]; efficacy?: unknown[] }) {
  supa.tables = {
    entity: { data: options.entities ?? [], error: null },
    product_line_fact: { data: options.facts ?? [], error: null },
    product_efficacy: { data: options.efficacy ?? [], error: null },
  };
}

beforeEach(() => {
  supa.tables = {};
  supa.fromCalls = [];
});

describe('B0-792 fetchFactsForProduct pins to the resolved productKey', () => {
  it('never surfaces a sibling product-tier row sharing product_line_key when productKey is known', async () => {
    seed({
      entities: ENTITIES,
      facts: [
        // No line-tier scalar row — both products' dilutions live only on their own product tier.
        factRow({
          entity_id: PUSH_PRODUCT_ENTITY,
          product_key: PUSH_PRODUCT_KEY,
          dilution_oz_per_gal: 5,
          dilution_display: '5 oz/gal',
        }),
        factRow({
          entity_id: SIBLING_PRODUCT_ENTITY,
          product_key: SIBLING_PRODUCT_KEY,
          dilution_oz_per_gal: 2,
          dilution_display: '2 oz/gal',
        }),
      ],
    });

    const pushFacts = await fetchFactsForProduct(LINE_KEY, PUSH_PRODUCT_KEY);
    expect(pushFacts?.dilutionOzPerGal).toBe(5);
    expect(pushFacts?.dilutionDisplay).toBe('5 oz/gal');

    const siblingFacts = await fetchFactsForProduct(LINE_KEY, SIBLING_PRODUCT_KEY);
    expect(siblingFacts?.dilutionOzPerGal).toBe(2);
    expect(siblingFacts?.dilutionDisplay).toBe('2 oz/gal');
  });

  it('falls back to the line-wide merge when no productKey was resolved (unchanged legacy behaviour)', async () => {
    seed({
      entities: ENTITIES,
      facts: [
        factRow({ entity_id: PUSH_PRODUCT_ENTITY, product_key: PUSH_PRODUCT_KEY, dilution_oz_per_gal: 5 }),
      ],
    });

    // No productKey resolved -> same posture as fetchFactsForProductLineKey (whatever the line-wide
    // merge produces), not null just because a specific product wasn't pinned.
    const facts = await fetchFactsForProduct(LINE_KEY, null);
    expect(facts?.dilutionOzPerGal).toBe(5);
  });

  it('returns null for a resolved productKey with no fact row of its own, even if a sibling has one', async () => {
    seed({
      entities: ENTITIES,
      facts: [
        factRow({ entity_id: PUSH_PRODUCT_ENTITY, product_key: PUSH_PRODUCT_KEY, dilution_oz_per_gal: 5 }),
      ],
    });

    const siblingFacts = await fetchFactsForProduct(LINE_KEY, SIBLING_PRODUCT_KEY);
    expect(siblingFacts).toBeNull();
  });
});

describe('B0-792 fetchFactsForProductBatch pins per-request, not per-line', () => {
  it('returns different facts for two requests sharing product_line_key but different productKey', async () => {
    seed({
      entities: ENTITIES,
      facts: [
        factRow({ entity_id: PUSH_PRODUCT_ENTITY, product_key: PUSH_PRODUCT_KEY, dilution_oz_per_gal: 5 }),
        factRow({ entity_id: SIBLING_PRODUCT_ENTITY, product_key: SIBLING_PRODUCT_KEY, dilution_oz_per_gal: 2 }),
      ],
    });

    const [pushResult, siblingResult] = await fetchFactsForProductBatch([
      { productLineKey: LINE_KEY, productKey: PUSH_PRODUCT_KEY },
      { productLineKey: LINE_KEY, productKey: SIBLING_PRODUCT_KEY },
    ]);

    expect(pushResult?.dilutionOzPerGal).toBe(5);
    expect(siblingResult?.dilutionOzPerGal).toBe(2);
  });

  it('stays at two round trips total regardless of how many requests are batched', async () => {
    seed({
      entities: ENTITIES,
      facts: [
        factRow({ entity_id: PUSH_PRODUCT_ENTITY, product_key: PUSH_PRODUCT_KEY, dilution_oz_per_gal: 5 }),
        factRow({ entity_id: SIBLING_PRODUCT_ENTITY, product_key: SIBLING_PRODUCT_KEY, dilution_oz_per_gal: 2 }),
      ],
    });

    await fetchFactsForProductBatch([
      { productLineKey: LINE_KEY, productKey: PUSH_PRODUCT_KEY },
      { productLineKey: LINE_KEY, productKey: SIBLING_PRODUCT_KEY },
      { productLineKey: LINE_KEY, productKey: null },
    ]);

    expect(supa.fromCalls).toEqual(['entity', 'entity', 'product_line_fact', 'product_efficacy']);
  });

  it('returns an empty array for an empty request list without querying', async () => {
    seed({});
    expect(await fetchFactsForProductBatch([])).toEqual([]);
    expect(supa.fromCalls).toEqual([]);
  });
});
