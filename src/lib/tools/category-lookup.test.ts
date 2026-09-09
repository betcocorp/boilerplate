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
type EntityRow = { title: string | null; sku: string | null; product_line_key: string | null };

let documents: DocRow[] = [];
let entities: EntityRow[] = [];
let entityError: { message: string } | null = null;
let entityInCall: unknown[] | null = null;

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => ({
    schema(_schemaName: string) {
      return {
        from: (table: string) => {
          if (table === 'document') {
            return {
              select: () => ({
                eq: async () => ({ data: documents, error: null }),
              }),
            };
          }
          if (table === 'entity') {
            return {
              select: () => ({
                eq: () => ({
                  in: async (_column: string, values: unknown[]) => {
                    entityInCall = values;
                    return { data: entities, error: entityError };
                  },
                }),
              }),
            };
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
      { title: 'Clear Image Glass Cleaner (RTU) (12 - 32 OZ)', sku: '35504-00', product_line_key: 'GLASS-1' },
      { title: 'Clear Image Glass Cleaner (RTU) (4 - 1 GAL)', sku: '35504-04', product_line_key: 'GLASS-1' },
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
