import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

const CROSS_REFERENCE_ADAPTER_TAG = 'legacy_cross_reference_v1' as const;

type CrossReferenceRow = {
  Competitor: string | null;
  ProductDescr: string | null;
  ProductKey: string | null;
  ProductID: number | null;
  BetcoProdID: number | null;
  id: string | null;
};

type LegacyProductRow = {
  ProductsKey: string | null;
  Title: string | null;
  SKU: string | null;
  SLDescr: string | null;
  InvtID: string | null;
  Status: string | null;
  OnWeb: string | null;
  User_Str_00: string | null;
  User_Str_01: string | null;
  User_Str_02: string | null;
  User_Str_03: string | null;
  User_Str_04: string | null;
  User_Str_05: string | null;
};

type LegacyProductDescrRow = {
  ProductsKey: string | null;
  ShortDescr: string | null;
  FullDescr: string | null;
  User_Str_00: string | null;
  User_Str_01: string | null;
  User_Str_02: string | null;
  User_Str_03: string | null;
};

function normalizeLookupValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/#/g, ' number ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeLookupValue(value: string) {
  const normalized = normalizeLookupValue(value);
  if (!normalized) {
    return [];
  }

  return normalized.split(' ').filter(Boolean);
}

function clampCrossReferenceLimit(value?: number) {
  if (!Number.isFinite(value) || !value || value < 1) {
    return 3;
  }

  return Math.min(Math.floor(value), 10);
}

/** Patterns to search legacy ProductDescr — ILIKE is case-insensitive but `#` vs "number" differs in source data. */
function crossReferenceProductDescrSearchPatterns(productName: string): string[] {
  const trimmed = productName.trim();
  if (!trimmed) {
    return [];
  }

  const normalized = normalizeLookupValue(trimmed);
  const patterns = new Set<string>([trimmed]);
  if (normalized) {
    patterns.add(normalized);
  }

  return [...patterns];
}

function normalizeLegacyUrlCandidate(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^www\.betco\.com\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  if (/^\/products\//i.test(trimmed)) {
    return `https://www.betco.com${trimmed}`;
  }
  if (/^products\//i.test(trimmed)) {
    return `https://www.betco.com/${trimmed}`;
  }

  return null;
}

function toProductSlug(value: string | null | undefined) {
  const normalized = (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[™®]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return normalized || null;
}

function buildGuessedProductUrl(product: LegacyProductRow | undefined) {
  if (!product) {
    return null;
  }

  const slug = toProductSlug(product.Title || product.SLDescr || product.InvtID || product.SKU);
  if (!slug) {
    return null;
  }

  const idSegment = (product.InvtID || product.SKU || '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();

  if (!idSegment) {
    return `https://www.betco.com/products/${slug}`;
  }

  return `https://www.betco.com/products/${slug}/${idSegment}`;
}

function deriveCanonicalProductUrl(input: {
  product: LegacyProductRow | undefined;
  productDescr: LegacyProductDescrRow | undefined;
}) {
  const candidates = [
    input.product?.OnWeb,
    input.product?.User_Str_00,
    input.product?.User_Str_01,
    input.product?.User_Str_02,
    input.product?.User_Str_03,
    input.product?.User_Str_04,
    input.product?.User_Str_05,
    input.productDescr?.User_Str_00,
    input.productDescr?.User_Str_01,
    input.productDescr?.User_Str_02,
    input.productDescr?.User_Str_03,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeLegacyUrlCandidate(candidate);
    if (normalized) {
      return { url: normalized, source: 'legacy' as const };
    }
  }

  const guessed = buildGuessedProductUrl(input.product);
  if (guessed) {
    return { url: guessed, source: 'derived' as const };
  }

  return { url: null, source: 'none' as const };
}

function scoreCrossReferenceRow(
  row: Pick<CrossReferenceRow, 'Competitor' | 'ProductDescr'>,
  input: { brand: string; productName: string },
) {
  const normalizedBrand = normalizeLookupValue(input.brand);
  const normalizedProduct = normalizeLookupValue(input.productName);
  const rowBrand = normalizeLookupValue(row.Competitor ?? '');
  const rowProduct = normalizeLookupValue(row.ProductDescr ?? '');

  const brandExact = rowBrand === normalizedBrand;
  const productExact = rowProduct === normalizedProduct;
  const brandContains = Boolean(normalizedBrand) && rowBrand.includes(normalizedBrand);
  const productContains =
    Boolean(normalizedProduct) && rowProduct.includes(normalizedProduct);

  const productInputTokens = new Set(tokenizeLookupValue(input.productName));
  const productRowTokens = new Set(tokenizeLookupValue(row.ProductDescr ?? ''));
  const sharedProductTokens = [...productInputTokens].filter((token) =>
    productRowTokens.has(token),
  ).length;
  const productTokenScore =
    productInputTokens.size === 0
      ? 0
      : sharedProductTokens / productInputTokens.size;

  const brandScore = brandExact ? 1 : brandContains ? 0.9 : 0.2;
  const productScore = productExact
    ? 1
    : productContains
      ? 0.92
      : Math.max(0.35, productTokenScore);
  const confidence = Number((brandScore * 0.35 + productScore * 0.65).toFixed(3));
  const matchType = brandExact && productExact ? 'exact' : productContains ? 'normalized' : 'fuzzy';

  return {
    matchType,
    confidence,
    brandExact,
    productExact,
    productTokenScore,
  };
}

/** Same pipeline as `lookup_cross_reference` in product tools — shared by admin tester and agents. */
export async function lookupCrossReference(input: {
  brand: string;
  productName: string;
  maxResults?: number;
}) {
  const supabase = getSupabaseServiceRoleClient();
  const legacy = supabase.schema('legacy');
  const maxResults = clampCrossReferenceLimit(input.maxResults);
  const normalizedBrand = normalizeLookupValue(input.brand);
  const normalizedProduct = normalizeLookupValue(input.productName);

  const brandTrimmed = input.brand.trim();

  const { data: competitorRows, error: competitorError } = await legacy
    .from('competitor')
    .select('Competitor, CompetitorID')
    .ilike('Competitor', `%${brandTrimmed}%`)
    .limit(12);

  if (competitorError) {
    throw new Error(`Cross-reference competitor lookup failed: ${competitorError.message}`);
  }

  const brandCandidates = Array.from(
    new Set(
      (competitorRows ?? [])
        .map((row) => row.Competitor?.trim() ?? '')
        .filter(Boolean),
    ),
  );

  /** `competitor_products.Competitor` stores CompetitorID as a digit string (e.g. "15"), not the brand name. */
  let competitorProductKeys = Array.from(
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

  if (competitorProductKeys.length === 0 && /^\d+$/.test(brandTrimmed)) {
    competitorProductKeys = [brandTrimmed];
  }

  const competitorIdToDisplayName = new Map<string, string>();
  for (const row of competitorRows ?? []) {
    const id =
      row.CompetitorID != null && Number.isFinite(Number(row.CompetitorID))
        ? String(Math.trunc(Number(row.CompetitorID)))
        : null;
    const name = row.Competitor?.trim();
    if (id && name && !competitorIdToDisplayName.has(id)) {
      competitorIdToDisplayName.set(id, name);
    }
  }

  const numericIdsForNames = competitorProductKeys
    .map((k) => Number.parseInt(k, 10))
    .filter((n) => Number.isFinite(n));
  const idsMissingNames = numericIdsForNames.filter(
    (n) => !competitorIdToDisplayName.has(String(n)),
  );
  if (idsMissingNames.length > 0) {
    const { data: nameRows } = await legacy
      .from('competitor')
      .select('Competitor, CompetitorID')
      .in('CompetitorID', idsMissingNames);

    for (const row of nameRows ?? []) {
      const id =
        row.CompetitorID != null && Number.isFinite(Number(row.CompetitorID))
          ? String(Math.trunc(Number(row.CompetitorID)))
          : null;
      const name = row.Competitor?.trim();
      if (id && name && !competitorIdToDisplayName.has(id)) {
        competitorIdToDisplayName.set(id, name);
      }
    }
  }

  if (competitorProductKeys.length === 0) {
    return {
      ok: true,
      adapter: CROSS_REFERENCE_ADAPTER_TAG,
      input: {
        brand: input.brand,
        productName: input.productName,
      },
      normalizedInput: {
        brand: normalizedBrand,
        productName: normalizedProduct,
      },
      brandCandidates,
      totalCandidates: 0,
      fallbackRecommended: true,
      matches: [],
    };
  }

  const selectCrossRef = () =>
    legacy
      .from('competitor_products')
      .select('Competitor, ProductDescr, ProductKey, ProductID, BetcoProdID, id');

  let crossReferenceRows: CrossReferenceRow[] | null = null;

  if (input.productName.trim()) {
    const descrPatterns = crossReferenceProductDescrSearchPatterns(input.productName);
    for (const pattern of descrPatterns) {
      const attempt = await selectCrossRef()
        .in('Competitor', competitorProductKeys)
        .ilike('ProductDescr', `%${pattern}%`)
        .limit(250);

      if (attempt.error) {
        throw new Error(`Cross-reference lookup failed: ${attempt.error.message}`);
      }

      if ((attempt.data ?? []).length > 0) {
        crossReferenceRows = attempt.data as CrossReferenceRow[];
        break;
      }
    }
  }

  if (!crossReferenceRows || crossReferenceRows.length === 0) {
    const fallbackResponse = await selectCrossRef()
      .in('Competitor', competitorProductKeys)
      .limit(250);

    if (fallbackResponse.error) {
      throw new Error(
        `Cross-reference fallback lookup failed: ${fallbackResponse.error.message}`,
      );
    }

    crossReferenceRows = (fallbackResponse.data ?? []) as CrossReferenceRow[];
  }

  const rows = (crossReferenceRows ?? []) as CrossReferenceRow[];
  const productKeys = Array.from(
    new Set(rows.map((row) => row.ProductKey).filter((value): value is string => Boolean(value))),
  );

  const productByKey = new Map<string, LegacyProductRow>();
  const productDescrByKey = new Map<string, LegacyProductDescrRow>();

  if (productKeys.length > 0) {
    const [productsResponse, productDescriptionsResponse] = await Promise.all([
      legacy
        .from('products')
        .select(
          'ProductsKey, Title, SKU, SLDescr, InvtID, Status, OnWeb, User_Str_00, User_Str_01, User_Str_02, User_Str_03, User_Str_04, User_Str_05',
        )
        .in('ProductsKey', productKeys),
      legacy
        .from('products_descr')
        .select(
          'ProductsKey, ShortDescr, FullDescr, User_Str_00, User_Str_01, User_Str_02, User_Str_03',
        )
        .in('ProductsKey', productKeys)
        .eq('LanguageCD', 'EN'),
    ]);

    if (productsResponse.error) {
      throw new Error(`Cross-reference product join failed: ${productsResponse.error.message}`);
    }
    if (productDescriptionsResponse.error) {
      throw new Error(
        `Cross-reference product description join failed: ${productDescriptionsResponse.error.message}`,
      );
    }

    for (const row of (productsResponse.data ?? []) as LegacyProductRow[]) {
      if (row.ProductsKey) {
        productByKey.set(row.ProductsKey, row);
      }
    }

    for (const row of (productDescriptionsResponse.data ?? []) as LegacyProductDescrRow[]) {
      if (row.ProductsKey && !productDescrByKey.has(row.ProductsKey)) {
        productDescrByKey.set(row.ProductsKey, row);
      }
    }
  }

  const ranked = rows
    .map((row) => {
      const idKey = String(row.Competitor ?? '').trim();
      const competitorDisplayName = competitorIdToDisplayName.get(idKey) ?? idKey;

      const score = scoreCrossReferenceRow(
        { Competitor: competitorDisplayName, ProductDescr: row.ProductDescr },
        input,
      );
      const product = row.ProductKey ? productByKey.get(row.ProductKey) : undefined;
      const productDescr = row.ProductKey ? productDescrByKey.get(row.ProductKey) : undefined;

      return {
        row,
        competitorDisplayName,
        score,
        product,
        productDescr,
      };
    })
    .sort((a, b) => b.score.confidence - a.score.confidence);

  const deduped = new Map<string, (typeof ranked)[number]>();
  for (const candidate of ranked) {
    const dedupeKey = [
      candidate.row.Competitor ?? '',
      candidate.row.ProductDescr ?? '',
      candidate.row.ProductKey ?? '',
      candidate.row.BetcoProdID ?? '',
    ].join('|');

    if (!deduped.has(dedupeKey)) {
      deduped.set(dedupeKey, candidate);
    }
  }

  const topMatches = [...deduped.values()].slice(0, maxResults).map((candidate) => {
    const productLink = deriveCanonicalProductUrl({
      product: candidate.product,
      productDescr: candidate.productDescr,
    });

    return {
      competitorBrand: candidate.competitorDisplayName,
      competitorProductName: candidate.row.ProductDescr,
      productKey: candidate.row.ProductKey,
      competitorProductId: candidate.row.ProductID,
      betcoProductId: candidate.row.BetcoProdID,
      legacyRowId: candidate.row.id,
      matchType: candidate.score.matchType,
      confidence: candidate.score.confidence,
      productUrl: productLink.url,
      productUrlSource: productLink.source,
      betcoProduct:
        candidate.product || candidate.productDescr
          ? {
              title: candidate.product?.Title ?? null,
              sku: candidate.product?.SKU ?? null,
              shortLabel: candidate.product?.SLDescr ?? null,
              inventoryId: candidate.product?.InvtID ?? null,
              status: candidate.product?.Status ?? null,
              onWeb: candidate.product?.OnWeb ?? null,
              shortDescription: candidate.productDescr?.ShortDescr ?? null,
              fullDescription: candidate.productDescr?.FullDescr ?? null,
            }
          : null,
    };
  });

  return {
    ok: true,
    adapter: CROSS_REFERENCE_ADAPTER_TAG,
    input: {
      brand: input.brand,
      productName: input.productName,
    },
    normalizedInput: {
      brand: normalizedBrand,
      productName: normalizedProduct,
    },
    brandCandidates,
    totalCandidates: rows.length,
    fallbackRecommended: rows.length === 0 || (topMatches[0]?.confidence ?? 0) < 0.75,
    matches: topMatches,
  };
}
