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
    prodTypes: toStringArray(metadata.prod_types),
    subProdTypes: toStringArray(metadata.sub_prod_types),
    subChildProdTypes: toStringArray(metadata.sub_child_prod_types),
    prodClasses: toStringArray(metadata.prod_classes),
  };
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
}) {
  const supabase = getSupabaseServiceRoleClient();
  const searchName = input.categoryName.trim();
  const level = input.categoryLevel ?? 'any';
  const maxResults = Math.min(input.maxResults ?? 20, 50);

  if (!searchName) {
    return { ok: true, adapter: CATEGORY_LOOKUP_ADAPTER_TAG, categoryName: '', products: [] };
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

  const matches: (CategoryMeta & { documentKey: string })[] = [];

  for (const doc of data ?? []) {
    const meta = extractCategoryMeta(doc.metadata);
    if (matchesCategory(meta, searchName, level)) {
      matches.push({ ...meta, documentKey: doc.document_key });
    }
  }

  return {
    ok: true,
    adapter: CATEGORY_LOOKUP_ADAPTER_TAG,
    categoryName: input.categoryName,
    totalFound: matches.length,
    products: matches.slice(0, maxResults).map((m) => ({
      productLineId: m.productLineId,
      productLineName: m.productLineName,
      documentKey: m.documentKey,
      prodTypes: m.prodTypes,
      subProdTypes: m.subProdTypes,
      subChildProdTypes: m.subChildProdTypes,
      prodClasses: m.prodClasses,
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
