import { z } from 'zod';

/**
 * B0-487 — contracts for the admin alias review queue (`rag.product_alias`,
 * `rag.product_alias_conflicts`). Mirrors `~/lib/recommendations/recommendation-schemas.ts`:
 * Zod schemas are the source of truth, validated at every repository boundary.
 */

/** Matches the `rag.product_alias.alias_type` check constraint exactly — keep in sync with the DB. */
export const PRODUCT_ALIAS_TYPES = [
  'acronym',
  'common_name',
  'sku',
  'misspelling',
  'legacy_name',
  'synonym',
  'title',
] as const;

export const productAliasTypeSchema = z.enum(PRODUCT_ALIAS_TYPES);
export type ProductAliasType = z.infer<typeof productAliasTypeSchema>;

/** A product line sharing an `alias_norm` with the row this is attached to (B0-484 conflict). */
export const conflictingProductLineSchema = z.object({
  productLineKey: z.string(),
  title: z.string().nullable(),
});
export type ConflictingProductLine = z.infer<typeof conflictingProductLineSchema>;

export const productAliasReviewRowSchema = z.object({
  id: z.string().uuid(),
  aliasNorm: z.string(),
  alias: z.string(),
  entityId: z.string().uuid().nullable(),
  productLineKey: z.string(),
  productLineTitle: z.string().nullable(),
  source: z.string(),
  confidence: z.number(),
  aliasType: productAliasTypeSchema,
  verified: z.boolean(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
  /** true when `aliasNorm` appears in `rag.product_alias_conflicts` (spans >1 product line). */
  isConflict: z.boolean(),
  /** Other product lines sharing this `aliasNorm`, when `isConflict` — empty otherwise. */
  conflictingProductLines: z.array(conflictingProductLineSchema),
});
export type ProductAliasReviewRow = z.infer<typeof productAliasReviewRowSchema>;

export const listUnverifiedProductAliasesInputSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(25),
});
export type ListUnverifiedProductAliasesInput = z.infer<
  typeof listUnverifiedProductAliasesInputSchema
>;

/** Reviewer edit of `product_line_key` and/or `alias_type` — at least one field is required. */
export const editProductAliasInputSchema = z
  .object({
    productLineKey: z.string().trim().min(1, 'A product line key is required.').optional(),
    aliasType: productAliasTypeSchema.optional(),
  })
  .refine((v) => v.productLineKey !== undefined || v.aliasType !== undefined, {
    message: 'Provide a product line key and/or alias type to update.',
  });
export type EditProductAliasInput = z.infer<typeof editProductAliasInputSchema>;
