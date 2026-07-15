import { z } from 'zod';

export const searchProductDocsInputSchema = z.object({
  /** Use when the product name is known (e.g. "Green Earth All Purpose"). */
  productName: z.string().max(512).optional().default(''),
  topic: z.string().min(1).max(512),
  surfaceType: z.string().max(256).optional(),
  /** Use instead of productName for broad searches where the product is unknown. */
  freeformQuery: z.string().max(512).optional(),
});

export const getProductSpecInputSchema = z.object({
  productId: z.string().min(1).max(256),
});

export const getApprovedUsageGuidanceInputSchema = z.object({
  productId: z.string().min(1).max(256),
  task: z.string().min(1).max(512),
  surfaceType: z.string().min(1).max(256),
  environment: z.string().max(256).optional(),
});

export const getSafetyConstraintsInputSchema = z.object({
  productId: z.string().min(1).max(256),
});

export const getCompatibilityRulesInputSchema = z.object({
  productId: z.string().min(1).max(256),
  surfaceType: z.string().min(1).max(256),
  materialType: z.string().max(256).optional(),
});

export const listAllowedSurfacesInputSchema = z.object({
  productId: z.string().min(1).max(256),
});

export const listDisallowedUsesInputSchema = z.object({
  productId: z.string().min(1).max(256),
});

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

export const getEfficacyDataInputSchema = z.object({
  productId: z.string().min(1).max(256),
  organism: z.string().max(256).optional(),
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
] as const;

export type ProductToolName = (typeof PRODUCT_TOOL_NAMES)[number];
