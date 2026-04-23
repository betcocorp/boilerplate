import {
  retrieveApprovedUsage,
  retrieveCompatibility,
  retrieveSafetyConstraints,
  retrieveSurfacesLists,
} from '~/lib/retrieval/product-guidance';
import {
  type CuratedSource,
  ragQueryForProductKnowledgeWithMeta,
} from '~/lib/retrieval/product-knowledge';

import {
  getApprovedUsageGuidanceInputSchema,
  getCompatibilityRulesInputSchema,
  getEscalationPolicyInputSchema,
  getProductSpecInputSchema,
  getSafetyConstraintsInputSchema,
  listAllowedSurfacesInputSchema,
  listDisallowedUsesInputSchema,
  lookupCrossReferenceInputSchema,
  searchProductDocsInputSchema,
  type ProductToolName,
} from '~/lib/tools/tool-schemas';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

const ADAPTER_TAG = 'rag_corpus_transitional' as const;
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

async function lookupCrossReference(input: {
  brand: string;
  productName: string;
  maxResults?: number;
}) {
  const supabase = getSupabaseServiceRoleClient();
  const legacy = supabase.schema('legacy');
  const maxResults = clampCrossReferenceLimit(input.maxResults);
  const normalizedBrand = normalizeLookupValue(input.brand);
  const normalizedProduct = normalizeLookupValue(input.productName);

  const { data: competitorRows, error: competitorError } = await legacy
    .from('competitor')
    .select('Competitor')
    .ilike('Competitor', `%${input.brand.trim()}%`)
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

  const filterBrands = brandCandidates.length > 0 ? brandCandidates : [input.brand.trim()];

  let query = legacy
    .from('competitor_products')
    .select('Competitor, ProductDescr, ProductKey, ProductID, BetcoProdID, id')
    .in('Competitor', filterBrands)
    .limit(250);

  if (input.productName.trim()) {
    query = query.ilike('ProductDescr', `%${input.productName.trim()}%`);
  }

  let { data: crossReferenceRows, error: crossReferenceError } = await query;

  if (crossReferenceError) {
    throw new Error(`Cross-reference lookup failed: ${crossReferenceError.message}`);
  }

  if ((crossReferenceRows ?? []).length === 0) {
    const fallbackResponse = await legacy
      .from('competitor_products')
      .select('Competitor, ProductDescr, ProductKey, ProductID, BetcoProdID, id')
      .in('Competitor', filterBrands)
      .limit(250);

    if (fallbackResponse.error) {
      throw new Error(
        `Cross-reference fallback lookup failed: ${fallbackResponse.error.message}`,
      );
    }

    crossReferenceRows = fallbackResponse.data;
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
      const score = scoreCrossReferenceRow(row, input);
      const product = row.ProductKey ? productByKey.get(row.ProductKey) : undefined;
      const productDescr = row.ProductKey ? productDescrByKey.get(row.ProductKey) : undefined;

      return {
        row,
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
      competitorBrand: candidate.row.Competitor,
      competitorProductName: candidate.row.ProductDescr,
      productKey: candidate.row.ProductKey,
      competitorProductId: candidate.row.ProductID,
      betcoProductId: candidate.row.BetcoProdID,
      legacyRowId: candidate.row.id,
      matchType: candidate.score.matchType,
      confidence: candidate.score.confidence,
      productUrl: productLink.url,
      productUrlSource: productLink.source,
      betcoProduct: candidate.product
        ? {
            title: candidate.product.Title,
            sku: candidate.product.SKU,
            shortLabel: candidate.product.SLDescr,
            inventoryId: candidate.product.InvtID,
            status: candidate.product.Status,
            onWeb: candidate.product.OnWeb,
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

function sourcePayload(sources: CuratedSource[]) {
  return sources.map((s) => ({
    documentId: s.documentId,
    chunkId: s.chunkId,
    title: s.title,
    snippet: s.snippet,
    confidence: s.similarity,
    freshness: null as null,
  }));
}

const ESCALATION_MAP: Record<string, { summary: string; steps: string[] }> = {
  default: {
    summary: 'Standard product-support escalation.',
    steps: [
      'Capture exact product name/SKU and surface/material.',
      'If safety-critical or unclear from approved docs, route to human product specialist.',
      'Do not speculate on off-label use.',
    ],
  },
  safety: {
    summary: 'Safety or exposure concern.',
    steps: [
      'Refer to SDS and label; recommend medical advice for health incidents.',
      'Escalate to EHS / safety contact per account rules.',
    ],
  },
  compatibility: {
    summary: 'Surface or material compatibility uncertain.',
    steps: [
      'Verify with approved documentation only; if absent, recommend spot test per label or escalate.',
    ],
  },
};

function escalationForIssueType(raw: string) {
  const key = raw.trim().toLowerCase();
  if (
    key.includes('safety') ||
    key.includes('exposure') ||
    key.includes('sds')
  ) {
    return ESCALATION_MAP.safety;
  }
  if (
    key.includes('compat') ||
    key.includes('surface') ||
    key.includes('material')
  ) {
    return ESCALATION_MAP.compatibility;
  }
  return ESCALATION_MAP.default;
}

export async function executeProductTool(
  name: ProductToolName,
  args: unknown,
): Promise<Record<string, unknown>> {
  switch (name) {
    case 'search_product_docs': {
      const p = searchProductDocsInputSchema.parse(args);
      const q = [p.productName, p.topic, p.surfaceType]
        .filter(Boolean)
        .join(' ');
      const result = await ragQueryForProductKnowledgeWithMeta({ query: q, limit: 8 });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        query: q,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'get_product_spec': {
      const p = getProductSpecInputSchema.parse(args);
      const q = `${p.productId} specifications technical datasheet performance`;
      const result = await ragQueryForProductKnowledgeWithMeta({ query: q, limit: 6 });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'get_approved_usage_guidance': {
      const p = getApprovedUsageGuidanceInputSchema.parse(args);
      const result = await retrieveApprovedUsage(p);
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        task: p.task,
        surfaceType: p.surfaceType,
        environment: p.environment ?? null,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'get_safety_constraints': {
      const p = getSafetyConstraintsInputSchema.parse(args);
      const result = await retrieveSafetyConstraints(p);
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'get_compatibility_rules': {
      const p = getCompatibilityRulesInputSchema.parse(args);
      const result = await retrieveCompatibility(p);
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        surfaceType: p.surfaceType,
        materialType: p.materialType ?? null,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'list_allowed_surfaces': {
      const p = listAllowedSurfacesInputSchema.parse(args);
      const result = await retrieveSurfacesLists({
        productId: p.productId,
        mode: 'allowed',
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'list_disallowed_uses': {
      const p = listDisallowedUsesInputSchema.parse(args);
      const result = await retrieveSurfacesLists({
        productId: p.productId,
        mode: 'disallowed',
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'get_escalation_policy': {
      const p = getEscalationPolicyInputSchema.parse(args);
      const policy = escalationForIssueType(p.issueType);
      return {
        ok: true,
        adapter: 'static_policy_v1',
        issueType: p.issueType,
        policy,
      };
    }
    case 'lookup_cross_reference': {
      const p = lookupCrossReferenceInputSchema.parse(args);
      return lookupCrossReference(p);
    }
  }
}
