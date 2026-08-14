import { z } from 'zod';

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

export const getProductCategoryInputSchema = z.object({
  productId: z.string().min(1).max(256),
});

export const findProductsByCategoryInputSchema = z.object({
  query: z.string().min(1).max(256),
  maxResults: z.number().int().min(1).max(50).optional(),
});

export const recommendCrossReferenceInputSchema = z.object({
  competitorProduct: z.string().min(1).max(512),
  competitorBrand: z.string().max(256).optional(),
  maxResults: z.number().int().min(1).max(10).optional(),
});

export const getEfficacyDataInputSchema = z
  .object({
    ...productRefShape,
    organism: z.string().max(256).optional(),
  })
  .refine(hasProductRef, productRefIssue())
  .transform(normalizeProductRef);

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
] as const;

export type ProductToolName = (typeof PRODUCT_TOOL_NAMES)[number];
