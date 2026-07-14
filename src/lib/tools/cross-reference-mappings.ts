import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * Read-only browse of the previous tool's 1:1 competitor → Betco cross-reference matchings
 * (legacy.competitor_products joined to legacy.products on ProductKey = ProductsKey). This is the
 * same ground-truth mapping that backs the B0-99 golden recommendation eval set. Used by the
 * admin table on /admin/tools/product-cross-reference. Not the ranked agent lookup — that lives in
 * `lookupCrossReference`.
 */

export type CrossReferenceMappingRow = {
  id: string | null;
  competitorId: string | null;
  competitorBrand: string | null;
  competitorProductName: string | null;
  productKey: string | null;
  betcoTitle: string | null;
  betcoSku: string | null;
  betcoInventoryId: string | null;
  betcoProductLineId: string | null;
};

export type CrossReferenceMappingsPage = {
  rows: CrossReferenceMappingRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export const CROSS_REFERENCE_MAPPINGS_PAGE_SIZE = 25;

function clampPage(value: number | undefined) {
  if (!Number.isFinite(value) || !value || value < 1) {
    return 1;
  }
  return Math.floor(value);
}

/** PostgREST `.or()` values can't contain commas/parens; keep search terms simple. */
function sanitizeSearch(value: string | undefined) {
  return (value ?? '').trim().replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function fetchCrossReferenceMappings(input: {
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<CrossReferenceMappingsPage> {
  const supabase = getSupabaseServiceRoleClient();
  const legacy = supabase.schema('legacy');

  const pageSize = input.pageSize ?? CROSS_REFERENCE_MAPPINGS_PAGE_SIZE;
  const page = clampPage(input.page);
  const search = sanitizeSearch(input.search);

  // When searching, also match on competitor BRAND by resolving matching competitor ids first
  // (competitor_products.Competitor stores CompetitorID as a digit string, not the brand name).
  let brandCompetitorIds: string[] = [];
  if (search) {
    const { data: competitorRows } = await legacy
      .from('competitor')
      .select('CompetitorID, Competitor')
      .ilike('Competitor', `%${search}%`)
      .limit(50);
    brandCompetitorIds = Array.from(
      new Set(
        (competitorRows ?? [])
          .map((row) =>
            row.CompetitorID != null && Number.isFinite(Number(row.CompetitorID))
              ? String(Math.trunc(Number(row.CompetitorID)))
              : null,
          )
          .filter((v): v is string => Boolean(v)),
      ),
    );
  }

  const rangeStart = (page - 1) * pageSize;
  const rangeEnd = rangeStart + pageSize - 1;

  let query = legacy
    .from('competitor_products')
    .select('id, Competitor, ProductDescr, ProductKey, ProductID', { count: 'exact' });

  if (search) {
    const orParts = [`ProductDescr.ilike.%${search}%`];
    if (brandCompetitorIds.length > 0) {
      orParts.push(`Competitor.in.(${brandCompetitorIds.join(',')})`);
    }
    query = query.or(orParts.join(','));
  }

  const { data: mappingRows, count, error } = await query
    .order('ProductDescr', { ascending: true })
    .range(rangeStart, rangeEnd);

  if (error) {
    throw new Error(`Cross-reference mappings query failed: ${error.message}`);
  }

  const rows = mappingRows ?? [];
  const total = count ?? 0;

  // Resolve competitor brand names for the ids on this page.
  const competitorIds = Array.from(
    new Set(
      rows
        .map((row) => (row.Competitor ?? '').trim())
        .filter(Boolean)
        .map((v) => Number.parseInt(v, 10))
        .filter((n) => Number.isFinite(n)),
    ),
  );
  const brandById = new Map<string, string>();
  if (competitorIds.length > 0) {
    const { data: names } = await legacy
      .from('competitor')
      .select('CompetitorID, Competitor')
      .in('CompetitorID', competitorIds);
    for (const row of names ?? []) {
      const id =
        row.CompetitorID != null && Number.isFinite(Number(row.CompetitorID))
          ? String(Math.trunc(Number(row.CompetitorID)))
          : null;
      const name = row.Competitor?.trim();
      if (id && name && !brandById.has(id)) {
        brandById.set(id, name);
      }
    }
  }

  // Resolve the matched Betco product (title/SKU/line) for the ProductKeys on this page.
  const productKeys = Array.from(
    new Set(rows.map((row) => row.ProductKey).filter((v): v is string => Boolean(v))),
  );
  const productByKey = new Map<
    string,
    { title: string | null; sku: string | null; invtId: string | null; prodLine: string | null }
  >();
  if (productKeys.length > 0) {
    const { data: products } = await legacy
      .from('products')
      .select('ProductsKey, Title, SLDescr, SKU, InvtID, DSLProdLn')
      .in('ProductsKey', productKeys);
    for (const product of products ?? []) {
      if (!product.ProductsKey) {
        continue;
      }
      productByKey.set(product.ProductsKey, {
        title: product.SLDescr || product.Title || null,
        sku: product.SKU ?? null,
        invtId: product.InvtID ?? null,
        prodLine: product.DSLProdLn ?? null,
      });
    }
  }

  const mapped: CrossReferenceMappingRow[] = rows.map((row) => {
    const competitorId = (row.Competitor ?? '').trim() || null;
    const product = row.ProductKey ? productByKey.get(row.ProductKey) : undefined;
    return {
      id: row.id,
      competitorId,
      competitorBrand: competitorId ? (brandById.get(competitorId) ?? competitorId) : null,
      competitorProductName: row.ProductDescr,
      productKey: row.ProductKey,
      betcoTitle: product?.title ?? null,
      betcoSku: product?.sku ?? null,
      betcoInventoryId: product?.invtId ?? null,
      betcoProductLineId: product?.prodLine ?? null,
    };
  });

  return {
    rows: mapped,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
