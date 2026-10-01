import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-889 — `getProductsInCategory`'s synonym normalization and item-number (SKU) attachment.
 *
 * Real taxonomy strings verified live against `rag.document` (product_line_profile metadata,
 * 2026-09-08) are truncated/abbreviated legacy category labels — "Gen'l Cleaning - Glass, Surfac",
 * "Floor Care-Strippers", "Food Serv-Cleaners, Degreasers" — so a user phrase like "glass cleaner"
 * or "wood floor stripper" never substring-matches them without normalization first.
 */

type DocRow = { document_key: string; entity_id: string | null; metadata: Record<string, unknown> };
type EntityRow = { title: string | null; sku: string | null; product_line_key: string | null; entity_type?: string };
type LabelDocRow = { id: string; document_key: string; sku: string | null };
type ChunkRow = { document_id: string; heading: string | null; chunk_text: string };

let documents: DocRow[] = [];
let entities: EntityRow[] = [];
let entityError: { message: string } | null = null;
let entityInCall: unknown[] | null = null;
// B0-1003 — floor-use lookup fixtures. Defaulted empty so existing tests (which never populate
// these) exercise the "no label matched" → `floorUse: null` path exactly as before.
let labelDocs: LabelDocRow[] = [];
let labelDocsError: { message: string } | null = null;
let chunkRows: ChunkRow[] = [];
let chunkError: { message: string } | null = null;

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => ({
    schema(_schemaName: string) {
      return {
        from: (table: string) => {
          if (table === 'document') {
            return {
              select: () => ({
                eq: (_field: string, value: string) => {
                  if (value === 'label') {
                    return {
                      in: async () => ({ data: labelDocs, error: labelDocsError }),
                    };
                  }
                  return Promise.resolve({ data: documents, error: null });
                },
              }),
            };
          }
          if (table === 'entity') {
            // Matches the real query shape exactly (`.select(...).in('product_line_key', keys)` —
            // no `.eq()` in between; this mock previously required one and every test in this file
            // exercising the entity path was failing with "`.in` is not a function" before this fix).
            return {
              select: () => ({
                in: async (_column: string, values: unknown[]) => {
                  entityInCall = values;
                  return { data: entities, error: entityError };
                },
              }),
            };
          }
          if (table === 'document_chunk') {
            return {
              select: () => ({
                in: () => ({
                  ilike: async () => ({ data: chunkRows, error: chunkError }),
                }),
              }),
            };
          }
          // B0-972 dilution lookups this file does not exercise directly — stubbed to "nothing on
          // file" so the SKU/floor-use tests above can reach past them without asserting on dilution.
          if (table === 'product_line_fact') {
            return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
          }
          if (table === 'product_efficacy') {
            return { select: () => ({ in: () => ({ not: async () => ({ data: [], error: null }) }) }) };
          }
          throw new Error(`unexpected table "${table}"`);
        },
      };
    },
  }),
}));

import { getProductsInCategory } from '~/lib/tools/category-lookup';

function glassDoc(name: string, key: string): DocRow {
  return {
    document_key: `doc:${key}`,
    entity_id: null,
    metadata: {
      prod_line_descr: name,
      product_line_key: key,
      prod_classes: ["Gen'l Cleaning - Glass, Surfac"],
      sub_child_prod_types: ['Glass'],
    },
  };
}

function stripperDoc(name: string, key: string, extra: Record<string, unknown> = {}): DocRow {
  return {
    document_key: `doc:${key}`,
    entity_id: null,
    metadata: {
      prod_line_descr: name,
      product_line_key: key,
      prod_classes: ['Floor Care-Strippers'],
      prod_types: null,
      ...extra,
    },
  };
}

function degreaserDoc(name: string, key: string): DocRow {
  return {
    document_key: `doc:${key}`,
    entity_id: null,
    metadata: {
      prod_line_descr: name,
      product_line_key: key,
      prod_classes: ['Food Serv-Cleaners, Degreasers'],
    },
  };
}

beforeEach(() => {
  documents = [];
  entities = [];
  entityError = null;
  entityInCall = null;
  labelDocs = [];
  labelDocsError = null;
  chunkRows = [];
  chunkError = null;
});

describe('getProductsInCategory — synonym normalization (B0-889)', () => {
  it('"glass cleaner" resolves to real Betco glass-cleaner lines via the "Gen\'l Cleaning - Glass, Surfac" prod_class', async () => {
    documents = [
      glassDoc('Clear Image Glass Cleaner (RTU)', 'GLASS-1'),
      glassDoc('Deep Blue Glass Cleaner Concentrate', 'GLASS-2'),
    ];

    const result = await getProductsInCategory({ categoryName: 'glass cleaner' });

    expect(result.ok).toBe(true);
    expect(result.totalFound).toBe(2);
    expect(result.products.map((p) => p.productLineName)).toEqual([
      'Clear Image Glass Cleaner (RTU)',
      'Deep Blue Glass Cleaner Concentrate',
    ]);
  });

  it('"wood floor stripper" resolves via "Floor Care-Strippers", including a line typed under Dilution Control/FastDraw', async () => {
    documents = [
      stripperDoc('Extremer Floor Stripper', 'STRIP-1'),
      // B0-889 caveat — "Extremer Ultra Floor Stripper" is typed under Dilution Control/FastDraw but
      // still carries the "Floor Care-Strippers" class; the category tool must still find it.
      stripperDoc('Extremer Ultra Floor Stripper', 'STRIP-2', {
        prod_types: ['Dilution Control'],
        sub_prod_types: ['FastDraw'],
      }),
    ];

    const result = await getProductsInCategory({ categoryName: 'wood floor stripper' });

    expect(result.totalFound).toBe(2);
    expect(result.products.map((p) => p.productLineName)).toContain('Extremer Ultra Floor Stripper');
  });

  it('"kitchen degreaser" resolves via "Food Serv-Cleaners, Degreasers"', async () => {
    documents = [degreaserDoc('Kitchen Degreaser', 'DGR-1'), degreaserDoc('Spray Foam Degreaser', 'DGR-2')];

    const result = await getProductsInCategory({ categoryName: 'greasy kitchen floors, degreaser' });
    // The normalizer only recognises the "degreas"/"grease" token, so pass what the caller would
    // realistically extract from a task ask ("degreaser" or "grease").
    const byGrease = await getProductsInCategory({ categoryName: 'grease' });

    expect(result.totalFound).toBe(2);
    expect(byGrease.totalFound).toBe(2);
  });

  it('leaves an unrelated category name untouched', async () => {
    documents = [
      {
        document_key: 'doc:AIR-1',
        entity_id: null,
        metadata: { prod_line_descr: 'Air Care Metered', product_line_key: 'AIR-1', prod_types: ['Odor Management'] },
      },
    ];

    const result = await getProductsInCategory({ categoryName: 'Odor Management' });
    expect(result.totalFound).toBe(1);
  });
});

describe('getProductsInCategory — item numbers (B0-889)', () => {
  it('attaches each product line\'s SKUs from rag.entity, batched by product_line_key', async () => {
    documents = [glassDoc('Clear Image Glass Cleaner (RTU)', 'GLASS-1')];
    entities = [
      { title: 'Clear Image Glass Cleaner (RTU) (12 - 32 OZ)', sku: '35504-00', product_line_key: 'GLASS-1', entity_type: 'product' },
      { title: 'Clear Image Glass Cleaner (RTU) (4 - 1 GAL)', sku: '35504-04', product_line_key: 'GLASS-1', entity_type: 'product' },
    ];

    const result = await getProductsInCategory({ categoryName: 'glass cleaner' });

    expect(result.products[0]).toMatchObject({
      productLineName: 'Clear Image Glass Cleaner (RTU)',
      items: [
        { sku: '35504-00', title: 'Clear Image Glass Cleaner (RTU) (12 - 32 OZ)' },
        { sku: '35504-04', title: 'Clear Image Glass Cleaner (RTU) (4 - 1 GAL)' },
      ],
    });
    expect(entityInCall).toEqual(['GLASS-1']);
  });

  it('only fetches items for the returned page, not every match', async () => {
    documents = [glassDoc('Line A', 'A'), glassDoc('Line B', 'B'), glassDoc('Line C', 'C')];

    await getProductsInCategory({ categoryName: 'glass cleaner', maxResults: 2 });

    expect(entityInCall).toEqual(['A', 'B']);
  });

  it('degrades to an empty items list (never throws) when the entity lookup fails', async () => {
    documents = [glassDoc('Clear Image Glass Cleaner (RTU)', 'GLASS-1')];
    entityError = { message: 'connection reset' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await getProductsInCategory({ categoryName: 'glass cleaner' });

    expect(result.ok).toBe(true);
    expect(result.products[0]).toMatchObject({ items: [] });
    warn.mockRestore();
  });

  it('skips the item-number lookup entirely when there are no matches', async () => {
    documents = [];

    const result = await getProductsInCategory({ categoryName: 'glass cleaner' });

    expect(result.totalFound).toBe(0);
    expect(entityInCall).toBeNull();
  });
});

describe('getProductsInCategory — floor use (B0-1003)', () => {
  it('reports floorUse: null when no label matches any SKU on the line', async () => {
    documents = [degreaserDoc('Spray Foam Degreaser', 'DGR-1')];
    entities = [{ title: 'Spray Foam Degreaser (4 - 1 GAL)', sku: '999-04', product_line_key: 'DGR-1', entity_type: 'product' }];
    // No labelDocs fixture set — nothing joins to SKU '999-04'.

    const result = await getProductsInCategory({ categoryName: 'grease' });

    expect(result.products[0]).toMatchObject({ floorUse: null });
  });

  it('reports floorUse.documented: false when a label was found but no chunk mentions floor', async () => {
    documents = [degreaserDoc('Spray Foam Degreaser', 'DGR-1')];
    entities = [{ title: 'Spray Foam Degreaser (4 - 1 GAL)', sku: '999-04', product_line_key: 'DGR-1', entity_type: 'product' }];
    labelDocs = [{ id: 'label-1', document_key: 'label_md:betco:999-04_spray-foam:en', sku: '999-04' }];
    chunkRows = [];

    const result = await getProductsInCategory({ categoryName: 'grease' });

    expect(result.products[0]).toMatchObject({ floorUse: { documented: false, labelDocumentKeys: [] } });
  });

  it('reports floorUse.documented: true with the specific label(s) when a Surfaces/Directions chunk mentions floor', async () => {
    documents = [degreaserDoc('Kitchen Degreaser', 'DGR-1')];
    entities = [{ title: 'Kitchen Degreaser (4 - 1 GAL)', sku: '101204', product_line_key: 'DGR-1', entity_type: 'product' }];
    labelDocs = [{ id: 'label-1', document_key: 'label_md:betco:101204_kitchen-degreaser:en', sku: '101204' }];
    chunkRows = [
      {
        document_id: 'label-1',
        heading: 'Directions for Use   <!-- section_type: directions -->',
        chunk_text: 'For cleaning concrete, floors, walls, kitchens, hoods, grills.',
      },
    ];

    const result = await getProductsInCategory({ categoryName: 'grease' });

    expect(result.products[0]).toMatchObject({
      floorUse: { documented: true, labelDocumentKeys: ['label_md:betco:101204_kitchen-degreaser:en'] },
    });
  });

  it('ignores a floor mention outside the Surfaces/Directions sections (e.g. a slip-hazard caution)', async () => {
    documents = [degreaserDoc('Spray Foam Degreaser', 'DGR-1')];
    entities = [{ title: 'Spray Foam Degreaser (4 - 1 GAL)', sku: '999-04', product_line_key: 'DGR-1', entity_type: 'product' }];
    labelDocs = [{ id: 'label-1', document_key: 'label_md:betco:999-04_spray-foam:en', sku: '999-04' }];
    chunkRows = [
      {
        document_id: 'label-1',
        heading: 'Hazards   <!-- section_type: hazards -->',
        chunk_text: 'Wipe up spills immediately; a wet floor is a slip hazard.',
      },
    ];

    const result = await getProductsInCategory({ categoryName: 'grease' });

    expect(result.products[0]).toMatchObject({ floorUse: { documented: false, labelDocumentKeys: [] } });
  });

  it('degrades to floorUse: null (never throws) when the label/chunk lookup fails', async () => {
    documents = [degreaserDoc('Kitchen Degreaser', 'DGR-1')];
    entities = [{ title: 'Kitchen Degreaser (4 - 1 GAL)', sku: '101204', product_line_key: 'DGR-1', entity_type: 'product' }];
    labelDocsError = { message: 'connection reset' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await getProductsInCategory({ categoryName: 'grease' });

    expect(result.ok).toBe(true);
    expect(result.products[0]).toMatchObject({ floorUse: null });
    warn.mockRestore();
  });
});
