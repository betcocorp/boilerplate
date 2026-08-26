import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-487 — the mapper tests below (`fromProductAliasRow`) were the only coverage this repository
 * had. The four mutating/querying functions (`listUnverifiedProductAliasesForReview`,
 * `approveProductAlias`, `editProductAlias`, `rejectProductAlias`) had zero automated coverage —
 * their correctness rested on a single manual smoke test from 2026-08-17. This suite exercises
 * the real repository logic against a faked Supabase client (same pattern as
 * `~/lib/rag/entity-context.test.ts`), mocked at the `getSupabaseServiceRoleClient()` boundary.
 */

vi.mock('~/supabase/clients/service-role', () => ({ getSupabaseServiceRoleClient: vi.fn() }));

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import {
  approveProductAlias,
  editProductAlias,
  fromProductAliasRow,
  listUnverifiedProductAliasesForReview,
  rejectProductAlias,
} from '~/lib/rag/product-alias-review-repository';

type LooseRow = Record<string, unknown>;

let productAliasRows: LooseRow[] = [];
let conflictRows: LooseRow[] = [];
let entityRows: LooseRow[] = [];

/** Calls observed against `rag.product_alias`'s `select().eq(...)` (the list query's filter). */
let productAliasEqCalls: Array<{ column: string; value: unknown }> = [];
/** The most recent `update(patch).eq('id', id)` call against `rag.product_alias`. */
let lastUpdateCall: { patch: LooseRow; id: string } | null = null;
/** The most recent `delete().eq('id', id)` call against `rag.product_alias`. */
let lastDeleteCall: { id: string } | null = null;

function createProductAliasTable() {
  return {
    select() {
      return {
        eq(column: string, value: unknown) {
          productAliasEqCalls.push({ column, value });
          return Promise.resolve({
            data: productAliasRows.filter((r) => r[column] === value),
            error: null,
          });
        },
      };
    },
    update(patch: LooseRow) {
      return {
        eq(column: string, value: unknown) {
          lastUpdateCall = { patch, id: String(value) };
          return {
            select() {
              return {
                single() {
                  const row = productAliasRows.find((r) => r[column] === value);
                  if (!row) return Promise.resolve({ data: null, error: { message: 'no row' } });
                  return Promise.resolve({ data: { ...row, ...patch }, error: null });
                },
              };
            },
          };
        },
      };
    },
    delete() {
      return {
        eq(column: string, value: unknown) {
          lastDeleteCall = { id: String(value) };
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

function createConflictsTable() {
  return {
    select() {
      return {
        limit() {
          return Promise.resolve({ data: conflictRows, error: null });
        },
      };
    },
  };
}

function createEntityTable() {
  return {
    select() {
      return {
        eq(column: string, value: unknown) {
          return {
            in(inColumn: string, values: unknown[]) {
              return Promise.resolve({
                data: entityRows.filter(
                  (r) => r[column] === value && values.includes(r[inColumn]),
                ),
                error: null,
              });
            },
          };
        },
      };
    },
  };
}

const fakeSupabase = {
  schema() {
    return {
      from(table: 'product_alias' | 'product_alias_conflicts' | 'entity') {
        if (table === 'product_alias') return createProductAliasTable();
        if (table === 'product_alias_conflicts') return createConflictsTable();
        return createEntityTable();
      },
    };
  },
};

beforeEach(() => {
  productAliasRows = [];
  conflictRows = [];
  entityRows = [];
  productAliasEqCalls = [];
  lastUpdateCall = null;
  lastDeleteCall = null;
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(fakeSupabase as never);
});

describe('product alias review repository mappers (B0-487)', () => {
  it('maps a plain unverified row with no conflict', () => {
    const row = fromProductAliasRow(
      {
        id: '11111111-1111-4111-8111-111111111111',
        alias_norm: 'ge fight bact rtu',
        alias: 'GE Fight BacT RTU',
        entity_id: null,
        product_line_key: 'DBF2B1E5-FD1A-4E42-A3A5-D7C8F5C3B671',
        source: 'corpus_scan',
        confidence: '0.620', // numeric comes back as a string over PostgREST
        alias_type: 'synonym',
        verified: false,
        reviewed_by: null,
        reviewed_at: null,
        created_at: '2026-08-10T00:00:00Z',
      },
      { isConflict: false, productLineTitle: 'GE Fight BacT RTU Disinfectant', conflictingProductLines: [] },
    );

    expect(row).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      aliasNorm: 'ge fight bact rtu',
      productLineKey: 'DBF2B1E5-FD1A-4E42-A3A5-D7C8F5C3B671',
      productLineTitle: 'GE Fight BacT RTU Disinfectant',
      confidence: 0.62,
      aliasType: 'synonym',
      verified: false,
      reviewedBy: null,
      reviewedAt: null,
      isConflict: false,
      conflictingProductLines: [],
    });
  });

  it('carries conflict flags and the other product lines sharing the alias_norm', () => {
    const row = fromProductAliasRow(
      {
        id: '22222222-2222-4222-8222-222222222222',
        alias_norm: 'new mix 508',
        alias: 'New Mix 508',
        entity_id: null,
        product_line_key: 'AAAAAAAA-0000-0000-0000-000000000001',
        source: 'corpus_scan',
        confidence: 0.5,
        alias_type: 'legacy_name',
        verified: false,
        reviewed_by: null,
        reviewed_at: null,
        created_at: '2026-08-11T00:00:00Z',
      },
      {
        isConflict: true,
        productLineTitle: 'Line A',
        conflictingProductLines: [
          { productLineKey: 'BBBBBBBB-0000-0000-0000-000000000002', title: 'Line B' },
        ],
      },
    );

    expect(row.isConflict).toBe(true);
    expect(row.conflictingProductLines).toEqual([
      { productLineKey: 'BBBBBBBB-0000-0000-0000-000000000002', title: 'Line B' },
    ]);
  });

  it('coerces a reviewed row (post-approval) with reviewer fields populated', () => {
    const row = fromProductAliasRow(
      {
        id: '33333333-3333-4333-8333-333333333333',
        alias_norm: 'ph7q',
        alias: 'pH7Q',
        entity_id: null,
        product_line_key: 'FBDC9386-AA70-4DD1-9C8D-3EB46C4AFB94',
        source: 'manual',
        confidence: 1,
        alias_type: 'acronym',
        verified: true,
        reviewed_by: 'tbird@betco.com',
        reviewed_at: '2026-08-16T12:00:00Z',
        created_at: '2026-08-01T00:00:00Z',
      },
      { isConflict: false, productLineTitle: null, conflictingProductLines: [] },
    );

    expect(row.verified).toBe(true);
    expect(row.reviewedBy).toBe('tbird@betco.com');
    expect(row.reviewedAt).toBe('2026-08-16T12:00:00Z');
  });
});

describe('approveProductAlias (B0-487)', () => {
  it('sets verified=true, stamps reviewed_by/reviewed_at, and targets the given id', async () => {
    productAliasRows = [
      {
        id: '44444444-4444-4444-8444-444444444444',
        alias_norm: 'foo bar',
        product_line_key: 'AAAAAAAA-0000-0000-0000-000000000001',
        verified: false,
        reviewed_by: null,
        reviewed_at: null,
      },
    ];

    const result = await approveProductAlias('44444444-4444-4444-8444-444444444444', 'tbird@betco.com');

    expect(lastUpdateCall).not.toBeNull();
    expect(lastUpdateCall!.id).toBe('44444444-4444-4444-8444-444444444444');
    expect(lastUpdateCall!.patch).toMatchObject({
      verified: true,
      reviewed_by: 'tbird@betco.com',
    });
    expect(typeof lastUpdateCall!.patch.reviewed_at).toBe('string');
    expect(lastUpdateCall!.patch.reviewed_at).not.toBeNull();

    expect(result).toEqual({
      id: '44444444-4444-4444-8444-444444444444',
      verified: true,
      reviewedBy: 'tbird@betco.com',
      reviewedAt: lastUpdateCall!.patch.reviewed_at,
    });
  });
});

describe('editProductAlias (B0-487)', () => {
  it('changing only alias_type does not blank product_line_key in the update payload', async () => {
    productAliasRows = [
      {
        id: '55555555-5555-4555-8555-555555555555',
        product_line_key: 'AAAAAAAA-0000-0000-0000-000000000001',
        alias_type: 'synonym',
      },
    ];

    await editProductAlias('55555555-5555-4555-8555-555555555555', { aliasType: 'acronym' });

    expect(lastUpdateCall).not.toBeNull();
    expect(lastUpdateCall!.id).toBe('55555555-5555-4555-8555-555555555555');
    expect(Object.keys(lastUpdateCall!.patch)).toEqual(['alias_type']);
    expect(lastUpdateCall!.patch).toEqual({ alias_type: 'acronym' });
  });

  it('changing only product_line_key does not touch alias_type in the update payload', async () => {
    productAliasRows = [
      {
        id: '66666666-6666-4666-8666-666666666666',
        product_line_key: 'AAAAAAAA-0000-0000-0000-000000000001',
        alias_type: 'synonym',
      },
    ];

    await editProductAlias('66666666-6666-4666-8666-666666666666', {
      productLineKey: 'BBBBBBBB-0000-0000-0000-000000000002',
    });

    expect(lastUpdateCall!.id).toBe('66666666-6666-4666-8666-666666666666');
    expect(Object.keys(lastUpdateCall!.patch)).toEqual(['product_line_key']);
    expect(lastUpdateCall!.patch).toEqual({ product_line_key: 'BBBBBBBB-0000-0000-0000-000000000002' });
  });

  it('changing both fields includes both in the update payload', async () => {
    productAliasRows = [
      {
        id: '77777777-7777-4777-8777-777777777777',
        product_line_key: 'AAAAAAAA-0000-0000-0000-000000000001',
        alias_type: 'synonym',
      },
    ];

    await editProductAlias('77777777-7777-4777-8777-777777777777', {
      productLineKey: 'BBBBBBBB-0000-0000-0000-000000000002',
      aliasType: 'misspelling',
    });

    expect(lastUpdateCall!.patch).toEqual({
      product_line_key: 'BBBBBBBB-0000-0000-0000-000000000002',
      alias_type: 'misspelling',
    });
  });
});

describe('rejectProductAlias (B0-487)', () => {
  it('issues a delete against the given id and does not update the row instead', async () => {
    await rejectProductAlias('88888888-8888-4888-8888-888888888888');

    expect(lastDeleteCall).toEqual({ id: '88888888-8888-4888-8888-888888888888' });
    // Pin the destructive-by-design behavior: reject must never resolve to an update call.
    expect(lastUpdateCall).toBeNull();
  });
});

describe('listUnverifiedProductAliasesForReview (B0-487)', () => {
  /**
   * Mirrors the live shape reported in rag.product_alias_conflicts (2026-08-25 spot check):
   * "ph7q" is one of 4 alias_norm values with a real conflict (2 distinct product_line_key rows).
   * Row ids/keys below are synthetic UUID-shaped placeholders, not real data.
   */
  const conflictRowNewer = {
    id: 'aaaaaaaa-1111-4111-8111-000000000001',
    alias_norm: 'ph7q',
    alias: 'pH7Q',
    entity_id: null,
    product_line_key: 'AAAAAAAA-0000-0000-0000-000000000001',
    source: 'corpus_scan',
    confidence: 0.7,
    alias_type: 'acronym',
    verified: false,
    reviewed_by: null,
    reviewed_at: null,
    created_at: '2026-08-20T00:00:00Z',
  };
  const conflictRowOlder = {
    id: 'aaaaaaaa-1111-4111-8111-000000000002',
    alias_norm: 'ph7q',
    alias: 'pH7Q',
    entity_id: null,
    product_line_key: 'BBBBBBBB-0000-0000-0000-000000000002',
    source: 'corpus_scan',
    confidence: 0.7,
    alias_type: 'acronym',
    verified: false,
    reviewed_by: null,
    reviewed_at: null,
    created_at: '2026-08-10T00:00:00Z',
  };
  const nonConflictOldest = {
    id: 'aaaaaaaa-1111-4111-8111-000000000003',
    alias_norm: 'foobar',
    alias: 'Foobar',
    entity_id: null,
    product_line_key: 'CCCCCCCC-0000-0000-0000-000000000003',
    source: 'manual',
    confidence: 0.9,
    alias_type: 'common_name',
    verified: false,
    reviewed_by: null,
    reviewed_at: null,
    created_at: '2026-08-01T00:00:00Z',
  };
  const nonConflictNewer = {
    id: 'aaaaaaaa-1111-4111-8111-000000000004',
    alias_norm: 'bazqux',
    alias: 'Bazqux',
    entity_id: null,
    product_line_key: 'DDDDDDDD-0000-0000-0000-000000000004',
    source: 'manual',
    confidence: 0.9,
    alias_type: 'common_name',
    verified: false,
    reviewed_by: null,
    reviewed_at: null,
    created_at: '2026-08-05T00:00:00Z',
  };
  const alreadyVerified = {
    id: 'aaaaaaaa-1111-4111-8111-000000000005',
    alias_norm: 'already reviewed',
    alias: 'Already Reviewed',
    entity_id: null,
    product_line_key: 'EEEEEEEE-0000-0000-0000-000000000005',
    source: 'manual',
    confidence: 0.9,
    alias_type: 'common_name',
    verified: true,
    reviewed_by: 'tbird@betco.com',
    reviewed_at: '2026-08-02T00:00:00Z',
    created_at: '2026-08-02T00:00:00Z',
  };

  beforeEach(() => {
    productAliasRows = [
      conflictRowNewer,
      conflictRowOlder,
      nonConflictOldest,
      nonConflictNewer,
      alreadyVerified,
    ];
    conflictRows = [
      { alias_norm: 'ph7q', product_line_key: 'AAAAAAAA-0000-0000-0000-000000000001' },
      { alias_norm: 'ph7q', product_line_key: 'BBBBBBBB-0000-0000-0000-000000000002' },
    ];
    entityRows = [
      {
        entity_type: 'product_line',
        product_line_key: 'AAAAAAAA-0000-0000-0000-000000000001',
        title: 'Line A Title',
      },
      {
        entity_type: 'product_line',
        product_line_key: 'BBBBBBBB-0000-0000-0000-000000000002',
        title: 'Line B Title',
      },
    ];
  });

  it('filters to verified=false, excluding already-verified rows', async () => {
    const result = await listUnverifiedProductAliasesForReview({ page: 1, pageSize: 25 });

    expect(productAliasEqCalls).toContainEqual({ column: 'verified', value: false });
    expect(result.total).toBe(4);
    expect(result.items.map((i) => i.id)).not.toContain(alreadyVerified.id);
  });

  it('sorts conflict rows first, then oldest-first within each conflict status, and attaches conflictingProductLines', async () => {
    const result = await listUnverifiedProductAliasesForReview({ page: 1, pageSize: 25 });

    expect(result.items.map((i) => i.id)).toEqual([
      conflictRowOlder.id, // conflict, oldest
      conflictRowNewer.id, // conflict, newer
      nonConflictOldest.id, // non-conflict, oldest
      nonConflictNewer.id, // non-conflict, newer
    ]);

    const [olderConflict, newerConflict, oldestNonConflict, newerNonConflict] = result.items;

    expect(olderConflict.isConflict).toBe(true);
    expect(olderConflict.conflictingProductLines).toEqual([
      { productLineKey: 'AAAAAAAA-0000-0000-0000-000000000001', title: 'Line A Title' },
    ]);

    expect(newerConflict.isConflict).toBe(true);
    expect(newerConflict.conflictingProductLines).toEqual([
      { productLineKey: 'BBBBBBBB-0000-0000-0000-000000000002', title: 'Line B Title' },
    ]);

    expect(oldestNonConflict.isConflict).toBe(false);
    expect(oldestNonConflict.conflictingProductLines).toEqual([]);
    expect(newerNonConflict.isConflict).toBe(false);
    expect(newerNonConflict.conflictingProductLines).toEqual([]);
  });

  it('honours pagination arguments (page/pageSize) against the same sorted set', async () => {
    const page1 = await listUnverifiedProductAliasesForReview({ page: 1, pageSize: 2 });
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(2);
    expect(page1.total).toBe(4);
    expect(page1.items.map((i) => i.id)).toEqual([conflictRowOlder.id, conflictRowNewer.id]);

    const page2 = await listUnverifiedProductAliasesForReview({ page: 2, pageSize: 2 });
    expect(page2.page).toBe(2);
    expect(page2.pageSize).toBe(2);
    expect(page2.total).toBe(4);
    expect(page2.items.map((i) => i.id)).toEqual([nonConflictOldest.id, nonConflictNewer.id]);
  });
});
