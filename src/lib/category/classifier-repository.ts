import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-35 — live persistence + input-loading for the product→category classifier.
 *
 * Classifier proposals are written to `public.product_category_link` with `source='classifier'`,
 * which distinguishes them from the authoritative `betco_site_scrape` links (B0-34) and from
 * human-curated links (B0-36). A proposal never clobbers a non-classifier link for the same
 * (category, prod_line): human curation and site-scrape placements are preserved across re-runs.
 */

export const CLASSIFIER_LINK_SOURCE = 'classifier';

export type ClassifierLink = {
  prodLineKey: string;
  prodLineId: string | null;
  categoryKey: string;
  confidence: number;
};

export type ProdLineClassifierInput = {
  prodLineKey: string;
  prodLineId: string | null;
  title: string | null;
  description: string | null;
};

type LooseRow = Record<string, unknown>;

/**
 * Upsert a classifier proposal link. Preserves any existing non-classifier link for the same
 * (category_key, prod_line_key) — only classifier-sourced rows are re-written on a repeat run.
 */
export async function upsertClassifierLink(link: ClassifierLink): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();

  const { data: existing } = await supabase
    .schema('public')
    .from('product_category_link')
    .select('source')
    .eq('category_key', link.categoryKey)
    .eq('prod_line_key', link.prodLineKey)
    .maybeSingle();

  if (existing && (existing as { source?: string }).source !== CLASSIFIER_LINK_SOURCE) {
    // A site-scrape or human-curated link owns this pair; never silently overwrite it.
    return;
  }

  const { error } = await supabase
    .schema('public')
    .from('product_category_link')
    .upsert(
      {
        category_key: link.categoryKey,
        prod_line_key: link.prodLineKey,
        prod_line_id: link.prodLineId,
        source: CLASSIFIER_LINK_SOURCE,
        confidence: link.confidence,
      },
      { onConflict: 'category_key,prod_line_key' },
    );

  if (error) throw new Error(error.message);
}

/**
 * Resolve title/description text for a set of prod-line keys via a representative legacy product.
 * Best-effort: a prod-line with no resolvable product yields nulls (still classifiable, low signal).
 */
export async function loadProdLineClassifierInputs(
  prodLineKeys: string[],
): Promise<ProdLineClassifierInput[]> {
  if (prodLineKeys.length === 0) return [];
  const supabase = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: string) => {
      from: (t: string) => {
        select: (cols: string) => {
          in: (col: string, values: readonly unknown[]) => PromiseLike<{ data: LooseRow[] | null }>;
          ilike: (col: string, v: string) => {
            in: (col: string, values: readonly unknown[]) => PromiseLike<{ data: LooseRow[] | null }>;
          };
          eq: (col: string, v: unknown) => {
            in: (col: string, values: readonly unknown[]) => PromiseLike<{ data: LooseRow[] | null }>;
          };
        };
      };
    };
  };
  const legacy = (table: string) => supabase.schema('legacy').from(table);

  // prod-line → one representative ProductsKey (via prodline attrs).
  const attrRes = await legacy('products_attr')
    .select('ProductsKey, AttrKey')
    .ilike('AttrTable', 'prodline')
    .in('AttrKey', prodLineKeys);
  const repByLine = new Map<string, string>();
  for (const r of attrRes.data ?? []) {
    const line = String(r.AttrKey ?? '');
    const pk = typeof r.ProductsKey === 'string' ? r.ProductsKey : null;
    if (line && pk && !repByLine.has(line)) repByLine.set(line, pk);
  }

  const productKeys = [...new Set(repByLine.values())];
  const titleByKey = new Map<string, string | null>();
  const descrByKey = new Map<string, string | null>();
  if (productKeys.length > 0) {
    const [prodRes, dRes] = await Promise.all([
      legacy('products').select('ProductsKey, Title, SLDescr').in('ProductsKey', productKeys),
      legacy('products_descr')
        .select('ProductsKey, ShortDescr, FullDescr')
        .eq('LanguageCD', 'EN')
        .in('ProductsKey', productKeys),
    ]);
    for (const r of prodRes.data ?? []) {
      if (typeof r.ProductsKey === 'string') {
        titleByKey.set(r.ProductsKey, (r.Title as string | null) ?? (r.SLDescr as string | null) ?? null);
      }
    }
    for (const r of dRes.data ?? []) {
      if (typeof r.ProductsKey === 'string' && !descrByKey.has(r.ProductsKey)) {
        descrByKey.set(r.ProductsKey, (r.ShortDescr as string | null) ?? (r.FullDescr as string | null) ?? null);
      }
    }
  }

  return prodLineKeys.map((prodLineKey) => {
    const pk = repByLine.get(prodLineKey) ?? null;
    return {
      prodLineKey,
      prodLineId: pk,
      title: pk ? (titleByKey.get(pk) ?? null) : null,
      description: pk ? (descrByKey.get(pk) ?? null) : null,
    };
  });
}
