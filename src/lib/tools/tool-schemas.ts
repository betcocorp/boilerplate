import { z } from 'zod';

export const searchProductDocsInputSchema = z.object({
  productName: z.string().min(1).max(512),
  topic: z.string().min(1).max(512),
  surfaceType: z.string().max(256).optional(),
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
] as const;

export type ProductToolName = (typeof PRODUCT_TOOL_NAMES)[number];
