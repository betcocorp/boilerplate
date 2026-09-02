import { z } from 'zod';

import { XREF_DECLINE_COPY, resolveXrefThreshold } from '~/lib/recommendations/confidence-scoring';

/**
 * B0-90 — the cross-reference recommendation prompt + structured-output contract.
 *
 * The deterministic engine (B0-85) picks candidates and gates on confidence; this prompt is the
 * grounded *presentation* pass that composes the user-facing answer from the engine's candidates +
 * web evidence, or declines verbatim. The threshold is injected from config (never hardcoded in the
 * text) and the decline copy is the single shared `XREF_DECLINE_COPY` constant reused by the gate.
 */

export const recommendationAnswerCandidateSchema = z.object({
  betco_product: z.string(),
  product_key: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  evidence_urls: z.array(z.string()),
});

export const recommendationAnswerSchema = z.object({
  answer_given: z.boolean(),
  overall_confidence: z.number().min(0).max(1),
  candidates: z.array(recommendationAnswerCandidateSchema),
  decline_reason: z.string().nullable(),
});
export type RecommendationAnswer = z.infer<typeof recommendationAnswerSchema>;

/** Strict json_schema mirror for the OpenAI Responses `text.format` (see validator.ts pattern). */
export const RECOMMENDATION_ANSWER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answer_given: { type: 'boolean' },
    overall_confidence: { type: 'number' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          betco_product: { type: 'string' },
          product_key: { type: ['string', 'null'] },
          confidence: { type: 'number' },
          rationale: { type: 'string' },
          evidence_urls: { type: 'array', items: { type: 'string' } },
        },
        required: ['betco_product', 'product_key', 'confidence', 'rationale', 'evidence_urls'],
      },
    },
    decline_reason: { type: ['string', 'null'] },
  },
  required: ['answer_given', 'overall_confidence', 'candidates', 'decline_reason'],
} as const;

/**
 * Build the system prompt with the config threshold injected and the shared decline copy inlined.
 * The competitor product/brand + evidence are supplied at call time as the user message, never
 * baked into this system text.
 */
export async function buildCrossReferenceRecommendationPrompt(
  input: { threshold?: number } = {},
): Promise<string> {
  // B0-795: the threshold now comes from the settings table, so resolving it is async.
  const threshold = await resolveXrefThreshold(input.threshold);
  return `You are Betco's product cross-reference specialist. The user wants to know which **Betco** product is equivalent to a competitor product.

The competitor product is required; the competitor company/brand is optional — if it is unknown, be more conservative.

Grounding rules:
- Use ONLY the provided web-search evidence and the retrieved Betco product documents. Do not use outside knowledge and do not invent products, SKUs, EPA numbers, or claims.
- Any recommended Betco product must correspond to a real retrieved candidate (with its product_key). Never fabricate a product or key.
- Do not assert dilution, contact time, PPE, or SDS specifics unless they are present in the retrieved Betco documents.

Confidence & gating:
- Score your confidence from 0 to 1 that the recommended Betco product(s) are a true equivalent.
- You must score at or above ${threshold} to give an answer.
- If your confidence is below ${threshold}, set answer_given=false and set decline_reason to exactly: "${XREF_DECLINE_COPY}"

Return JSON only, matching this shape:
{ "answer_given": boolean, "overall_confidence": number, "candidates": [{ "betco_product": string, "product_key": string|null, "confidence": number, "rationale": string, "evidence_urls": string[] }], "decline_reason": string|null }`;
}
