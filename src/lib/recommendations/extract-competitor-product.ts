import { z } from 'zod';

import { isBexModelTag } from '~/lib/constants/models';
import { resolveModel } from '~/lib/llm/resolve-model';
import { completeStructuredWithUsage } from '~/lib/llm/structured-completion';
import type { LlmTokenUsage } from '~/lib/llm/generation-shared';
import { hasDistinctiveToken } from '~/lib/recommendations/competitor-self-reference';
import { getStringSetting } from '~/lib/settings/settings-service';
import { resolveMaxOutputTokens } from '~/lib/workflows/product-support/max-output-tokens';

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
  /**
   * B0-904 — the resolved model id the identity actually came from, so the workflow's
   * `competitor_identity_resolution` gate records ground truth rather than re-resolving the
   * setting (which could differ mid-turn). `null` when no model call produced this identity: the
   * LLM/parse-failure fallback, or a signals-path degraded turn.
   */
  model: string | null;
};

export type ExtractCompetitorProductDeps = {
  runLlm: (userMessage: string) => Promise<{
    parsed: z.infer<typeof extractedCompetitorSchema>;
    usage: LlmTokenUsage;
    /** B0-904 — the resolved model id the call was made with; omitted by legacy fakes → `null`. */
    model?: string | null;
  }>;
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

export const COMPETITOR_EXTRACT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    brand: { type: ['string', 'null'] },
    product: { type: ['string', 'null'] },
    otherCompetitorProduct: { type: ['string', 'null'] },
  },
  required: ['brand', 'product', 'otherCompetitorProduct'],
} as const;

/** B0-904 — the `settings` row holding this call's `BEX_MODEL_TAGS` tag (replaces the env var of the same name, B0-638). */
export const COMPETITOR_EXTRACT_MODEL_SETTING_KEY = 'XREF_COMPETITOR_EXTRACT_MODEL';

/**
 * B0-904 — the model tag for the competitor-extraction call, from the `XREF_COMPETITOR_EXTRACT_MODEL`
 * settings row. `allowed_values` is advisory (the admin API validates writes, the DB does not), so
 * the stored value is re-validated against `BEX_MODEL_TAGS` and anything unrecognised falls back to
 * `preview` rather than reaching a provider as a non-existent model id.
 */
export async function resolveCompetitorExtractModelTag(): Promise<string> {
  const raw = (await getStringSetting(COMPETITOR_EXTRACT_MODEL_SETTING_KEY, 'preview')).trim();
  return isBexModelTag(raw) ? raw : 'preview';
}

/**
 * Resolved model id for the competitor-extraction call: the settings tag through `resolveModel`, so
 * `preview` follows the `BEX_LLM_PROVIDER` row's per-vendor default and an explicit tag (including
 * `claude-*`) resolves as everywhere else. Exported so the workflow can reuse it.
 */
export async function resolveCompetitorExtractModel(): Promise<string> {
  return resolveModel(await resolveCompetitorExtractModelTag());
}

/**
 * B0-908 — goes through `completeStructuredWithUsage`, which routes on the resolved model id
 * (`claude-*` → Anthropic, otherwise OpenAI Responses). The previous direct call sent no output cap;
 * the shared `resolveMaxOutputTokens()` ceiling is far above what three short strings need. A
 * truncated or refused answer throws, which `extractCompetitorProduct` turns into its raw-message
 * fallback exactly as a parse failure was before.
 */
async function defaultRunLlm(userMessage: string): Promise<{
  parsed: z.infer<typeof extractedCompetitorSchema>;
  usage: LlmTokenUsage;
  model: string;
}> {
  const model = await resolveCompetitorExtractModel();
  const { text, usage } = await completeStructuredWithUsage({
    model,
    system: SYSTEM_PROMPT,
    user: userMessage,
    schemaName: 'competitor_extract',
    schema: COMPETITOR_EXTRACT_JSON_SCHEMA,
    maxOutputTokens: resolveMaxOutputTokens(),
    temperature: 0,
  });
  return {
    parsed: extractedCompetitorSchema.parse(JSON.parse(text)),
    usage,
    model,
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
    model: null,
  };
  try {
    const { parsed: out, usage, model } = await deps.runLlm(userMessage);
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
      model: model ?? null,
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

/**
 * B0-1056 — the one call site with no extraction step to check `isCompetitorIdentityUnresolved`
 * against: `product-tools.ts`'s `recommend_cross_reference` case takes `competitorProduct`
 * straight from the model's own tool-call arguments, with nothing to stop the model — under
 * pressure from a specialist prompt that expects it to always attempt a competitor lookup — from
 * passing the raw, non-competitor user message as the "product" (e.g. "Why does the grout stay
 * dirty even after we mop it?"). A real product name is short and declarative; these observed
 * failures are long, interrogative, or first-person. Deliberately conservative (false positives
 * cost nothing but a decline; false negatives cost a garbage row in the review queue), so this
 * only rejects the unambiguous shapes: a literal question mark, or an opening word/phrase no
 * product name would ever start with.
 */
const IMPLAUSIBLE_PRODUCT_OPENERS =
  /^(which|what|why|when|where|who|how|is|are|can|could|would|should|do|does|did|i need|i have|i found|our|we|a customer|a customer's|just|tell|give|show|name|list|recommend)\b/i;

/** A product name this short-and-declarative check would reject as too long to be a product name. */
const IMPLAUSIBLE_PRODUCT_MAX_LENGTH = 80;

/**
 * B0-1057 — a name built entirely from category/facility words ("floor finish", "healthcare
 * cleaner") identifies nothing, exactly the shape `hasDistinctiveToken`
 * (`competitor-self-reference.ts`) already exists to catch for the chat-workflow self-reference
 * check. Reused here rather than a second, drifting word list.
 */
export function isImplausibleCompetitorProductText(product: string): boolean {
  const trimmed = product.trim();
  if (!trimmed) return true;
  if (trimmed.includes('?')) return true;
  if (trimmed.length > IMPLAUSIBLE_PRODUCT_MAX_LENGTH) return true;
  if (IMPLAUSIBLE_PRODUCT_OPENERS.test(trimmed)) return true;
  return !hasDistinctiveToken(trimmed.toLowerCase());
}
