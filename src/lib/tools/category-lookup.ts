import { detectCategorySearchTerms } from '~/lib/tools/category-search-terms';
import type { GetProductsInCategoryOutput, LabeledDilution } from '~/lib/tools/tool-schemas';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

const CATEGORY_LOOKUP_ADAPTER_TAG = 'product_category_v1' as const;

type DocumentRow = {
  document_key: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
};

type CategoryMeta = {
  productLineId: string;
  productLineName: string;
  /** `metadata.product_line_key` (UUID) — joins to `rag.entity.product_line_key` for item numbers. */
  productLineKey: string;
  prodTypes: string[];
  subProdTypes: string[];
  subChildProdTypes: string[];
  prodClasses: string[];
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function extractCategoryMeta(metadata: Record<string, unknown>): CategoryMeta {
  return {
    productLineId: typeof metadata.prod_line_id === 'string' ? metadata.prod_line_id : '',
    productLineName: typeof metadata.prod_line_descr === 'string' ? metadata.prod_line_descr : '',
    productLineKey: typeof metadata.product_line_key === 'string' ? metadata.product_line_key : '',
    prodTypes: toStringArray(metadata.prod_types),
    subProdTypes: toStringArray(metadata.sub_prod_types),
    subChildProdTypes: toStringArray(metadata.sub_child_prod_types),
    prodClasses: toStringArray(metadata.prod_classes),
  };
}

type ProductEntityRow = {
  id: string;
  title: string | null;
  sku: string | null;
  entity_type: string | null;
  product_line_key: string | null;
};

type FactRow = { entity_id: string; dilution_display?: string | null; dilution_oz_per_gal: string | number | null };

type ProductLineExtras = {
  items: Array<{ sku: string; title: string }>;
  labeledDilution: LabeledDilution;
};

/** PostgREST returns a `::text`-cast numeric as a string; a plain numeric would arrive as a number. Either way, no reformatting. */
function factText(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? String(value) : value;
}

/**
 * B0-889 — item numbers for the matched product lines. `rag.entity` (entity_type = 'product') holds
 * one row per sellable variant with its own `sku`; a product line commonly has several (pack sizes,
 * RTU vs. concentrate). Batched by `product_line_key` so a category list costs one extra query, not
 * one per product line.
 *
 * B0-972 — the same entity fetch now also returns the product_line-tier row, so each line's labeled
 * dilution can be joined from `rag.product_line_fact` (by `entity_id`; verified live 2026-09-14:
 * 286 product_line-tier rows, one per line, 182 with `dilution_display`, 115 with
 * `dilution_oz_per_gal`) and, when that row carries neither value, from `rag.product_efficacy`.
 * Values are transcribed exactly as stored (`dilution_oz_per_gal` is selected as text); when the
 * fallback rows disagree no value is chosen — the tool says so instead of picking one.
 */
async function fetchExtrasForProductLines(
  productLineKeys: readonly string[],
): Promise<Map<string, ProductLineExtras>> {
  const keys = [...new Set(productLineKeys.filter(Boolean))];
  const byLine = new Map<string, ProductLineExtras>();
  if (keys.length === 0) return byLine;
  const extrasFor = (key: string): ProductLineExtras => {
    const existing = byLine.get(key);
    if (existing) return existing;
    const created: ProductLineExtras = { items: [], labeledDilution: null };
    byLine.set(key, created);
    return created;
  };

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('rag')
    .from('entity')
    .select('id, title, sku, entity_type, product_line_key')
    .in('product_line_key', keys) as unknown as {
      data: ProductEntityRow[] | null;
      error: { message: string } | null;
    };

  if (error) {
    // Item numbers and dilutions are additive to the category list — a lookup failure here must not
    // fail the whole category tool call (the product names/categories are still useful without them).
    console.warn('[category-lookup] item-number lookup failed; returning products without SKUs', {
      message: error.message,
    });
    return byLine;
  }

  const lineEntityIds = new Map<string, string>();
  const productEntityIds = new Map<string, string>();
  for (const row of data ?? []) {
    if (!row.product_line_key) continue;
    if (row.entity_type === 'product_line') {
      lineEntityIds.set(row.id, row.product_line_key);
      continue;
    }
    if (row.entity_type !== 'product') continue;
    productEntityIds.set(row.id, row.product_line_key);
    if (!row.sku) continue;
    extrasFor(row.product_line_key).items.push({ sku: row.sku, title: row.title ?? '' });
  }

  const entityIds = [...lineEntityIds.keys(), ...productEntityIds.keys()];
  if (entityIds.length === 0) return byLine;

  const { data: factRows, error: factError } = await supabase
    .schema('rag')
    .from('product_line_fact')
    .select('entity_id, dilution_display, dilution_oz_per_gal::text')
    .in('entity_id', entityIds) as unknown as {
      data: FactRow[] | null;
      error: { message: string } | null;
    };
  if (factError) {
    console.warn('[category-lookup] labeled-dilution lookup failed; returning products without dilution', {
      message: factError.message,
    });
    return byLine;
  }

  // Product_line tier first; a product-tier (SKU) row only stands in when its line has no row of its own.
  const lineTierFacts = new Map<string, FactRow>();
  const productTierFacts = new Map<string, FactRow[]>();
  for (const row of factRows ?? []) {
    const lineKey = lineEntityIds.get(row.entity_id);
    if (lineKey) {
      lineTierFacts.set(lineKey, row);
      continue;
    }
    const productLineKey = productEntityIds.get(row.entity_id);
    if (!productLineKey) continue;
    const list = productTierFacts.get(productLineKey) ?? [];
    list.push(row);
    productTierFacts.set(productLineKey, list);
  }

  const stillMissing: string[] = [];
  for (const key of keys) {
    const lineRow = lineTierFacts.get(key);
    if (lineRow && (lineRow.dilution_display || lineRow.dilution_oz_per_gal !== null)) {
      extrasFor(key).labeledDilution = {
        display: lineRow.dilution_display ?? null,
        ozPerGal: factText(lineRow.dilution_oz_per_gal),
        source: 'product_line_fact',
      };
      continue;
    }
    const skuRows = (productTierFacts.get(key) ?? []).filter(
      (row) => row.dilution_display || row.dilution_oz_per_gal !== null,
    );
    if (skuRows.length > 0) {
      const displays = new Set(skuRows.map((row) => row.dilution_display ?? ''));
      const ozValues = new Set(skuRows.map((row) => factText(row.dilution_oz_per_gal) ?? ''));
      extrasFor(key).labeledDilution =
        displays.size <= 1 && ozValues.size <= 1
          ? {
              display: skuRows[0]!.dilution_display ?? null,
              ozPerGal: factText(skuRows[0]!.dilution_oz_per_gal),
              source: 'product_line_fact',
            }
          : {
              display: null,
              ozPerGal: null,
              source: 'product_line_fact',
              note: 'labeled dilution differs between this line\'s items; look up the specific item with get_efficacy_data',
            };
      continue;
    }
    stillMissing.push(key);
  }

  if (stillMissing.length === 0) return byLine;
  const missingEntityIds = entityIds.filter((id) =>
    stillMissing.includes(lineEntityIds.get(id) ?? productEntityIds.get(id) ?? ''),
  );
  if (missingEntityIds.length === 0) return byLine;

  const { data: efficacyRows, error: efficacyError } = await supabase
    .schema('rag')
    .from('product_efficacy')
    .select('entity_id, dilution_oz_per_gal::text')
    .in('entity_id', missingEntityIds)
    .not('dilution_oz_per_gal', 'is', null) as unknown as {
      data: FactRow[] | null;
      error: { message: string } | null;
    };
  if (efficacyError) {
    console.warn('[category-lookup] efficacy dilution fallback failed; leaving dilution null', {
      message: efficacyError.message,
    });
    return byLine;
  }
  const efficacyByLine = new Map<string, Set<string>>();
  for (const row of efficacyRows ?? []) {
    const lineKey = lineEntityIds.get(row.entity_id) ?? productEntityIds.get(row.entity_id);
    const value = factText(row.dilution_oz_per_gal);
    if (!lineKey || value === null) continue;
    const set = efficacyByLine.get(lineKey) ?? new Set<string>();
    set.add(value);
    efficacyByLine.set(lineKey, set);
  }
  for (const [lineKey, values] of efficacyByLine) {
    const [only] = [...values];
    extrasFor(lineKey).labeledDilution =
      values.size === 1 && only !== undefined
        ? { display: null, ozPerGal: only, source: 'product_efficacy' }
        : {
            display: null,
            ozPerGal: null,
            source: 'product_efficacy',
            note: 'dilution differs by organism claim; call get_efficacy_data with the organism for the per-claim value',
          };
  }

  return byLine;
}

function matchesCategory(
  meta: CategoryMeta,
  search: string,
  level: 'prod_type' | 'sub_prod_type' | 'sub_child_prod_type' | 'prod_class' | 'any',
): boolean {
  const q = search.toLowerCase();
  const hit = (arr: string[]) => arr.some((v) => v.toLowerCase().includes(q));

  switch (level) {
    case 'prod_type':        return hit(meta.prodTypes);
    case 'sub_prod_type':    return hit(meta.subProdTypes);
    case 'sub_child_prod_type': return hit(meta.subChildProdTypes);
    case 'prod_class':       return hit(meta.prodClasses);
    case 'any':
      return hit(meta.prodTypes) || hit(meta.subProdTypes) ||
             hit(meta.subChildProdTypes) || hit(meta.prodClasses);
  }
}

/**
 * Return product line profiles that belong to the given category name.
 * Searches across all category levels by default.
 */
export async function getProductsInCategory(input: {
  categoryName: string;
  categoryLevel?: 'prod_type' | 'sub_prod_type' | 'sub_child_prod_type' | 'prod_class' | 'any';
  maxResults?: number;
}): Promise<GetProductsInCategoryOutput> {
  const supabase = getSupabaseServiceRoleClient();
  const rawSearchName = input.categoryName.trim();
  // B0-889 — normalize BEFORE matching, not just for logging: "wood floor stripper" and "glass
  // cleaner" never appear verbatim in the taxonomy strings (see `detectCategorySearchTerms`).
  // B0-977 — EVERY category token the phrase names is searched ("stripping and finish products" →
  // strippers AND finishes), not just the first; an unrecognised phrase is searched as typed.
  const detectedTerms = detectCategorySearchTerms(rawSearchName);
  const searchTerms = detectedTerms.length > 0 ? detectedTerms : [rawSearchName];
  const level = input.categoryLevel ?? 'any';
  const maxResults = Math.min(input.maxResults ?? 20, 50);

  if (!rawSearchName) {
    return {
      ok: true,
      adapter: CATEGORY_LOOKUP_ADAPTER_TAG,
      categoryName: '',
      categoriesSearched: [],
      totalFound: 0,
      products: [],
    };
  }

  // Fetch all product_line_profile documents (~1703 rows, compact metadata only)
  const { data, error } = await supabase
    .schema('rag')
    .from('document')
    .select('document_key, entity_id, metadata')
    .eq('document_kind', 'product_line_profile') as unknown as {
      data: DocumentRow[] | null;
      error: { message: string } | null;
    };

  if (error) {
    throw new Error(`Category lookup failed: ${error.message}`);
  }

  const matches: (CategoryMeta & { documentKey: string; matchedCategoryTerms: string[] })[] = [];

  for (const doc of data ?? []) {
    const meta = extractCategoryMeta(doc.metadata);
    const matchedCategoryTerms = searchTerms.filter((term) => matchesCategory(meta, term, level));
    if (matchedCategoryTerms.length > 0) {
      matches.push({ ...meta, documentKey: doc.document_key, matchedCategoryTerms });
    }
  }

  const paged = matches.slice(0, maxResults);
  // B0-889 — item numbers per product line, so a "list every match" answer can cite one, not just
  // a bare product name. B0-972 — plus each line's labeled dilution. Fetched only for the page
  // actually returned.
  const extrasByLine = await fetchExtrasForProductLines(paged.map((m) => m.productLineKey));

  return {
    ok: true,
    adapter: CATEGORY_LOOKUP_ADAPTER_TAG,
    categoryName: input.categoryName,
    categoriesSearched: searchTerms,
    totalFound: matches.length,
    products: paged.map((m) => ({
      productLineId: m.productLineId,
      productLineName: m.productLineName,
      documentKey: m.documentKey,
      prodTypes: m.prodTypes,
      subProdTypes: m.subProdTypes,
      subChildProdTypes: m.subChildProdTypes,
      prodClasses: m.prodClasses,
      matchedCategoryTerms: m.matchedCategoryTerms,
      // B0-889 — item numbers (SKUs) for this product line's sellable variants, from `rag.entity`.
      items: extrasByLine.get(m.productLineKey)?.items ?? [],
      // B0-972 — labeled dilution exactly as stored, or an explicit null when none is on file.
      labeledDilution: extrasByLine.get(m.productLineKey)?.labeledDilution ?? null,
    })),
  };
}

/**
 * Return the category chain (prod_type → sub_prod_type → sub_child_prod_type, prod_class)
 * for a given product name or prod_line_id.
 */
export async function getProductCategory(input: { productId: string }) {
  const supabase = getSupabaseServiceRoleClient();
  const searchId = input.productId.trim();

  if (!searchId) {
    return { ok: false, adapter: CATEGORY_LOOKUP_ADAPTER_TAG, error: 'productId is required' };
  }

  // Try exact prod_line_id match first (e.g. "4020" or "BF315")
  const { data: exactData, error: exactError } = await supabase
    .schema('rag')
    .from('document')
    .select('document_key, metadata')
    .eq('document_kind', 'product_line_profile')
    .filter('metadata->>prod_line_id', 'eq', searchId)
    .limit(1) as unknown as {
      data: Pick<DocumentRow, 'document_key' | 'metadata'>[] | null;
      error: { message: string } | null;
    };

  if (exactError) {
    throw new Error(`Product category lookup failed: ${exactError.message}`);
  }

  let doc = exactData?.[0] ?? null;

  // Fall back to name search via entity title
  if (!doc) {
    const { data: entityData, error: entityError } = await supabase
      .schema('rag')
      .from('entity')
      .select('product_line_key')
      .eq('entity_type', 'product_line')
      .ilike('title', `%${searchId}%`)
      .limit(5);

    if (entityError) {
      throw new Error(`Entity title search failed: ${entityError.message}`);
    }

    const plKeys = (entityData ?? [])
      .map((r) => r.product_line_key)
      .filter((k): k is string => Boolean(k));

    if (plKeys.length > 0) {
      const { data: docData, error: docError } = await supabase
        .schema('rag')
        .from('document')
        .select('document_key, metadata')
        .eq('document_kind', 'product_line_profile')
        .in('metadata->>product_line_key' as 'document_key', plKeys)
        .limit(1) as unknown as {
          data: Pick<DocumentRow, 'document_key' | 'metadata'>[] | null;
          error: { message: string } | null;
        };

      if (docError) {
        throw new Error(`Document lookup by product_line_key failed: ${docError.message}`);
      }

      doc = docData?.[0] ?? null;
    }
  }

  if (!doc) {
    return {
      ok: false,
      adapter: CATEGORY_LOOKUP_ADAPTER_TAG,
      productId: input.productId,
      error: 'Product not found — try searching by exact product code or full product name.',
    };
  }

  const meta = extractCategoryMeta(doc.metadata);
  const hasCategory = meta.prodTypes.length > 0 || meta.prodClasses.length > 0;

  return {
    ok: true,
    adapter: CATEGORY_LOOKUP_ADAPTER_TAG,
    productId: input.productId,
    productLineId: meta.productLineId,
    productLineName: meta.productLineName,
    documentKey: doc.document_key,
    hasCategory,
    category: hasCategory
      ? {
          prodTypes: meta.prodTypes,
          subProdTypes: meta.subProdTypes,
          subChildProdTypes: meta.subChildProdTypes,
          prodClasses: meta.prodClasses,
        }
      : null,
  };
}
