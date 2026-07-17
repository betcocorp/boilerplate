import { z } from 'zod';

import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';

/**
 * B0-183 — extract the competitor brand + product from a free-text recommendation request so the
 * web-grounded cross-reference engine (`recommendCrossReference`) gets a clean query instead of the
 * whole raw message. Runs only on the recommendations route when the legacy/curated cross-reference
 * lookups miss. Degrades to `{ brand: null, product: <raw message> }` on any LLM/parse failure or an
 * empty extraction, so a miss never crashes the workflow — the engine still runs, just less precisely.
 */

export const extractedCompetitorSchema = z.object({
  brand: z.string().nullable(),
  product: z.string().nullable(),
});

export type ExtractedCompetitor = { brand: string | null; product: string };

export type ExtractCompetitorProductDeps = {
  runLlm: (userMessage: string) => Promise<z.infer<typeof extractedCompetitorSchema>>;
};

const SYSTEM_PROMPT = `You extract the competitor cleaning/chemical product a user wants cross-referenced to a Betco equivalent.
Identify the competitor BRAND/manufacturer (e.g. "Spartan", "Diversey") and the specific PRODUCT name
(e.g. "Xtreme Blue Triple Foam Polish"). Rules:
- Strip trademark symbols (®, ™) and marketing filler.
- brand: the manufacturer/brand if stated or clearly implied, else null.
- product: the specific product name only (brand prefix optional), else null if the message names no product.
- Never invent a product that isn't in the message.`;

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    brand: { type: ['string', 'null'] },
    product: { type: ['string', 'null'] },
  },
  required: ['brand', 'product'],
} as const;

async function defaultRunLlm(
  userMessage: string,
): Promise<z.infer<typeof extractedCompetitorSchema>> {
  const client = getOpenAIClient();
  const res = await client.responses.create({
    model:
      process.env.XREF_COMPETITOR_EXTRACT_MODEL?.trim() || resolveResponsesModel('preview'),
    instructions: SYSTEM_PROMPT,
    input: [{ role: 'user', content: userMessage, type: 'message' }],
    text: {
      format: {
        type: 'json_schema',
        name: 'competitor_extract',
        strict: true,
        schema: JSON_SCHEMA,
      },
    },
    store: false,
    stream: false,
    temperature: 0,
  });
  return extractedCompetitorSchema.parse(JSON.parse(extractAssistantText(res)));
}

/** Strip trademark marks, collapse whitespace. */
function normalize(value: string | null | undefined): string {
  return (value ?? '').replace(/[®™]/g, '').replace(/\s+/g, ' ').trim();
}

export async function extractCompetitorProduct(
  userMessage: string,
  deps: ExtractCompetitorProductDeps = { runLlm: defaultRunLlm },
): Promise<ExtractedCompetitor> {
  const fallback: ExtractedCompetitor = { brand: null, product: userMessage.trim() };
  try {
    const out = await deps.runLlm(userMessage);
    const brand = normalize(out.brand) || null;
    const product = normalize(out.product);
    // No product extracted → fall back to the raw message so the engine still gets a query.
    return { brand, product: product || fallback.product };
  } catch {
    return fallback;
  }
}
