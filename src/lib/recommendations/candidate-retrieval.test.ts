import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildRetrievalQuery,
  rankCandidates,
  resolveCandidateUrls,
  retrieveBetcoCandidates,
  type BetcoCandidate,
} from '~/lib/recommendations/candidate-retrieval';
import type { RagSearchMatch } from '~/lib/rag/search';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import type { EnrichedCompetitorSpec } from '~/lib/websearch/enrich-competitor-spec';

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

type LooseRow = Record<string, unknown>;

/**
 * B0-442 regression — mocks the `legacy.products_attr` / `legacy.products` / `legacy.products_descr`
 * chain that `resolveCandidateUrls` (the default `retrieveBetcoCandidates` dep) queries live. Any
 * `.select().ilike().in()` / `.select().in()` / `.select().eq().in()` combination resolves to the
 * canned rows for that table.
 */
function mockLegacyTables(data: {
  products_attr?: LooseRow[];
  products?: LooseRow[];
  products_descr?: LooseRow[];
}) {
  const chain = (rows: LooseRow[]) => {
    const resolved = Promise.resolve({ data: rows });
    const api = {
      in: () => resolved,
      ilike: () => api,
      eq: () => api,
    };
    return api;
  };
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    schema: () => ({
      from: (table: string) => ({
        select: () => chain(data[table as keyof typeof data] ?? []),
      }),
    }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
}

function spec(overrides: Partial<EnrichedCompetitorSpec> = {}): EnrichedCompetitorSpec {
  return {
    chemistryClass: 'quat',
    epaRegistration: null,
    contactTimeSeconds: null,
    dilutionOzPerGal: null,
    productCategory: 'disinfectant',
    primaryUse: 'surface disinfection',
    formFactor: null,
    keyClaims: ['kills 99.9% of germs'],
    manufacturer: null,
    provenance: {
      chemistryClass: null,
      epaRegistration: null,
      contactTimeSeconds: null,
      dilutionOzPerGal: null,
      productCategory: null,
      primaryUse: null,
      formFactor: null,
      keyClaims: null,
      manufacturer: null,
    },
    ...overrides,
  };
}

function match(over: Partial<RagSearchMatch> & { document_id: string; similarity: number }): RagSearchMatch {
  return {
    chunk_id: `c-${over.document_id}`,
    chunk_key: `ck-${over.document_id}`,
    chunk_index: 0,
    heading: null,
    chunk_text: 'evidence text',
    section_path: null,
    section_type: null,
    token_count: 10,
    document_key: `dk-${over.document_id}`,
    document_title: `Doc ${over.document_id}`,
    entity_id: null,
    product_key: null,
    sku: null,
    product_line_key: null,
    source_pk: null,
    document_kind: 'product_line_profile',
    ...over,
  } as RagSearchMatch;
}

const passthroughUrls = async (c: BetcoCandidate[]) => c;

describe('buildRetrievalQuery (B0-87)', () => {
  it('joins the discriminating spec fields, dropping nulls', () => {
    expect(buildRetrievalQuery(spec())).toBe('disinfectant surface disinfection quat kills 99.9% of germs');
  });
  it('is empty when the spec has nothing to search on', () => {
    expect(
      buildRetrievalQuery(
        spec({ chemistryClass: null, productCategory: null, primaryUse: null, formFactor: null, keyClaims: [] }),
      ),
    ).toBe('');
  });
});

describe('rankCandidates (B0-87)', () => {
  it('dedupes by product key keeping the max similarity, ordered desc, limited', () => {
    const ranked = rankCandidates(
      [
        match({ document_id: 'd1', similarity: 0.7, product_line_key: 'L1' }),
        match({ document_id: 'd2', similarity: 0.9, product_line_key: 'L1' }), // same line, higher
        match({ document_id: 'd3', similarity: 0.8, product_line_key: 'L2' }),
        match({ document_id: 'd4', similarity: 0.6, product_line_key: 'L3' }),
      ],
      2,
    );
    expect(ranked.map((c) => c.betcoProductLineKey)).toEqual(['L1', 'L2']);
    expect(ranked[0].similarity).toBe(0.9); // kept the higher of the two L1 hits
  });

  it('returns N candidates, not one', () => {
    const ranked = rankCandidates(
      [
        match({ document_id: 'd1', similarity: 0.9, product_key: 'PK1' }),
        match({ document_id: 'd2', similarity: 0.8, product_key: 'PK2' }),
        match({ document_id: 'd3', similarity: 0.7, product_key: 'PK3' }),
      ],
      5,
    );
    expect(ranked).toHaveLength(3);
  });

  it('B0-442: a product-level hit is keySource direct_match', () => {
    const ranked = rankCandidates(
      [match({ document_id: 'd1', similarity: 0.9, product_key: 'PK1' })],
      5,
    );
    expect(ranked[0]).toMatchObject({ betcoProductKey: 'PK1', keySource: 'direct_match' });
  });

  it('B0-442: a line-level hit (no product key) is provisionally keySource line_only', () => {
    const ranked = rankCandidates(
      [match({ document_id: 'd1', similarity: 0.9, product_line_key: 'L1', product_key: null })],
      5,
    );
    expect(ranked[0]).toMatchObject({ betcoProductKey: null, keySource: 'line_only' });
  });
});

describe('resolveCandidateUrls — line-level key resolution (B0-442)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a representative product key for a line-level match and marks it line_representative', async () => {
    mockLegacyTables({
      products_attr: [{ AttrKey: 'L1', ProductsKey: 'REP-PK-1' }],
      products: [
        {
          ProductsKey: 'REP-PK-1',
          Title: 'Green Earth Peroxide Cleaner',
          SKU: 'GEP-1',
          SLDescr: null,
          InvtID: null,
          Status: 'A',
          OnWeb: 1,
          User_Str_00: 'https://www.betco.com/products/green-earth-peroxide-cleaner',
          User_Str_01: null,
          User_Str_02: null,
          User_Str_03: null,
          User_Str_04: null,
          User_Str_05: null,
        },
      ],
      products_descr: [],
    });

    const ranked = rankCandidates(
      [match({ document_id: 'd1', similarity: 0.9, product_line_key: 'L1', product_key: null })],
      1,
    );
    expect(ranked[0]).toMatchObject({ betcoProductKey: null, keySource: 'line_only' });

    const resolved = await resolveCandidateUrls(ranked);

    // The regression this guards: the representative key must be written back onto the
    // candidate, not just used locally to derive the URL.
    expect(resolved[0]).toMatchObject({
      betcoProductKey: 'REP-PK-1',
      keySource: 'line_representative',
      url: 'https://www.betco.com/products/green-earth-peroxide-cleaner',
    });
  });

  it('leaves betcoProductKey null and keySource line_only when no representative product resolves', async () => {
    mockLegacyTables({ products_attr: [], products: [], products_descr: [] });

    const ranked = rankCandidates(
      [match({ document_id: 'd1', similarity: 0.9, product_line_key: 'L-NO-REP', product_key: null })],
      1,
    );
    const resolved = await resolveCandidateUrls(ranked);

    expect(resolved[0]).toMatchObject({ betcoProductKey: null, keySource: 'line_only' });
  });

  it('leaves a direct product-level match untouched (keySource direct_match)', async () => {
    mockLegacyTables({
      products_attr: [],
      products: [
        {
          ProductsKey: 'PK1',
          Title: 'Direct Product',
          SKU: 'D-1',
          SLDescr: null,
          InvtID: null,
          Status: 'A',
          OnWeb: 0,
          User_Str_00: null,
          User_Str_01: null,
          User_Str_02: null,
          User_Str_03: null,
          User_Str_04: null,
          User_Str_05: null,
        },
      ],
      products_descr: [],
    });

    const ranked = rankCandidates(
      [match({ document_id: 'd1', similarity: 0.9, product_key: 'PK1' })],
      1,
    );
    const resolved = await resolveCandidateUrls(ranked);

    expect(resolved[0]).toMatchObject({ betcoProductKey: 'PK1', keySource: 'direct_match' });
  });
});

describe('retrieveBetcoCandidates — end-to-end line-level wiring (B0-442)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a recommendation whose match is a real product line still persists a usable betcoProductKey via retrieveBetcoCandidates', async () => {
    mockLegacyTables({
      products_attr: [{ AttrKey: 'L1', ProductsKey: 'REP-PK-1' }],
      products: [
        {
          ProductsKey: 'REP-PK-1',
          Title: 'Green Earth Peroxide Cleaner',
          SKU: 'GEP-1',
          SLDescr: null,
          InvtID: null,
          Status: 'A',
          OnWeb: 1,
          User_Str_00: 'https://www.betco.com/products/green-earth-peroxide-cleaner',
          User_Str_01: null,
          User_Str_02: null,
          User_Str_03: null,
          User_Str_04: null,
          User_Str_05: null,
        },
      ],
      products_descr: [],
    });

    const out = await retrieveBetcoCandidates(
      { spec: spec(), limit: 1 },
      {
        search: async () => [
          match({ document_id: 'd1', similarity: 0.9, product_line_key: 'L1', product_key: null }),
        ],
        resolveUrls: resolveCandidateUrls,
      },
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ betcoProductKey: 'REP-PK-1', keySource: 'line_representative' });
  });
});

describe('retrieveBetcoCandidates (B0-87)', () => {
  it('returns [] without a search when the query is empty', async () => {
    let searched = false;
    const out = await retrieveBetcoCandidates(
      { spec: spec({ chemistryClass: null, productCategory: null, primaryUse: null, formFactor: null, keyClaims: [] }) },
      { search: async () => { searched = true; return []; }, resolveUrls: passthroughUrls },
    );
    expect(out).toEqual([]);
    expect(searched).toBe(false);
  });

  it('searches, ranks, and passes candidates through URL resolution', async () => {
    const out = await retrieveBetcoCandidates(
      { spec: spec(), limit: 2 },
      {
        search: async (q, limit) => {
          expect(q).toContain('disinfectant');
          expect(limit).toBe(6); // limit(2) * 3 over-fetch
          return [
            match({ document_id: 'd1', similarity: 0.91, product_key: 'PK1' }),
            match({ document_id: 'd2', similarity: 0.85, product_key: 'PK2' }),
          ];
        },
        resolveUrls: async (c) => c.map((x) => ({ ...x, url: `https://betco.com/${x.betcoProductKey}` })),
      },
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ betcoProductKey: 'PK1', similarity: 0.91, url: 'https://betco.com/PK1' });
  });
});
