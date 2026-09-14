import { z } from 'zod';

import { MAX_KNOWLEDGE_ASSET_RESULTS } from '~/lib/retrieval/knowledge-assets';
import { webSearchDepthSchema } from '~/lib/websearch/websearch-schemas';

/**
 * B0-362: `topic` is optional. The tool prose (and the product-support prompt) tells the
 * model to call this with `freeformQuery` alone when the product is unknown, so requiring
 * `topic` rejected ~32% of calls. `executeProductTool` never reads `topic` when
 * `freeformQuery` is set, and otherwise composes the query from
 * productName/topic/surfaceType — so the only genuinely invalid input is one where every
 * query field is empty (which would produce an empty search string).
 */
export const searchProductDocsInputSchema = z
  .object({
    /** Use when the product name is known (e.g. "Green Earth All Purpose"). */
    productName: z.string().max(512).optional().default(''),
    topic: z.string().max(512).optional(),
    surfaceType: z.string().max(256).optional(),
    /** Use instead of productName for broad searches where the product is unknown. */
    freeformQuery: z.string().max(512).optional(),
    /**
     * B0-460 — by default the model-facing copy of a `product_line_profile` source has its
     * "Size and package variants" section (every SKU/package variant: product keys, SKUs,
     * inventory IDs, web availability, MSRPs) collapsed to a one-line note — none of that feeds an
     * ordinary answer and it was bloating the final-call prompt. Set this when the question actually
     * asks about sizes, SKUs, package options, or pricing to get the full variant list back.
     */
    includeVariants: z.boolean().optional().default(false),
  })
  .refine(
    (v) =>
      Boolean(
        v.freeformQuery?.trim() ||
          v.topic?.trim() ||
          v.productName?.trim() ||
          v.surfaceType?.trim(),
      ),
    {
      message:
        'Provide `freeformQuery` or `topic` (a `productName` and/or `surfaceType` alone is also accepted).',
      path: ['topic'],
    },
  );

/**
 * B0-364: on the product-fact tools, `productId` is really a product *name* string — it is
 * handed straight to `resolveProductEntityByName()`. Models routinely send `productName`
 * instead (the spelling every tool description uses in prose), which used to be a hard
 * schema rejection. Accept either key and normalize onto `productId` so the tool
 * implementations and downstream retrieval helpers are unchanged.
 */
const productRefShape = {
  /** Betco product name or code — resolved by name, not a database id. */
  productId: z.string().max(256).optional(),
  /** Alias for `productId`; normalized away by `normalizeProductRef`. */
  productName: z.string().max(256).optional(),
};

type ProductRefInput = { productId?: string; productName?: string };

const hasProductRef = (v: ProductRefInput): boolean =>
  Boolean(v.productId?.trim() || v.productName?.trim());

const productRefIssue = () => ({
  message:
    'Provide the Betco product name or code as `productId` (`productName` is accepted as an alias).',
  path: ['productId'] as PropertyKey[],
});

function normalizeProductRef<T extends ProductRefInput>(v: T) {
  const { productName, productId, ...rest } = v;
  return { ...rest, productId: (productId?.trim() || productName?.trim() || '') as string };
}

export const getProductSpecInputSchema = z
  .object(productRefShape)
  .refine(hasProductRef, productRefIssue())
  .transform(normalizeProductRef);

export const getApprovedUsageGuidanceInputSchema = z
  .object({
    ...productRefShape,
    task: z.string().min(1).max(512),
    surfaceType: z.string().min(1).max(256),
    environment: z.string().max(256).optional(),
  })
  .refine(hasProductRef, productRefIssue())
  .transform(normalizeProductRef);

export const getSafetyConstraintsInputSchema = z
  .object(productRefShape)
  .refine(hasProductRef, productRefIssue())
  .transform(normalizeProductRef);

export const getCompatibilityRulesInputSchema = z
  .object({
    ...productRefShape,
    surfaceType: z.string().min(1).max(256),
    materialType: z.string().max(256).optional(),
  })
  .refine(hasProductRef, productRefIssue())
  .transform(normalizeProductRef);

export const listAllowedSurfacesInputSchema = z
  .object(productRefShape)
  .refine(hasProductRef, productRefIssue())
  .transform(normalizeProductRef);

export const listDisallowedUsesInputSchema = z
  .object(productRefShape)
  .refine(hasProductRef, productRefIssue())
  .transform(normalizeProductRef);

export const getEscalationPolicyInputSchema = z.object({
  issueType: z.string().min(1).max(256),
});

export const lookupCrossReferenceInputSchema = z.object({
  brand: z.string().min(1).max(256),
  productName: z.string().min(1).max(512),
  maxResults: z.number().int().min(1).max(10).optional(),
});

export const getProductsInCategoryInputSchema = z.object({
  categoryName: z.string().min(1).max(256),
  categoryLevel: z
    .enum(['prod_type', 'sub_prod_type', 'sub_child_prod_type', 'prod_class', 'any'])
    .optional(),
  maxResults: z.number().int().min(1).max(50).optional(),
});

/** B0-983: accepts the `productName` alias like every other per-product tool (B0-364). */
export const getProductCategoryInputSchema = z
  .object(productRefShape)
  .refine(hasProductRef, productRefIssue())
  .transform(normalizeProductRef);

export const findProductsByCategoryInputSchema = z.object({
  query: z.string().min(1).max(256),
  maxResults: z.number().int().min(1).max(50).optional(),
});

export const recommendCrossReferenceInputSchema = z.object({
  competitorProduct: z.string().min(1).max(512),
  competitorBrand: z.string().max(256).optional(),
  maxResults: z.number().int().min(1).max(10).optional(),
});

/** B0-549: cap on how many product lines a single batch `get_efficacy_data` call resolves —
 * generous enough to collapse the worst observed case (27 sequential single-product calls in one
 * turn) into one call, while still bounding the fan-out of per-product lab-report lookups. */
export const EFFICACY_BATCH_MAX_PRODUCTS = 30;

export const getEfficacyDataInputSchema = z
  .object({
    ...productRefShape,
    /**
     * B0-549 — batch form: verified dilution/efficacy facts for SEVERAL product lines in one
     * call, instead of one `get_efficacy_data` call per product. Provide this OR
     * `productId`/`productName` (not required together) — when both `productIds` and `category`
     * are omitted, the call behaves exactly as before (single product, unchanged response shape).
     */
    productIds: z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(EFFICACY_BATCH_MAX_PRODUCTS)
      .optional(),
    /**
     * B0-549 — batch form: resolve the product-line set from a category name instead of an
     * explicit `productIds` list (same category resolution as `get_products_in_category`).
     */
    category: z.string().min(1).max(256).optional(),
    categoryLevel: z
      .enum(['prod_type', 'sub_prod_type', 'sub_child_prod_type', 'prod_class', 'any'])
      .optional(),
    organism: z.string().max(256).optional(),
  })
  .refine(
    (v) => hasProductRef(v) || (v.productIds?.length ?? 0) > 0 || Boolean(v.category?.trim()),
    {
      message:
        'Provide `productId`/`productName` for a single product, or `productIds` (array of names/codes) or `category` for a batch efficacy lookup.',
      path: ['productId'],
    },
  )
  .transform(normalizeProductRef);

/**
 * B0-529 — `get_dispenser_asset` / `get_floor_asset`.
 *
 * Every field is optional and the refine requires at least one: the model rarely has all three, and
 * a hard-required field is exactly what made `search_product_docs` reject ~32% of calls (B0-362).
 * The executor composes whichever fields arrived into one retrieval query.
 */
const knowledgeAssetMaxResults = z
  .number()
  .int()
  .min(1)
  .max(MAX_KNOWLEDGE_ASSET_RESULTS)
  .optional();

export const getDispenserAssetInputSchema = z
  .object({
    /** Dispenser / proportioner model or family, e.g. "FastDraw", "Clario". */
    dispenserModel: z.string().max(256).optional(),
    /** Betco product the dispenser is set up for, when known. */
    productName: z.string().max(256).optional(),
    /** What is being asked, e.g. "metering tip selection", "dilution ratio chart". */
    topic: z.string().max(512).optional(),
    maxResults: knowledgeAssetMaxResults,
  })
  .refine(
    (v) => Boolean(v.dispenserModel?.trim() || v.productName?.trim() || v.topic?.trim()),
    {
      message: 'Provide at least one of `dispenserModel`, `productName`, or `topic`.',
      path: ['topic'],
    },
  );

export const getFloorAssetInputSchema = z
  .object({
    /** Floor surface, e.g. "VCT", "terrazzo", "sealed concrete". */
    surfaceType: z.string().max(256).optional(),
    /** Betco or Basic Coatings product, when the question names one. */
    productName: z.string().max(256).optional(),
    /** The procedure or chart wanted, e.g. "coat count", "top scrub recoat", "coverage yield". */
    procedure: z.string().max(512).optional(),
    maxResults: knowledgeAssetMaxResults,
  })
  .refine(
    (v) => Boolean(v.surfaceType?.trim() || v.productName?.trim() || v.procedure?.trim()),
    {
      message: 'Provide at least one of `surfaceType`, `productName`, or `procedure`.',
      path: ['procedure'],
    },
  );

/**
 * B0-595 — general-purpose web search, callable mid-turn by any SME agent / the orchestrator
 * (not just the cross-reference-scoped search buried inside `recommend_cross_reference`).
 * Deliberately reuses `webSearchRequestSchema`'s exact shape, flattened onto this tool's own
 * input, rather than inventing a third divergent "settings" shape — `executeProductTool` hands
 * the parsed args straight to `WebSearchService.search()` unchanged.
 */
export const webSearchToolInputSchema = z.object({
  query: z.string().min(1).max(2000),
  depth: webSearchDepthSchema.optional(),
  domains: z.array(z.string().min(1).max(253)).max(50).optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
});

export const PRODUCT_TOOL_NAMES = [
  'search_product_docs',
  'get_product_spec',
  'get_approved_usage_guidance',
  'get_safety_constraints',
  'get_compatibility_rules',
  'list_allowed_surfaces',
  'list_disallowed_uses',
  'get_escalation_policy',
  'lookup_cross_reference',
  'get_products_in_category',
  'get_product_category',
  'find_products_by_category',
  'recommend_cross_reference',
  'get_efficacy_data',
  'get_dispenser_asset',
  'get_floor_asset',
  'web_search',
] as const;

export type ProductToolName = (typeof PRODUCT_TOOL_NAMES)[number];
