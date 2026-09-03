import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-362 / B0-364: input-contract regressions for the product tools.
 *
 * B0-362 — `search_product_docs` must accept a `freeformQuery`-only call (32.4% of calls
 * were rejected because `topic` was required while the prompts tell the model to omit it).
 * B0-364 — the product-fact tools take a product NAME in a parameter named `productId`;
 * a model that sends `productName` must not be hard-rejected.
 */

vi.mock('~/lib/rag/entity-context', () => ({
  resolveProductEntityByName: vi.fn(async (name: string) => ({
    productLineKey: name.trim() ? 'PL-1' : null,
    productKey: name.trim() ? 'PK-1' : null,
  })),
}));

const emptyRetrieval = () => ({
  sources: [],
  entityContextBlock: null,
  retrieval: { adapter: 'test' },
  factsBlock: null,
});

vi.mock('~/lib/retrieval/product-knowledge', () => ({
  ragQueryForProductKnowledgeWithMeta: vi.fn(async () => emptyRetrieval()),
}));

vi.mock('~/lib/retrieval/product-guidance', () => ({
  retrieveApprovedUsage: vi.fn(async () => emptyRetrieval()),
  retrieveCompatibility: vi.fn(async () => emptyRetrieval()),
  retrieveSafetyConstraints: vi.fn(async () => emptyRetrieval()),
  retrieveSurfacesLists: vi.fn(async () => emptyRetrieval()),
}));

vi.mock('~/lib/retrieval/product-facts', () => ({
  buildFactsBlock: vi.fn(() => 'facts'),
  fetchFactsForProductLineKey: vi.fn(async () => null),
  fetchFactsForProductLineKeys: vi.fn(async () => new Map()),
  fetchFactsForProduct: vi.fn(async () => null),
  fetchFactsForProductBatch: vi.fn(async (requests: unknown[]) => requests.map(() => null)),
}));

vi.mock('~/lib/retrieval/efficacy-lab-report', () => ({
  fetchCurrentEfficacyLabReport: vi.fn(async () => null),
  renderEfficacyLabReportCitation: vi.fn(() => 'citation'),
}));

// B0-636 — FastDraw dispenser-specific dilution/yield lookup used by `get_efficacy_data`. Behaviour
// for this field is covered in detail by `product-tools-fastdraw-dilution.test.ts`; here it just
// needs to default to "no chunk found" so the pre-existing input-contract assertions below are
// unaffected.
vi.mock('~/lib/retrieval/fastdraw-dilution', () => ({
  fetchFastDrawDilution: vi.fn(async () => null),
}));

vi.mock('~/lib/tools/category-lookup', () => ({
  getProductsInCategory: vi.fn(async () => ({ ok: true, adapter: 'test', categoryName: '', products: [] })),
  getProductCategory: vi.fn(async () => ({ ok: true })),
}));

// B0-529 — the two knowledge-asset tools. Only the query composition and payload shape are under
// test here; the retrieval itself has its own unit test (`~/lib/retrieval/knowledge-assets.test.ts`).
vi.mock('~/lib/retrieval/knowledge-assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/retrieval/knowledge-assets')>()),
  retrieveKnowledgeAssets: vi.fn(async ({ query }: { query: string }) => ({
    query,
    scope: 'knowledge' as const,
    sources: [],
    retrieval: { adapter: 'rag_knowledge_document' as const },
  })),
}));

import { resolveProductEntityByName } from '~/lib/rag/entity-context';
import { ragQueryForProductKnowledgeWithMeta } from '~/lib/retrieval/product-knowledge';
import {
  retrieveApprovedUsage,
  retrieveCompatibility,
  retrieveSafetyConstraints,
  retrieveSurfacesLists,
} from '~/lib/retrieval/product-guidance';
import { fetchFactsForProductBatch } from '~/lib/retrieval/product-facts';
import { getProductsInCategory } from '~/lib/tools/category-lookup';
import { retrieveKnowledgeAssets } from '~/lib/retrieval/knowledge-assets';
import { executeProductTool } from '~/lib/tools/product-tools';
import { productSupportTools } from '~/lib/tools/definitions';
import {
  getDispenserAssetInputSchema,
  getEfficacyDataInputSchema,
  getFloorAssetInputSchema,
  searchProductDocsInputSchema,
} from '~/lib/tools/tool-schemas';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('search_product_docs input contract (B0-362)', () => {
  it('accepts a freeformQuery-only call and searches with it', async () => {
    const out = await executeProductTool('search_product_docs', {
      freeformQuery: 'best product for removing mineral scale from toilet bowls',
    });

    expect(out.ok).toBe(true);
    expect(out.query).toBe('best product for removing mineral scale from toilet bowls');
    // B0-479: the freeformQuery path no longer skips product-entity resolution (it used to pass
    // `''`); it attempts it against the freeform text in the precise, alias-tiers-only mode.
    expect(resolveProductEntityByName).toHaveBeenCalledWith(
      'best product for removing mineral scale from toilet bowls',
      { mode: 'freeform' },
    );
  });

  it('still accepts a topic-only call', async () => {
    const out = await executeProductTool('search_product_docs', { topic: 'dilution' });
    expect(out.ok).toBe(true);
    expect(out.query).toBe('dilution');
  });

  it('accepts productName + topic and composes both into the query', async () => {
    const out = await executeProductTool('search_product_docs', {
      productName: 'pH7Q',
      topic: 'kill claims',
    });
    expect(out.query).toBe('pH7Q kill claims');
    expect(resolveProductEntityByName).toHaveBeenCalledWith('pH7Q', { mode: 'name' });
  });

  it('composes a NON-EMPTY query from productName + surfaceType with no topic', async () => {
    const out = await executeProductTool('search_product_docs', {
      productName: 'AF315',
      surfaceType: 'ceramic tile',
    });
    expect(out.query).toBe('AF315 ceramic tile');
    expect(String(out.query).trim().length).toBeGreaterThan(0);
    expect(ragQueryForProductKnowledgeWithMeta).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'AF315 ceramic tile' }),
    );
  });

  it('accepts a surfaceType-only call without producing an empty query', async () => {
    const out = await executeProductTool('search_product_docs', { surfaceType: 'quarry tile' });
    expect(out.query).toBe('quarry tile');
  });

  it('rejects a call with no query fields at all', async () => {
    const parsed = searchProductDocsInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('Provide `freeformQuery` or `topic`');
    await expect(executeProductTool('search_product_docs', {})).rejects.toBeTruthy();
  });

  it('rejects whitespace-only query fields', async () => {
    expect(
      searchProductDocsInputSchema.safeParse({ freeformQuery: '   ', topic: '  ' }).success,
    ).toBe(false);
  });

  it('no longer advertises `topic` as required in the tool definition', () => {
    const def = productSupportTools.find(
      (t) => 'name' in t && t.name === 'search_product_docs',
    );
    const params = (def as { parameters: { required?: string[] } }).parameters;
    expect(params.required ?? []).not.toContain('topic');
  });
});

describe('product-fact tools accept `productName` as well as `productId` (B0-364)', () => {
  it('get_product_spec: productName is resolved as the product name', async () => {
    const out = await executeProductTool('get_product_spec', { productName: 'pH7Q' });
    expect(out.ok).toBe(true);
    expect(out.productId).toBe('pH7Q');
    expect(resolveProductEntityByName).toHaveBeenCalledWith('pH7Q', { mode: 'name' });
    expect(ragQueryForProductKnowledgeWithMeta).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'pH7Q specifications technical datasheet performance' }),
    );
  });

  it('get_product_spec: productId keeps working', async () => {
    const out = await executeProductTool('get_product_spec', { productId: 'AF315' });
    expect(out.productId).toBe('AF315');
    expect(resolveProductEntityByName).toHaveBeenCalledWith('AF315', { mode: 'name' });
  });

  it('get_product_spec: rejects a call with neither key', async () => {
    await expect(executeProductTool('get_product_spec', {})).rejects.toThrow(/productId/);
  });

  it('get_safety_constraints: both key spellings work', async () => {
    for (const args of [{ productName: 'pH7Q' }, { productId: 'pH7Q' }]) {
      const out = await executeProductTool('get_safety_constraints', args);
      expect(out.productId).toBe('pH7Q');
    }
    expect(retrieveSafetyConstraints).toHaveBeenCalledTimes(2);
    expect(retrieveSafetyConstraints).toHaveBeenLastCalledWith(
      expect.objectContaining({ productId: 'pH7Q' }),
    );
    // the alias key must not leak downstream
    expect(vi.mocked(retrieveSafetyConstraints).mock.calls[0][0]).not.toHaveProperty('productName');
  });

  it('list_allowed_surfaces: both key spellings work', async () => {
    for (const args of [{ productName: 'FastDraw 5' }, { productId: 'FastDraw 5' }]) {
      const out = await executeProductTool('list_allowed_surfaces', args);
      expect(out.productId).toBe('FastDraw 5');
    }
    expect(retrieveSurfacesLists).toHaveBeenLastCalledWith(
      expect.objectContaining({ productId: 'FastDraw 5', mode: 'allowed' }),
    );
  });

  it('list_disallowed_uses: both key spellings work', async () => {
    for (const args of [{ productName: 'Best Scrub' }, { productId: 'Best Scrub' }]) {
      const out = await executeProductTool('list_disallowed_uses', args);
      expect(out.productId).toBe('Best Scrub');
    }
    expect(retrieveSurfacesLists).toHaveBeenLastCalledWith(
      expect.objectContaining({ productId: 'Best Scrub', mode: 'disallowed' }),
    );
  });

  it('get_compatibility_rules: both key spellings work, surfaceType still required', async () => {
    for (const key of ['productName', 'productId'] as const) {
      const out = await executeProductTool('get_compatibility_rules', {
        [key]: 'pH7Q',
        surfaceType: 'terrazzo',
      });
      expect(out.productId).toBe('pH7Q');
      expect(out.surfaceType).toBe('terrazzo');
    }
    expect(retrieveCompatibility).toHaveBeenLastCalledWith(
      expect.objectContaining({ productId: 'pH7Q', surfaceType: 'terrazzo' }),
    );
    await expect(
      executeProductTool('get_compatibility_rules', { productName: 'pH7Q' }),
    ).rejects.toThrow(/surfaceType/);
  });

  it('get_approved_usage_guidance: both key spellings work, task/surface still required', async () => {
    for (const key of ['productName', 'productId'] as const) {
      const out = await executeProductTool('get_approved_usage_guidance', {
        [key]: 'pH7Q',
        task: 'disinfecting',
        surfaceType: 'restroom fixtures',
      });
      expect(out.productId).toBe('pH7Q');
    }
    expect(retrieveApprovedUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        productId: 'pH7Q',
        task: 'disinfecting',
        surfaceType: 'restroom fixtures',
      }),
    );
    await expect(
      executeProductTool('get_approved_usage_guidance', { productName: 'pH7Q', task: 'mopping' }),
    ).rejects.toThrow(/surfaceType/);
  });

  it('get_efficacy_data: both key spellings work and organism is preserved', async () => {
    for (const key of ['productName', 'productId'] as const) {
      const out = await executeProductTool('get_efficacy_data', {
        [key]: 'pH7Q',
        organism: 'Norovirus',
      });
      expect(out.productId).toBe('pH7Q');
      expect(out.organism).toBe('Norovirus');
    }
    expect(resolveProductEntityByName).toHaveBeenLastCalledWith('pH7Q', { mode: 'name' });
    await expect(executeProductTool('get_efficacy_data', { organism: 'Norovirus' })).rejects.toThrow(
      /productId/,
    );
  });

  describe('get_efficacy_data batch form (B0-549)', () => {
    it('accepts `productIds` without productId/productName and returns one result per identifier', async () => {
      const out = await executeProductTool('get_efficacy_data', {
        productIds: ['pH7Q', 'AF315', 'Kling'],
        organism: 'Norovirus',
      });

      expect(out.ok).toBe(true);
      expect(out.batch).toBe(true);
      expect(out.requestedCount).toBe(3);
      expect(Array.isArray(out.results)).toBe(true);
      expect((out.results as Array<{ productId: string }>).map((r) => r.productId)).toEqual([
        'pH7Q',
        'AF315',
        'Kling',
      ]);
      // B0-792 — the batch facts fetch is called ONCE with one request per identifier, aligned by
      // index (not deduped by product_line_key), since a shared/bogus product_line_key must not
      // cause two different products' facts to collapse into one lookup. All three identifiers
      // resolve to the same mocked {productLineKey, productKey} here, so the three requests happen
      // to be identical, but the call shape itself is 1-per-identifier.
      expect(fetchFactsForProductBatch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fetchFactsForProductBatch).mock.calls[0]?.[0]).toEqual([
        { productLineKey: 'PL-1', productKey: 'PK-1' },
        { productLineKey: 'PL-1', productKey: 'PK-1' },
        { productLineKey: 'PL-1', productKey: 'PK-1' },
      ]);
    });

    it('resolves the batch set from `category` via getProductsInCategory', async () => {
      vi.mocked(getProductsInCategory).mockResolvedValueOnce({
        ok: true,
        adapter: 'test',
        categoryName: 'Disinfectants',
        totalFound: 2,
        products: [
          { productLineId: '100', productLineName: 'pH7Q', documentKey: 'd1', prodTypes: [], subProdTypes: [], subChildProdTypes: [], prodClasses: [] },
          { productLineId: '200', productLineName: 'Kling', documentKey: 'd2', prodTypes: [], subProdTypes: [], subChildProdTypes: [], prodClasses: [] },
        ],
      });

      const out = await executeProductTool('get_efficacy_data', { category: 'Disinfectants' });

      expect(out.batch).toBe(true);
      expect(out.requestedCount).toBe(2);
      expect((out.results as Array<{ productId: string }>).map((r) => r.productId)).toEqual([
        'pH7Q',
        'Kling',
      ]);
    });

    it('returns an empty batch result (not an error) when the category has no products', async () => {
      const out = await executeProductTool('get_efficacy_data', { category: 'Nonexistent Category' });

      expect(out.ok).toBe(true);
      expect(out.batch).toBe(true);
      expect(out.results).toEqual([]);
      expect(out.note).toMatch(/No products found in category/);
    });

    it('single-product call (no productIds/category) is unaffected — not routed through the batch path', async () => {
      const out = await executeProductTool('get_efficacy_data', { productId: 'pH7Q' });

      expect(out.batch).toBeUndefined();
      expect(out.productId).toBe('pH7Q');
      expect(fetchFactsForProductBatch).not.toHaveBeenCalled();
    });

    it('rejects more than EFFICACY_BATCH_MAX_PRODUCTS identifiers', () => {
      const tooMany = Array.from({ length: 31 }, (_, i) => `product-${i}`);
      expect(
        getEfficacyDataInputSchema.safeParse({ productIds: tooMany }).success,
      ).toBe(false);
    });
  });

  it('trims and prefers productId when both keys are sent', async () => {
    const out = await executeProductTool('get_product_spec', {
      productId: '  AF315  ',
      productName: 'pH7Q',
    });
    expect(out.productId).toBe('AF315');
  });

  it('every product-fact tool definition documents the `productName` alias', () => {
    const names = [
      'get_product_spec',
      'get_approved_usage_guidance',
      'get_safety_constraints',
      'get_compatibility_rules',
      'list_allowed_surfaces',
      'list_disallowed_uses',
      'get_efficacy_data',
    ];
    for (const name of names) {
      const def = productSupportTools.find((t) => 'name' in t && t.name === name);
      const params = (def as { parameters: { properties: Record<string, unknown>; required?: string[] } })
        .parameters;
      expect(Object.keys(params.properties)).toContain('productName');
      expect(params.required ?? []).not.toContain('productId');
    }
  });
});

describe('get_dispenser_asset / get_floor_asset input contract (B0-529)', () => {
  it('get_dispenser_asset composes every supplied field into one knowledge query', async () => {
    const out = await executeProductTool('get_dispenser_asset', {
      dispenserModel: 'FastDraw',
      productName: 'pH7Q',
      topic: 'metering tip selection',
    });

    expect(out.ok).toBe(true);
    expect(out.scope).toBe('knowledge');
    expect(out.query).toBe(
      'FastDraw pH7Q metering tip selection dispenser dilution control proportioner metering tip setup calibration dilution ratio',
    );
    expect(retrieveKnowledgeAssets).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.stringContaining('FastDraw') }),
    );
  });

  it('get_dispenser_asset accepts a topic-only call', async () => {
    const out = await executeProductTool('get_dispenser_asset', {
      topic: 'calculating dilution ratios',
    });
    expect(out.ok).toBe(true);
    expect(String(out.query)).toContain('calculating dilution ratios');
  });

  it('get_floor_asset composes surface + procedure into one knowledge query', async () => {
    const out = await executeProductTool('get_floor_asset', {
      surfaceType: 'VCT',
      procedure: 'coat count',
    });

    expect(out.ok).toBe(true);
    expect(out.surfaceType).toBe('VCT');
    expect(out.procedure).toBe('coat count');
    expect(out.query).toBe(
      'VCT coat count floor finish coats coverage yield recoat top scrub stripping procedure',
    );
  });

  it('both tools reject a call with no anchoring field at all', async () => {
    expect(getDispenserAssetInputSchema.safeParse({}).success).toBe(false);
    expect(getFloorAssetInputSchema.safeParse({}).success).toBe(false);
    await expect(executeProductTool('get_dispenser_asset', {})).rejects.toBeTruthy();
    await expect(executeProductTool('get_floor_asset', {})).rejects.toBeTruthy();
  });

  it('both tools reject whitespace-only anchoring fields', () => {
    expect(getDispenserAssetInputSchema.safeParse({ topic: '   ' }).success).toBe(false);
    expect(getFloorAssetInputSchema.safeParse({ surfaceType: '  ' }).success).toBe(false);
  });

  it('both tools cap maxResults at 5', () => {
    expect(getDispenserAssetInputSchema.safeParse({ topic: 't', maxResults: 5 }).success).toBe(true);
    expect(getDispenserAssetInputSchema.safeParse({ topic: 't', maxResults: 6 }).success).toBe(false);
    expect(getFloorAssetInputSchema.safeParse({ procedure: 'p', maxResults: 6 }).success).toBe(false);
  });

  it('threads maxResults through to retrieval rather than silently ignoring it', async () => {
    await executeProductTool('get_floor_asset', { surfaceType: 'terrazzo', maxResults: 5 });
    expect(retrieveKnowledgeAssets).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 5 }),
    );
  });

  it('advertises no required parameter, matching the at-least-one schema rule', () => {
    for (const name of ['get_dispenser_asset', 'get_floor_asset']) {
      const def = productSupportTools.find((t) => 'name' in t && t.name === name);
      const params = (def as { parameters: { required?: string[] } }).parameters;
      expect(params.required ?? []).toEqual([]);
    }
  });
});
