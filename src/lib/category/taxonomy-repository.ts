import {
  resolveCategory,
  type CategoryMatch,
  type ResolveCategoryOptions,
  type TaxonomyNode,
} from '~/lib/category/category-resolver';
import {
  deriveCanonicalProductUrl,
  type LegacyProductDescrRow,
  type LegacyProductRow,
} from '~/lib/tools/cross-reference-lookup';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-27 (wiring) + B0-28 — Category-First retrieval over the ingested taxonomy.
 *
 * `loadTaxonomyNodes` reads the `public.product_category` table (v1 derived from MetaKeyWords) and
 * feeds `resolveCategory`; `getProductsForCategory` walks a resolved node + its descendants →
 * `product_category_link` (prod lines) → legacy products, web-visible + deduped, with a canonical
 * URL — no embedding/vector call on this path.
 */

export type CategoryProduct = {
  productKey: string;
  title: string | null;
  sku: string | null;
  shortDescription: string | null;
  url: string | null;
  status: string | null;
  onWeb: string | null;
};

type LooseRow = Record<string, unknown>;
type LooseChain = {
  select: (cols: string) => LooseChain;
  eq: (column: string, value: unknown) => LooseChain;
  in: (column: string, values: readonly unknown[]) => LooseChain;
  ilike: (column: string, value: string) => LooseChain;
} & PromiseLike<{ data: LooseRow[] | null; error: unknown }>;

function from(schema: 'public' | 'legacy', table: string): LooseChain {
  const sb = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: string) => { from: (t: string) => LooseChain };
  };
  return sb.schema(schema).from(table);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export async function loadTaxonomyNodes(): Promise<TaxonomyNode[]> {
  try {
    const { data, error } = await from('public', 'product_category').select(
      'key, name, parent_key, path, aliases',
    );
    if (error || !data) return [];
    return data.map((r) => ({
      key: String(r.key),
      name: String(r.name),
      parentKey: (r.parent_key as string | null) ?? null,
      path: asStringArray(r.path),
      aliases: asStringArray(r.aliases),
    }));
  } catch {
    return [];
  }
}

/** Resolve a query to ranked category candidates against the live taxonomy table. */
export async function resolveCategoryFromDb(
  query: string,
  opts?: ResolveCategoryOptions,
): Promise<CategoryMatch[]> {
  const nodes = await loadTaxonomyNodes();
  return resolveCategory(query, nodes, opts);
}

/** A node key plus all of its descendant keys (pure; unit-testable). */
export function collectDescendantKeys(nodes: TaxonomyNode[], rootKey: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentKey) continue;
    const siblings = childrenByParent.get(node.parentKey) ?? [];
    siblings.push(node.key);
    childrenByParent.set(node.parentKey, siblings);
  }
  const out = new Set<string>();
  const stack = [rootKey];
  while (stack.length > 0) {
    const key = stack.pop() as string;
    if (out.has(key)) continue;
    out.add(key);
    for (const child of childrenByParent.get(key) ?? []) stack.push(child);
  }
  return [...out];
}

/** B0-28 — the full web-visible product set for a category node and its descendants. */
export async function getProductsForCategory(categoryKey: string): Promise<CategoryProduct[]> {
  const nodes = await loadTaxonomyNodes();
  const keys = collectDescendantKeys(nodes, categoryKey);
  if (keys.length === 0) return [];

  const linkRes = await from('public', 'product_category_link')
    .select('prod_line_key')
    .in('category_key', keys);
  const prodLineKeys = [
    ...new Set((linkRes.data ?? []).map((r) => String(r.prod_line_key))),
  ];
  if (prodLineKeys.length === 0) return [];

  const attrRes = await from('legacy', 'products_attr')
    .select('ProductsKey, AttrKey')
    .ilike('AttrTable', 'prodline')
    .in('AttrKey', prodLineKeys);
  const productKeys = [
    ...new Set(
      (attrRes.data ?? [])
        .map((r) => r.ProductsKey)
        .filter((v): v is string => typeof v === 'string'),
    ),
  ];
  if (productKeys.length === 0) return [];

  const [prodRes, descrRes] = await Promise.all([
    from('legacy', 'products')
      .select(
        'ProductsKey, Title, SLDescr, SKU, InvtID, Status, OnWeb, User_Str_00, User_Str_01, User_Str_02, User_Str_03, User_Str_04, User_Str_05',
      )
      .in('ProductsKey', productKeys),
    from('legacy', 'products_descr')
      .select('ProductsKey, ShortDescr, FullDescr, User_Str_00, User_Str_01, User_Str_02, User_Str_03')
      .eq('LanguageCD', 'EN')
      .in('ProductsKey', productKeys),
  ]);

  const descrByKey = new Map<string, LegacyProductDescrRow>();
  for (const d of descrRes.data ?? []) {
    const key = d.ProductsKey;
    if (typeof key === 'string' && !descrByKey.has(key)) {
      descrByKey.set(key, d as unknown as LegacyProductDescrRow);
    }
  }

  const seen = new Set<string>();
  const products: CategoryProduct[] = [];
  for (const row of prodRes.data ?? []) {
    const key = typeof row.ProductsKey === 'string' ? row.ProductsKey : null;
    if (!key || seen.has(key)) continue;
    // B0-28: honor web-visibility — exclude unpublished products.
    if (!['Y', 'YES', 'TRUE', '1'].includes(String(row.OnWeb ?? '').toUpperCase())) continue;
    seen.add(key);
    const product = row as unknown as LegacyProductRow;
    const descr = descrByKey.get(key);
    const link = deriveCanonicalProductUrl({ product, productDescr: descr });
    products.push({
      productKey: key,
      title: (row.Title as string | null) ?? (row.SLDescr as string | null) ?? null,
      sku: (row.SKU as string | null) ?? null,
      shortDescription: descr?.ShortDescr ?? null,
      url: link.url ?? null,
      status: (row.Status as string | null) ?? null,
      onWeb: (row.OnWeb as string | null) ?? null,
    });
  }
  return products;
}
