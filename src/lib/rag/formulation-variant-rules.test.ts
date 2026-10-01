import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-486 — coverage for the executable form of
 * `src/docs/formulation-variant-aliasing-rules.md`.
 *
 * Fixtures are the real pH7Q family shape, transcribed exactly as stored in
 * `rag.product_line_fact` (verified live 2026-08-26): three distinct `product_line_key`s where
 * pH7Q and pH7Q Ultra disagree on EPA registration, contact time and dilution, and pH7Q Dual has
 * no product-tier fact row at all. Numeric columns are strings in the fixtures because PostgREST
 * returns `numeric` as text — that is exactly why `0.500` must stay `0.500`.
 *
 * The faked Supabase client follows `~/lib/rag/entity-context.test.ts`: the real rule logic runs
 * against fixture rows rather than being mocked out, so a regression in the decision table or the
 * `entity_id` join path is caught here.
 */

vi.mock('~/supabase/clients/service-role', () => ({ getSupabaseServiceRoleClient: vi.fn() }));

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import {
  decideFormulationVariantMerge,
  evaluateAliasFormulationVariantMerge,
  fetchProductLineFormulationFacts,
} from '~/lib/rag/formulation-variant-rules';

const PH7Q = 'FBDC9386-AA70-4DD1-9C8D-3EB46C4AFB94';
const ULTRA = '168549A1-B75F-4D00-B5C1-087A95C317D9';
const DUAL = '69171DB7-F490-4C87-A67E-C1F928768D68';

type LooseRow = Record<string, unknown>;

let entityRows: LooseRow[] = [];
let factRows: LooseRow[] = [];
let aliasRows: LooseRow[] = [];
/** Every filter the code under test applied, so the join path itself can be asserted. */
let observedFilters: Array<{ table: string; kind: 'eq' | 'in'; column: string }> = [];

function tableRows(table: string): LooseRow[] {
  if (table === 'entity') return entityRows;
  if (table === 'product_line_fact') return factRows;
  return aliasRows;
}

function createQueryBuilder(table: string) {
  const predicates: Array<(row: LooseRow) => boolean> = [];
  const builder = {
    eq(column: string, value: unknown) {
      observedFilters.push({ table, kind: 'eq', column });
      predicates.push((row) => row[column] === value);
      return builder;
    },
    in(column: string, values: unknown[]) {
      observedFilters.push({ table, kind: 'in', column });
      predicates.push((row) => values.includes(row[column]));
      return builder;
    },
    limit(n: number) {
      const rows = tableRows(table).filter((row) => predicates.every((p) => p(row)));
      return Promise.resolve({ data: rows.slice(0, n), error: null });
    },
  };
  return builder;
}

const fakeSupabase = {
  schema() {
    return {
      from(table: string) {
        return { select: () => createQueryBuilder(table) };
      },
    };
  },
};

/** The pH7Q family exactly as stored — nothing rounded, converted or re-formatted. */
function seedPh7qFamily() {
  entityRows = [
    { id: 'ent-ph7q-line', product_line_key: PH7Q, entity_type: 'product_line', title: 'Neutral pH disinfectant' },
    { id: 'ent-ph7q-31604', product_line_key: PH7Q, entity_type: 'product', product_key: '31604', title: 'pH7Q' },
    { id: 'ent-ph7q-31612', product_line_key: PH7Q, entity_type: 'product', product_key: '31612', title: 'pH7Q Sample' },
    { id: 'ent-ultra-line', product_line_key: ULTRA, entity_type: 'product_line', title: 'Concentrated Neutral Disinfectant Cleaner' },
    { id: 'ent-ultra-32504', product_line_key: ULTRA, entity_type: 'product', product_key: '32504', title: 'pH7Q Ultra' },
    { id: 'ent-dual-line', product_line_key: DUAL, entity_type: 'product_line', title: 'Concentrated Neutral Disinfectant Cleaner' },
    // One of Dual's 10 product entities — deliberately has no product_line_fact row.
    { id: 'ent-dual-prod-1', product_line_key: DUAL, entity_type: 'product', product_key: '3151700', title: 'pH7Q Dual' },
  ];
  factRows = [
    { entity_id: 'ent-ph7q-31604', epa_registration: '47371-131-4170', contact_time_seconds: 60, dilution_display: '1:64', dilution_oz_per_gal: null },
    { entity_id: 'ent-ph7q-31612', epa_registration: '47371-131-4170', contact_time_seconds: 60, dilution_display: '1:64', dilution_oz_per_gal: null },
    { entity_id: 'ent-ph7q-line', epa_registration: null, contact_time_seconds: null, dilution_display: '1:64', dilution_oz_per_gal: '2.000' },
    { entity_id: 'ent-ultra-32504', epa_registration: '47371-129-4170', contact_time_seconds: 120, dilution_display: '1:256', dilution_oz_per_gal: null },
    { entity_id: 'ent-ultra-line', epa_registration: null, contact_time_seconds: null, dilution_display: '1:256', dilution_oz_per_gal: '0.5' },
    { entity_id: 'ent-dual-line', epa_registration: null, contact_time_seconds: null, dilution_display: '1:256', dilution_oz_per_gal: '0.500' },
  ];
  // B0-485 seeds the bare acronym as three separate verified rows — a deliberate 3-way ambiguity.
  aliasRows = [
    { id: 'alias-ph7q', alias: 'pH7Q', alias_norm: 'ph7q', product_line_key: PH7Q },
    { id: 'alias-ultra', alias: 'pH7Q', alias_norm: 'ph7q', product_line_key: ULTRA },
    { id: 'alias-dual', alias: 'pH7Q', alias_norm: 'ph7q', product_line_key: DUAL },
  ];
}

beforeEach(() => {
  entityRows = [];
  factRows = [];
  aliasRows = [];
  observedFilters = [];
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(fakeSupabase as never);
});

describe('fetchProductLineFormulationFacts — join path (B0-486)', () => {
  it('reaches facts through rag.entity.id = product_line_fact.entity_id, never product_key', async () => {
    seedPh7qFamily();

    const facts = await fetchProductLineFormulationFacts([PH7Q]);

    // The product_line-tier fact row has product_key = null, so a product_key join would lose it;
    // the SKU-tier rows carry the EPA registration, which a product_line-only join would lose.
    expect(observedFilters).toEqual([
      { table: 'entity', kind: 'in', column: 'product_line_key' },
      { table: 'product_line_fact', kind: 'in', column: 'entity_id' },
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      productLineKey: PH7Q,
      productLineTitle: 'Neutral pH disinfectant',
      entityCount: 3,
      factRowCount: 3,
    });
  });

  it('preserves stored regulated values digit-for-digit', async () => {
    seedPh7qFamily();

    const [ph7q, ultra, dual] = await fetchProductLineFormulationFacts([PH7Q, ULTRA, DUAL]);

    expect(ph7q.factsByField).toEqual([
      { field: 'epa_registration', values: ['47371-131-4170'] },
      { field: 'dilution_display', values: ['1:64'] },
      // "2.000" is kept exactly as stored — not normalized to "2".
      { field: 'dilution_oz_per_gal', values: ['2.000'] },
      { field: 'contact_time_seconds', values: ['60'] },
    ]);
    expect(ultra.factsByField).toEqual([
      { field: 'epa_registration', values: ['47371-129-4170'] },
      { field: 'dilution_display', values: ['1:256'] },
      { field: 'dilution_oz_per_gal', values: ['0.5'] },
      { field: 'contact_time_seconds', values: ['120'] },
    ]);
    // Dual's only fact row is product_line-tier: no EPA registration, no contact time.
    expect(dual.factsByField).toEqual([
      { field: 'epa_registration', values: [] },
      { field: 'dilution_display', values: ['1:256'] },
      { field: 'dilution_oz_per_gal', values: ['0.500'] },
      { field: 'contact_time_seconds', values: [] },
    ]);
  });

  it('returns a zero-fact record for a product_line_key with no rag.entity row', async () => {
    seedPh7qFamily();

    const [orphan] = await fetchProductLineFormulationFacts(['NO-SUCH-LINE-KEY']);

    expect(orphan).toMatchObject({ entityCount: 0, factRowCount: 0, productLineTitle: null });
  });
});

describe('decideFormulationVariantMerge — disagree branch (B0-486)', () => {
  it('blocks pH7Q vs pH7Q Ultra and reports every disagreeing field with exact values', async () => {
    seedPh7qFamily();
    const facts = await fetchProductLineFormulationFacts([PH7Q, ULTRA]);

    const decision = decideFormulationVariantMerge({ aliasNorm: 'ph7q', facts });

    expect(decision.verdict).toBe('must_not_merge');
    expect(decision.dataGaps).toEqual([]);
    expect(decision.disagreements.map((d) => d.field)).toEqual([
      'epa_registration',
      'dilution_display',
      'dilution_oz_per_gal',
      'contact_time_seconds',
    ]);
    const epa = decision.disagreements.find((d) => d.field === 'epa_registration');
    expect(epa?.byProductLine).toEqual([
      { productLineKey: PH7Q, productLineTitle: 'Neutral pH disinfectant', values: ['47371-131-4170'] },
      {
        productLineKey: ULTRA,
        productLineTitle: 'Concentrated Neutral Disinfectant Cleaner',
        values: ['47371-129-4170'],
      },
    ]);
    expect(decision.reason).toContain('47371-131-4170');
    expect(decision.reason).toContain('47371-129-4170');
  });
});

describe('decideFormulationVariantMerge — insufficient-data branch (B0-486)', () => {
  it('blocks pH7Q Ultra vs pH7Q Dual and flags Dual as a regulated-data gap', async () => {
    seedPh7qFamily();
    const facts = await fetchProductLineFormulationFacts([ULTRA, DUAL]);

    const decision = decideFormulationVariantMerge({ aliasNorm: 'ph7q', facts });

    expect(decision.verdict).toBe('insufficient_data');
    expect(decision.disagreements).toEqual([]);
    expect(decision.dataGaps).toEqual([
      {
        productLineKey: DUAL,
        productLineTitle: 'Concentrated Neutral Disinfectant Cleaner',
        hasAnyFactRow: true,
        missingFields: ['epa_registration', 'contact_time_seconds'],
      },
    ]);
    // The shared "1:256" dilution display must never be read as evidence they are the same
    // formulation — a naked dilution match with no EPA registration on one side is exactly the
    // inference the regulated-data rule prohibits.
    expect(decision.reason).toContain('Do not infer the missing values');
  });

  it('blocks a candidate line that has no product_line_fact row at all', async () => {
    seedPh7qFamily();
    const facts = await fetchProductLineFormulationFacts([PH7Q, 'NO-SUCH-LINE-KEY']);

    const decision = decideFormulationVariantMerge({ aliasNorm: 'ph7q', facts });

    expect(decision.verdict).toBe('insufficient_data');
    expect(decision.dataGaps[0]).toMatchObject({
      productLineKey: 'NO-SUCH-LINE-KEY',
      hasAnyFactRow: false,
    });
  });
});

describe('decideFormulationVariantMerge — agree branch (B0-486)', () => {
  it('permits a shared alias when EPA registration and dilution match exactly', async () => {
    entityRows = [
      { id: 'ent-a', product_line_key: 'LINE-A', entity_type: 'product_line', title: 'Line A' },
      { id: 'ent-b', product_line_key: 'LINE-B', entity_type: 'product_line', title: 'Line B' },
    ];
    factRows = [
      { entity_id: 'ent-a', epa_registration: '47371-131-4170', contact_time_seconds: 60, dilution_display: '1:64', dilution_oz_per_gal: '2.000' },
      { entity_id: 'ent-b', epa_registration: '47371-131-4170', contact_time_seconds: 60, dilution_display: '1:64', dilution_oz_per_gal: '2.000' },
    ];
    const facts = await fetchProductLineFormulationFacts(['LINE-A', 'LINE-B']);

    const decision = decideFormulationVariantMerge({ aliasNorm: 'shared', facts });

    expect(decision.verdict).toBe('may_merge');
    expect(decision.disagreements).toEqual([]);
    expect(decision.dataGaps).toEqual([]);
    expect(decision.reason).toContain('Reviewer confirmation is still required');
  });

  it('treats an equal-value-but-different-precision dilution as a disagreement, not a match', async () => {
    entityRows = [
      { id: 'ent-a', product_line_key: 'LINE-A', entity_type: 'product_line', title: 'Line A' },
      { id: 'ent-b', product_line_key: 'LINE-B', entity_type: 'product_line', title: 'Line B' },
    ];
    factRows = [
      { entity_id: 'ent-a', epa_registration: '47371-131-4170', contact_time_seconds: 60, dilution_display: '1:256', dilution_oz_per_gal: '0.5' },
      { entity_id: 'ent-b', epa_registration: '47371-131-4170', contact_time_seconds: 60, dilution_display: '1:256', dilution_oz_per_gal: '0.500' },
    ];
    const facts = await fetchProductLineFormulationFacts(['LINE-A', 'LINE-B']);

    const decision = decideFormulationVariantMerge({ aliasNorm: 'shared', facts });

    expect(decision.verdict).toBe('must_not_merge');
    expect(decision.disagreements.map((d) => d.field)).toEqual(['dilution_oz_per_gal']);
  });

  it('does not apply the rule when the alias maps to a single product line', async () => {
    seedPh7qFamily();
    const facts = await fetchProductLineFormulationFacts([PH7Q]);

    const decision = decideFormulationVariantMerge({ aliasNorm: 'ph7q neutral disinfectant', facts });

    expect(decision.verdict).toBe('may_merge');
    expect(decision.reason).toContain('single product line');
  });
});

describe('evaluateAliasFormulationVariantMerge (B0-486)', () => {
  it('resolves every product line sharing the alias_norm and blocks the 3-way pH7Q alias', async () => {
    seedPh7qFamily();

    const decision = await evaluateAliasFormulationVariantMerge('alias-ph7q');

    expect(decision.alias).toBe('pH7Q');
    expect(decision.productLineKeys).toEqual([PH7Q, ULTRA, DUAL]);
    // A definitive disagreement outranks the data gap, but the gap is still reported.
    expect(decision.verdict).toBe('must_not_merge');
    expect(decision.dataGaps.map((g) => g.productLineKey)).toEqual([DUAL]);
  });

  it('clears an alias_norm that maps to only one product line', async () => {
    seedPh7qFamily();
    aliasRows = [
      { id: 'alias-solo', alias: 'pH7Q Ultra', alias_norm: 'ph7q ultra', product_line_key: ULTRA },
    ];

    const decision = await evaluateAliasFormulationVariantMerge('alias-solo');

    expect(decision.verdict).toBe('may_merge');
    expect(decision.productLineKeys).toEqual([ULTRA]);
  });

  it('throws when the alias row does not exist', async () => {
    seedPh7qFamily();

    await expect(evaluateAliasFormulationVariantMerge('missing-alias')).rejects.toThrow(
      /alias missing-alias not found/,
    );
  });
});

describe('blocked-approval reason (B0-486)', () => {
  it('quotes the exact stored values, which is what the reviewer is shown', async () => {
    seedPh7qFamily();
    const decision = await evaluateAliasFormulationVariantMerge('alias-ph7q');

    // `decision.reason` is surfaced verbatim by AliasReviewRowPanel when the guard blocks an
    // approval, so the exact regulated values must survive into it un-rounded and unconverted.
    expect(decision.verdict).toBe('must_not_merge');
    expect(decision.alias).toBe('pH7Q');
    expect(decision.reason).toContain('47371-131-4170');
    expect(decision.reason).toContain('1:64');
  });
});
