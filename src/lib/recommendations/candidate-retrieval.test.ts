import { describe, expect, it } from 'vitest';

import {
  buildRetrievalQuery,
  rankCandidates,
  retrieveBetcoCandidates,
  type BetcoCandidate,
} from '~/lib/recommendations/candidate-retrieval';
import type { RagSearchMatch } from '~/lib/rag/search';
import type { EnrichedCompetitorSpec } from '~/lib/websearch/enrich-competitor-spec';

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
    provenance: {
      chemistryClass: null,
      epaRegistration: null,
      contactTimeSeconds: null,
      dilutionOzPerGal: null,
      productCategory: null,
      primaryUse: null,
      formFactor: null,
      keyClaims: null,
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
