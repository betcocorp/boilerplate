import { z } from 'zod';

/**
 * B0-83 — contracts for the durable cross-reference recommendation store (B0-82).
 * Contract-first: these Zod schemas are the source of truth; the repository validates every
 * read/write boundary against them.
 */

/** JSONB object columns (normalized_input / evidence / candidate source). */
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const recommendationStatusSchema = z.enum([
  'pending',
  'answered',
  'declined',
  'verified',
  'rejected',
]);
export type RecommendationStatus = z.infer<typeof recommendationStatusSchema>;

export const recommendationCandidateSchema = z.object({
  id: z.string().uuid(),
  recommendationId: z.string().uuid(),
  betcoProductKey: z.string().nullable(),
  betcoProdId: z.string().nullable(),
  betcoTitle: z.string().nullable(),
  candidateConfidence: z.number().nullable(),
  rank: z.number().int().nullable(),
  rationale: z.string().nullable(),
  source: jsonObjectSchema,
  createdAt: z.string(),
});
export type RecommendationCandidate = z.infer<typeof recommendationCandidateSchema>;

export const recommendationSchema = z.object({
  id: z.string().uuid(),
  competitorBrand: z.string().nullable(),
  competitorProduct: z.string(),
  normalizedInput: jsonObjectSchema,
  status: recommendationStatusSchema,
  overallConfidence: z.number().nullable(),
  thresholdUsed: z.number().nullable(),
  answerGiven: z.boolean(),
  declineReason: z.string().nullable(),
  evidence: jsonObjectSchema,
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Recommendation = z.infer<typeof recommendationSchema>;

export const recommendationWithCandidatesSchema = recommendationSchema.extend({
  candidates: z.array(recommendationCandidateSchema),
});
export type RecommendationWithCandidates = z.infer<typeof recommendationWithCandidatesSchema>;

// --- inputs ---

export const createCandidateInputSchema = z.object({
  betcoProductKey: z.string().nullable().optional(),
  betcoProdId: z.string().nullable().optional(),
  betcoTitle: z.string().nullable().optional(),
  candidateConfidence: z.number().nullable().optional(),
  rank: z.number().int().nullable().optional(),
  rationale: z.string().nullable().optional(),
  source: jsonObjectSchema.optional(),
});
export type CreateCandidateInput = z.infer<typeof createCandidateInputSchema>;

export const createRecommendationInputSchema = z.object({
  competitorBrand: z.string().nullable().optional(),
  competitorProduct: z.string().min(1),
  normalizedInput: jsonObjectSchema.optional(),
  status: recommendationStatusSchema.default('pending'),
  overallConfidence: z.number().nullable().optional(),
  thresholdUsed: z.number().nullable().optional(),
  answerGiven: z.boolean().default(false),
  declineReason: z.string().nullable().optional(),
  evidence: jsonObjectSchema.optional(),
  createdBy: z.string().nullable().optional(),
  candidates: z.array(createCandidateInputSchema).default([]),
});
export type CreateRecommendationInput = z.infer<typeof createRecommendationInputSchema>;

export const updateRecommendationStatusInputSchema = z.object({
  status: recommendationStatusSchema,
  verifier: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});
export type UpdateRecommendationStatusInput = z.infer<
  typeof updateRecommendationStatusInputSchema
>;

export const listRecommendationsInputSchema = z.object({
  status: recommendationStatusSchema.optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
});
export type ListRecommendationsInput = z.infer<typeof listRecommendationsInputSchema>;

/**
 * B0-433 — reviewer-authored candidate, for recommendations the engine returned nothing usable for.
 *
 * Title and product key are both REQUIRED, unlike the engine's own `createCandidateInputSchema`:
 * `promoteRecommendationToOverride` refuses to promote a candidate missing either, so accepting a
 * partial candidate here would just recreate the un-approvable state this exists to fix.
 */
export const addRecommendationCandidateInputSchema = z.object({
  betcoTitle: z.string().trim().min(1, 'A Betco product title is required.'),
  betcoProductKey: z.string().trim().min(1, 'A Betco product key is required.'),
  betcoProdId: z.string().trim().min(1).nullable().optional(),
  rationale: z.string().trim().min(1).nullable().optional(),
});
export type AddRecommendationCandidateInput = z.infer<
  typeof addRecommendationCandidateInputSchema
>;

/** B0-95 — reviewer edit of a single candidate row (e.g. correcting the chosen Betco product). */
export const updateRecommendationCandidateInputSchema = z.object({
  betcoProductKey: z.string().min(1).nullable().optional(),
  betcoProdId: z.string().min(1).nullable().optional(),
  betcoTitle: z.string().min(1).nullable().optional(),
  rationale: z.string().nullable().optional(),
});
export type UpdateRecommendationCandidateInput = z.infer<
  typeof updateRecommendationCandidateInputSchema
>;
