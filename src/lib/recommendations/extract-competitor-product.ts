import { z } from 'zod';

import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';
import { usageFromResponse, type LlmTokenUsage } from '~/lib/openai/responses-runtime';

/** B0-563 — zero usage for the fallback (no-model-call) path; never null so callers can sum unconditionally. */
const ZERO_USAGE: LlmTokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedPromptTokens: 0,
};

/**
 * B0-183 — extract the competitor brand + product from a free-text recommendation request so the
 * web-grounded cross-reference engine (`recommendCrossReference`) gets a clean query instead of the
 * whole raw message. Runs only on the recommendations route when the legacy/curated cross-reference
 * lookups miss. Degrades to `{ brand: null, product: <raw message> }` on any LLM/parse failure or an
 * empty extraction, so a miss never crashes the workflow — the engine still runs, just less precisely.
 *
 * B0-357 — this is now the SINGLE competitor-identity resolution for a turn, called once by
 * `run-product-support-workflow.ts` and threaded through every consumer (forced-lookup prefetch,
 * the deterministic override safety net, and the B0-355 web-search backstop) instead of each one
 * re-deriving its own guess from the raw message. `otherCompetitorProduct` closes the "two
 * competitor products in one message" gap: rather than silently picking one or mashing both
 * together, the model must name whichever second product it did NOT choose, so the workflow can
 * record which one won and why.
 */

export const extractedCompetitorSchema = z.object({
  brand: z.string().nullable(),
  product: z.string().nullable(),
  /** B0-357 — a second, distinct competitor product named in the same message, if any. */
  otherCompetitorProduct: z.string().nullable().optional(),
});

export type ExtractedCompetitor = {
  brand: string | null;
  product: string;
  /** B0-357 — set when the message named a second, distinct competitor product that was NOT chosen. */
  otherCompetitorProduct: string | null;
  /** B0-563 — this call's token usage, so its cost is attributable; `ZERO_USAGE` on the fallback path. */
  usage: LlmTokenUsage;
  /**
   * B0-779 — true only when the LLM actually named a product in the message. `product` is NEVER
   * empty (it falls back to the raw message so the engine always has a query string, see below),
   * so `product`/`product.trim()` can't distinguish "a real product was extracted" from "nothing
   * was found and this is standing in for the raw message" — every consumer that would render a
   * "Comparable Betco product" match line MUST check `resolved` (or `brand`) instead of `product`
   * before doing so. False on the LLM/parse-failure fallback and whenever the LLM itself returned
   * `product: null` (it found no product name in the message).
   */
  resolved: boolean;
};

export type ExtractCompetitorProductDeps = {
  runLlm: (
    userMessage: string,
  ) => Promise<{ parsed: z.infer<typeof extractedCompetitorSchema>; usage: LlmTokenUsage }>;
};

const SYSTEM_PROMPT = `You extract the competitor cleaning/chemical product a user wants cross-referenced to a Betco equivalent.
Identify the competitor BRAND/manufacturer (e.g. "Spartan", "Diversey") and the specific PRODUCT name
(e.g. "Xtreme Blue Triple Foam Polish"). Rules:
- Strip trademark symbols (®, ™) and marketing filler.
- brand: the manufacturer/brand if stated or clearly implied, else null.
- product: the specific product name only (brand prefix optional), else null if the message names no product.
- Never invent a product that isn't in the message.
- If the message names TWO OR MORE distinct competitor products, deterministically choose only ONE as
  brand/product: prefer the one adjacent to phrases like "equivalent to", "comparable to", "instead of",
  "replace"/"replacement for", "alternative to"; if no such phrase favors one, choose the FIRST one
  mentioned in reading order. Put the other product's name (brand + product if known) in
  otherCompetitorProduct, else null. Never combine two different products into one brand/product pair.`;

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    brand: { type: ['string', 'null'] },
    product: { type: ['string', 'null'] },
    otherCompetitorProduct: { type: ['string', 'null'] },
  },
  required: ['brand', 'product', 'otherCompetitorProduct'],
} as const;

async function defaultRunLlm(
  userMessage: string,
): Promise<{ parsed: z.infer<typeof extractedCompetitorSchema>; usage: LlmTokenUsage }> {
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
  return {
    parsed: extractedCompetitorSchema.parse(JSON.parse(extractAssistantText(res))),
    usage: usageFromResponse(res),
  };
}

/** Strip trademark marks, collapse whitespace. */
function normalize(value: string | null | undefined): string {
  return (value ?? '').replace(/[®™]/g, '').replace(/\s+/g, ' ').trim();
}

export async function extractCompetitorProduct(
  userMessage: string,
  deps: ExtractCompetitorProductDeps = { runLlm: defaultRunLlm },
): Promise<ExtractedCompetitor> {
  const fallback: ExtractedCompetitor = {
    brand: null,
    product: userMessage.trim(),
    otherCompetitorProduct: null,
    usage: ZERO_USAGE,
    resolved: false,
  };
  try {
    const { parsed: out, usage } = await deps.runLlm(userMessage);
    const brand = normalize(out.brand) || null;
    const product = normalize(out.product);
    const otherCompetitorProduct = normalize(out.otherCompetitorProduct) || null;
    // No product extracted → fall back to the raw message so the engine still gets a query, but
    // `resolved` stays false so a caller can tell this apart from a genuine extraction (B0-779).
    return {
      brand,
      product: product || fallback.product,
      otherCompetitorProduct,
      usage,
      resolved: Boolean(product),
    };
  } catch {
    return fallback;
  }
}

/**
 * B0-779 — the one predicate every consumer of `ExtractedCompetitor` must use before composing or
 * rendering a "Comparable Betco product" match line (directly, or by invoking the cross-reference
 * recommendation engine). Unresolved means neither a brand nor a confidently-extracted product
 * name exists — `product` is standing in for the raw message — so there is no competitor identity
 * to match against; PRO-045 and PRO-036 (B0-779) both fabricated a match from exactly this shape.
 * A brand alone (no confident product name) is NOT treated as unresolved: enough identity to
 * proceed, and unchanged behavior for that case is required (see the ticket's confident-match AC).
 */
export function isCompetitorIdentityUnresolved(
  competitor: Pick<ExtractedCompetitor, 'brand' | 'resolved'>,
): boolean {
  return !competitor.brand && !competitor.resolved;
}
