import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-634 — tier-aware product-fact resolution with an agree-or-abstain merge.
 *
 * Deterministic (mocked-Supabase) coverage of the merge rules themselves. The live-data
 * counterparts ("Push" really does hold dilution_oz_per_gal = 5 on its product tier, "Super
 * Concentrated Industrial Degreaser" really does have two disagreeing product-tier dilutions) live
 * in b0257-regulated-data-retrieval.test.ts alongside the other live-DB fact assertions.
 *
 * Row shapes below mirror rag.product_line_fact / rag.product_efficacy exactly; every regulated
 * value is used verbatim, never rounded or converted.
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

import { fetchFactsForProductLineKey, fetchFactsForProductLineKeys } from '~/lib/retrieval/product-facts';

const LINE_KEY = 'F831DAC3-288E-4013-AE36-D0141F8F94F1';
const LINE_ENTITY = 'line-entity-1';

type EntityRow = { id: string; entity_type: string; product_line_key: string | null };

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

function efficacyRow(overrides: Record<string, unknown>) {
  return {
    entity_id: LINE_ENTITY,
    organism: 'Staphylococcus aureus',
    claim_type: 'bactericidal',
    dilution_oz_per_gal: null,
    contact_time_seconds: null,
    epa_registration: null,
    confidence: 1,
    ...overrides,
  };
}

function seed(options: {
  entities?: EntityRow[];
  facts?: unknown[];
  efficacy?: unknown[];
  entityError?: unknown;
  factError?: unknown;
}) {
  supa.tables = {
    entity: { data: options.entities ?? [], error: options.entityError ?? null },
    product_line_fact: { data: options.facts ?? [], error: options.factError ?? null },
    product_efficacy: { data: options.efficacy ?? [], error: null },
  };
}

/** Line-tier anchor + two product-tier SKUs, the real "Push" topology. */
const PUSH_ENTITIES: EntityRow[] = [
  { id: LINE_ENTITY, entity_type: 'product_line', product_line_key: LINE_KEY },
  { id: 'push-13304', entity_type: 'product', product_line_key: LINE_KEY },
  { id: 'push-260804', entity_type: 'product', product_line_key: LINE_KEY },
];

beforeEach(() => {
  supa.tables = {};
  supa.fromCalls = [];
});

describe('B0-634 product-tier scalars fill line-tier nulls', () => {
  it('adopts an agreed product-tier dilution the line tier leaves null (the "Push" bug)', async () => {
    seed({
      entities: PUSH_ENTITIES,
      facts: [
        factRow({ coverage_sq_ft: 3200, product_application: 'drain-maintenance', product_application_confidence: 0.7 }),
        factRow({ entity_id: 'push-13304', product_key: '13304', dilution_oz_per_gal: 5 }),
        factRow({ entity_id: 'push-260804', product_key: '260804', dilution_oz_per_gal: 5 }),
      ],
    });

    const facts = await fetchFactsForProductLineKey(LINE_KEY);
    expect(facts?.dilutionOzPerGal).toBe(5);
    // line-tier values are untouched
    expect(facts?.coverageSqFt).toBe(3200);
    expect(facts?.productApplication).toBe('drain-maintenance');
    // the block still reports the line-tier entity id, so title lookups keep working
    expect(facts?.entityId).toBe(LINE_ENTITY);
    expect(facts?.confidence).toBe(1);
  });

  it('adopts a lone product-tier EPA registration and contact time verbatim', async () => {
    seed({
      entities: PUSH_ENTITIES,
      facts: [
        factRow({ dilution_display: '1:256' }),
        factRow({
          entity_id: 'push-13304',
          product_key: '13304',
          epa_registration: '47371-131-4170',
          contact_time_seconds: 60,
        }),
      ],
    });

    const facts = await fetchFactsForProductLineKey(LINE_KEY);
    expect(facts?.epaRegistration).toBe('47371-131-4170');
    expect(facts?.contactTimeSeconds).toBe(60);
    expect(facts?.dilutionDisplay).toBe('1:256');
  });

  it('treats two spellings of the same stored numeric as agreement and returns it unreformatted', async () => {
    seed({
      entities: PUSH_ENTITIES,
      facts: [
        factRow({ coverage_sq_ft: 3200 }),
        // Postgres numeric can surface as a string; 5 and 5.000 are the same stored number.
        factRow({ entity_id: 'push-13304', product_key: '13304', dilution_oz_per_gal: '5.000' }),
        factRow({ entity_id: 'push-260804', product_key: '260804', dilution_oz_per_gal: 5 }),
      ],
    });

    const facts = await fetchFactsForProductLineKey(LINE_KEY);
    expect(facts?.dilutionOzPerGal).toBe('5.000'); // exactly as stored, not reformatted
  });

  it('never lets a lower-confidence product-tier row overstate the block confidence', async () => {
    seed({
      entities: PUSH_ENTITIES,
      facts: [
        factRow({ coverage_sq_ft: 3200, confidence: 1 }),
        factRow({ entity_id: 'push-13304', product_key: '13304', dilution_oz_per_gal: 13, confidence: 0.9 }),
      ],
    });

    const facts = await fetchFactsForProductLineKey(LINE_KEY);
    expect(facts?.dilutionOzPerGal).toBe(13);
    expect(facts?.confidence).toBe(0.9);
  });

  it('carries the classifier confidence that came with an adopted product_application', async () => {
    seed({
      entities: PUSH_ENTITIES,
      facts: [
        factRow({ coverage_sq_ft: 3200 }),
        factRow({
          entity_id: 'push-13304',
          product_key: '13304',
          product_application: 'drain-maintenance',
          product_application_confidence: 0.7,
        }),
      ],
    });

    const facts = await fetchFactsForProductLineKey(LINE_KEY);
    expect(facts?.productApplication).toBe('drain-maintenance');
    expect(facts?.productApplicationConfidence).toBe(0.7);
  });
});

describe('B0-634 disagreeing product-tier values abstain (regulated-data rule)', () => {
  it('leaves dilution null when product-tier SKUs disagree — never picks one, never averages', async () => {
    seed({
      entities: PUSH_ENTITIES,
      facts: [
        factRow({ coverage_sq_ft: 3200 }),
        factRow({ entity_id: 'push-13304', product_key: '13304', dilution_oz_per_gal: 5 }),
        factRow({ entity_id: 'push-260804', product_key: '260804', dilution_oz_per_gal: 7 }),
      ],
    });

    const facts = await fetchFactsForProductLineKey(LINE_KEY);
    expect(facts).not.toBeNull();
    expect(facts?.dilutionOzPerGal).toBeNull();
    expect(facts?.coverageSqFt).toBe(3200);
  });

  it('leaves EPA registration and contact time null when the tiers disagree (pH7Q-family shape)', async () => {
    seed({
      entities: PUSH_ENTITIES,
      facts: [
        factRow({ dilution_display: '1:64' }),
        factRow({
          entity_id: 'push-13304',
          product_key: '13304',
          epa_registration: '47371-131-4170',
          contact_time_seconds: 60,
        }),
        factRow({
          entity_id: 'push-260804',
          product_key: '260804',
          epa_registration: '47371-129-4170',
          contact_time_seconds: 120,
        }),
      ],
    });

    const facts = await fetchFactsForProductLineKey(LINE_KEY);
    expect(facts?.epaRegistration).toBeNull();
    expect(facts?.contactTimeSeconds).toBeNull();
  });

  it('does not coerce a dilution_display string into equivalence with a dilution_oz_per_gal number', async () => {
    seed({
      entities: PUSH_ENTITIES,
      facts: [
        factRow({ coverage_sq_ft: 3200 }),
        factRow({ entity_id: 'push-13304', product_key: '13304', dilution_display: '1:64' }),
        factRow({ entity_id: 'push-260804', product_key: '260804', dilution_display: '2.000' }),
      ],
    });

    const facts = await fetchFactsForProductLineKey(LINE_KEY);
    // Different display strings for the same field -> disagreement -> abstain.
    expect(facts?.dilutionDisplay).toBeNull();
    // ...and the numeric column stays null too: nothing was derived from the display strings.
    expect(facts?.dilutionOzPerGal).toBeNull();
  });

  it('keeps the line-tier value when the product tier disagrees with it', async () => {
    seed({
      entities: PUSH_ENTITIES,
      facts: [
        factRow({ dilution_display: '13 oz./gal.', dilution_oz_per_gal: 13, confidence: 0.75 }),
        factRow({ entity_id: 'push-13304', product_key: '13304', dilution_display: '1:3' }),
        factRow({ entity_id: 'push-260804', product_key: '260804', dilution_display: 'Normal stripping — 1:10' }),
      ],
    });

    const facts = await fetchFactsForProductLineKey(LINE_KEY);
    expect(facts?.dilutionDisplay).toBe('13 oz./gal.');
    expect(facts?.dilutionOzPerGal).toBe(13);
    expect(facts?.confidence).toBe(0.75); // nothing adopted -> confidence untouched
  });

  it('keeps a line-tier value even when every product-tier row agrees on a different one', async () => {
    seed({
      entities: PUSH_ENTITIES,
      facts: [
        factRow({ dilution_oz_per_gal: 2 }),
        factRow({ entity_id: 'push-13304', product_key: '13304', dilution_oz_per_gal: 5 }),
        factRow({ entity_id: 'push-260804', product_key: '260804', dilution_oz_per_gal: 5 }),
      ],
    });

    const facts = await fetchFactsForProductLineKey(LINE_KEY);
    expect(facts?.dilutionOzPerGal).toBe(2);
  });
});

describe('B0-634 efficacy is unioned across tiers, not field-merged', () => {
  it('keeps both rows when the same organism carries different contact times, and dedupes exact repeats', async () => {
    seed({
      entities: PUSH_ENTITIES,
      facts: [factRow({ coverage_sq_ft: 3200 })],
      efficacy: [
        efficacyRow({ contact_time_seconds: 60, epa_registration: '85837-4-4170' }),
        // exact repeat on the product tier -> deduped
        efficacyRow({ entity_id: 'push-13304', contact_time_seconds: 60, epa_registration: '85837-4-4170' }),
        // same organism + claim, DIFFERENT contact time -> a different claim, both survive
        efficacyRow({ entity_id: 'push-13304', contact_time_seconds: 600, epa_registration: '85837-4-4170' }),
        efficacyRow({ entity_id: 'push-260804', organism: 'Escherichia coli', contact_time_seconds: 600 }),
      ],
    });

    const facts = await fetchFactsForProductLineKey(LINE_KEY);
    expect(facts?.efficacy).toHaveLength(3);
    const staph = facts?.efficacy.filter((e) => e.organism === 'Staphylococcus aureus') ?? [];
    expect(staph.map((e) => e.contactTimeSeconds)).toEqual([60, 600]);
    expect(facts?.efficacy.some((e) => e.organism === 'Escherichia coli')).toBe(true);
  });

  it('surfaces product-tier-only kill claims for a line whose line-tier entity has none', async () => {
    seed({
      entities: PUSH_ENTITIES,
      efficacy: [
        efficacyRow({
          entity_id: 'push-13304',
          organism: 'Trichophyton mentagrophytes',
          claim_type: 'fungicidal',
          contact_time_seconds: 600,
          epa_registration: '85837-4-4170',
          confidence: 0.9,
        }),
      ],
    });

    const facts = await fetchFactsForProductLineKey(LINE_KEY);
    expect(facts?.efficacy).toHaveLength(1);
    expect(facts?.efficacy[0]?.contactTimeSeconds).toBe(600);
    expect(facts?.efficacy[0]?.epaRegistration).toBe('85837-4-4170');
    expect(facts?.efficacy[0]?.confidence).toBe(0.9);
  });

  it('still applies the organism filter across the unioned rows', async () => {
    seed({
      entities: PUSH_ENTITIES,
      facts: [factRow({ coverage_sq_ft: 3200 })],
      efficacy: [
        efficacyRow({ organism: 'Staphylococcus aureus' }),
        efficacyRow({ entity_id: 'push-13304', organism: 'Escherichia coli' }),
      ],
    });

    const facts = await fetchFactsForProductLineKey(LINE_KEY, 'coli');
    expect(facts?.efficacy.map((e) => e.organism)).toEqual(['Escherichia coli']);

    const batch = await fetchFactsForProductLineKeys([LINE_KEY], 'STAPH');
    expect(batch.get(LINE_KEY)?.efficacy.map((e) => e.organism)).toEqual(['Staphylococcus aureus']);
  });
});

describe('B0-634 "no facts" and error paths are unchanged', () => {
  it('returns null / stays absent when neither tier has any fact or efficacy row', async () => {
    seed({ entities: PUSH_ENTITIES });

    expect(await fetchFactsForProductLineKey(LINE_KEY)).toBeNull();
    expect((await fetchFactsForProductLineKeys([LINE_KEY])).has(LINE_KEY)).toBe(false);
  });

  it('returns null when the key resolves to no product_line-tier entity at all', async () => {
    seed({
      entities: [{ id: 'push-13304', entity_type: 'product', product_line_key: LINE_KEY }],
      facts: [factRow({ entity_id: 'push-13304', product_key: '13304', dilution_oz_per_gal: 5 })],
    });

    expect(await fetchFactsForProductLineKey(LINE_KEY)).toBeNull();
  });

  it('returns null for an unknown product line key', async () => {
    seed({ entities: [] });
    expect(await fetchFactsForProductLineKey('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('degrades to an empty map when the facts query errors', async () => {
    seed({ entities: PUSH_ENTITIES, factError: { message: 'boom' } });
    expect((await fetchFactsForProductLineKeys([LINE_KEY])).size).toBe(0);
  });

  it('degrades to an empty map when the entity query errors', async () => {
    seed({ entities: null as unknown as EntityRow[], entityError: { message: 'boom' } });
    expect((await fetchFactsForProductLineKeys([LINE_KEY])).size).toBe(0);
  });
});

describe('B0-634 round-trip budget', () => {
  it('stays at one entity query + one facts/efficacy query regardless of how many keys are passed', async () => {
    const keys = ['KEY-A', 'KEY-B', 'KEY-C', 'KEY-D', 'KEY-E'];
    seed({
      entities: keys.flatMap((key, i) => [
        { id: `line-${i}`, entity_type: 'product_line', product_line_key: key },
        { id: `sku-${i}-a`, entity_type: 'product', product_line_key: key },
        { id: `sku-${i}-b`, entity_type: 'product', product_line_key: key },
      ]),
      facts: keys.flatMap((_key, i) => [
        factRow({ entity_id: `line-${i}`, coverage_sq_ft: 3200 }),
        factRow({ entity_id: `sku-${i}-a`, product_key: `sku-${i}-a`, dilution_oz_per_gal: 5 }),
        factRow({ entity_id: `sku-${i}-b`, product_key: `sku-${i}-b`, dilution_oz_per_gal: 5 }),
      ]),
    });

    const result = await fetchFactsForProductLineKeys(keys);
    expect(result.size).toBe(5);
    for (const key of keys) {
      expect(result.get(key)?.dilutionOzPerGal).toBe(5);
    }
    expect(supa.fromCalls).toEqual(['entity', 'product_line_fact', 'product_efficacy']);
  });

  it('does not query at all for an empty key list', async () => {
    seed({});
    expect((await fetchFactsForProductLineKeys([])).size).toBe(0);
    expect(supa.fromCalls).toEqual([]);
  });
});
