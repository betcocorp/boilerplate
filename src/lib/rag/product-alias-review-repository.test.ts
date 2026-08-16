import { describe, expect, it } from 'vitest';

import { fromProductAliasRow } from '~/lib/rag/product-alias-review-repository';

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
