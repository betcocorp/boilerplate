import { z } from 'zod';

import type { TaxonomyNode } from '~/lib/category/category-resolver';

/**
 * B0-35 — versioned prompt + structured-output contract for the LLM product→category classifier.
 *
 * The classifier is the fallback for prod-lines the deterministic site-scrape linker (B0-34) could
 * not place. The prompt text is pinned by `CLASSIFIER_PROMPT_VERSION`; the node option set is
 * dynamic (loaded from `public.product_category`) and the chosen `category_key` is constrained to it
 * both at the model layer (json_schema enum) and by post-hoc validation, so the classifier can never
 * invent a node that doesn't exist.
 */

export const CLASSIFIER_PROMPT_VERSION = 'category-classifier-v1';

/** Sentinel the model returns when no taxonomy node fits. */
export const CLASSIFIER_NONE = 'none';

/** Render the taxonomy nodes as `- <key>: <path or name>` option lines for the prompt. */
export function formatNodeOptions(nodes: TaxonomyNode[]): string {
  return nodes
    .map((n) => `- ${n.key}: ${n.path && n.path.length > 0 ? n.path.join(' > ') : n.name}`)
    .join('\n');
}

export function buildClassifierPrompt(nodes: TaxonomyNode[]): string {
  return `You classify a Betco cleaning/hygiene product line into exactly ONE node of the Betco product taxonomy.

Rules:
- Choose the single best-fit category from the list below and return its exact "key".
- If none of the categories is a genuine fit, return "${CLASSIFIER_NONE}".
- Decide only from the provided product title/description. Do not invent facts or use outside knowledge.
- "confidence" is your calibrated 0–1 certainty in the chosen category; be conservative when the text is thin or generic.
- "rationale" is one short sentence citing the deciding signal.

Taxonomy nodes (key: path):
${formatNodeOptions(nodes)}

Return JSON only: { "category_key": string, "confidence": number, "rationale": string }`;
}

export const classifierResultSchema = z.object({
  category_key: z.string(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});
export type ClassifierResult = z.infer<typeof classifierResultSchema>;

/** Strict json_schema mirror with the node keys enumerated (grounding at the model layer). */
export function buildClassifierJsonSchema(nodeKeys: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      category_key: { type: 'string', enum: [...nodeKeys, CLASSIFIER_NONE] },
      confidence: { type: 'number' },
      rationale: { type: 'string' },
    },
    required: ['category_key', 'confidence', 'rationale'],
  };
}
