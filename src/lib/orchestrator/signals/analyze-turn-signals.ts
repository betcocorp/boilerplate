import { V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import { completeStructuredWithUsage } from '~/lib/llm/structured-completion';
import { logError } from '~/lib/observability/logger';
import {
  BRAND_FAMILIES,
  classifierPriorMessages,
  computeIntentClassifierCacheKey,
  INTENT_CLASSIFIER_CACHE_TTL_MS,
  INTENT_CLASSIFIER_MAX_OUTPUT_TOKENS,
  INTENT_VALUES,
  resolveRouterModel,
  resolveRouterTimeoutMs,
  SME_ROUTING_RULES_PROMPT,
  USE_SETTINGS,
  type IntentClassification,
  type PriorTurnMessage,
} from '~/lib/orchestrator/intent-classifier';
import { hasDecisiveCrossReferenceSignal, routeUserMessageToSme } from '~/lib/orchestrator/sme-routing';
import { NAMED_SURFACE_TERMS } from '~/lib/orchestrator/surface-vocabulary';
import { matchBetcoProductName } from '~/lib/rag/betco-product-name';
import { resolveProductEntityByName } from '~/lib/rag/entity-context';
import { classifyCompetitorSelfReference } from '~/lib/recommendations/competitor-self-reference';
import { getBooleanSetting } from '~/lib/settings/settings-service';
import { PRODUCT_TOOL_NAMES } from '~/lib/tools/tool-schemas';
import {
  ANSWER_SHAPES,
  DECLINE_CLASSES,
  llmTurnSignalsSchema,
  SIGNALS_CONTRACT_VERSION,
  type LlmTurnSignals,
  type TurnSignals,
} from '~/lib/orchestrator/signals/signals-schemas';

import type { LlmTokenUsage } from '~/lib/openai/responses-runtime';
import type { ProductEntityResolutionSource } from '~/lib/rag/entity-context';
import type {
  BetcoEntityResolution,
  CompetitorSelfReferenceVerdict,
} from '~/lib/recommendations/competitor-self-reference';
import type { ExtractedCompetitor } from '~/lib/recommendations/extract-competitor-product';

/**
 * B0-786 — `analyzeTurnSignals` is the single pre-orchestration signal-detection entry point. It
 * does exactly two things, in this order:
 *
 *   (a) ONE structured-output LLM call producing every signal the turn needs (`llmTurnSignalsSchema`);
 *   (b) DETERMINISTIC enrichment: resolve the named Betco product to a product-line key, and run
 *       the competitor self-reference check REUSING the competitor identity from (a) rather than
 *       re-extracting it with a second model call (`extractCompetitorProduct`, the duplicate this
 *       ticket removes).
 *
 * SAFETY CONTRACT — mirrors `classifyUserIntent` exactly: this function NEVER throws. A disabled
 * flag, a timeout, an API error, or a parse failure all degrade internally to a
 * `source: 'keyword_fallback'` result carrying `routeUserMessageToSme`'s decision and a non-null
 * `fallbackReason`. The keyword router is the floor under this module, not a thing it replaces —
 * `sme-routing.ts` is deliberately untouched.
 */

export const DEFAULT_SIGNALS_ANALYSIS_ENABLED = false;

/**
 * B0-786 rollout flag. Off by default: with it off, `runProductSupportWorkflow` keeps the existing
 * scattered classifier + keyword path and this module is never called.
 */
export async function isSignalsAnalysisEnabled(): Promise<boolean> {
  return getBooleanSetting('BEX_SIGNALS_ANALYSIS_ENABLED', DEFAULT_SIGNALS_ANALYSIS_ENABLED);
}

const SIGNALS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: [...INTENT_VALUES] },
    confidence: { type: 'number' },
    betcoProduct: { type: ['string', 'null'] },
    competitorBrand: { type: ['string', 'null'] },
    competitorProduct: { type: ['string', 'null'] },
    otherCompetitorProduct: { type: ['string', 'null'] },
    surfaceType: { type: ['string', 'null'] },
    taskDescription: { type: ['string', 'null'] },
    brandFamily: { type: ['string', 'null'], enum: [...BRAND_FAMILIES, null] },
    setting: { type: ['string', 'null'], enum: [...USE_SETTINGS, null] },
    productCategory: { type: ['string', 'null'] },
    carriedProduct: { type: ['string', 'null'] },
    suggestedTool: { type: ['string', 'null'], enum: [...PRODUCT_TOOL_NAMES, null] },
    crossReferenceIntent: { type: 'boolean' },
    competitorIsGenericChemistry: { type: 'boolean' },
    isConversionListAsk: { type: 'boolean' },
    answerShape: { type: 'string', enum: [...ANSWER_SHAPES] },
    declineClass: { type: ['string', 'null'], enum: [...DECLINE_CLASSES, null] },
    regulatedSectionIntent: { type: 'boolean' },
  },
  // `strict: true` requires EVERY property to be listed here — a field added above without a line
  // here is a 400 from the API rather than a type error.
  required: [
    'intent',
    'confidence',
    'betcoProduct',
    'competitorBrand',
    'competitorProduct',
    'otherCompetitorProduct',
    'surfaceType',
    'taskDescription',
    'brandFamily',
    'setting',
    'productCategory',
    'carriedProduct',
    'suggestedTool',
    'crossReferenceIntent',
    'competitorIsGenericChemistry',
    'isConversionListAsk',
    'answerShape',
    'declineClass',
    'regulatedSectionIntent',
  ],
} as const;

export function buildSignalsInstructions(): string {
  const smeLines = V1_AGENT_REGISTRY.map((a) => `- ${a.id}: ${a.description}`).join('\n');
  const surfaceTerms = NAMED_SURFACE_TERMS.map((term) => `"${term}"`).join(', ');
  return `You analyze a single Bex chat user message and emit every signal the orchestrator needs to route and ground the turn. You never run tools and you never answer the question itself.

SME specialists:
${smeLines}

${SME_ROUTING_RULES_PROMPT}

Output rules:
- confidence: your calibrated 0-1 belief that "intent" is correct. Do not default to 1; use lower values when the message is short, vague, or could fit more than one specialist.
- betcoProduct: a Betco product name/SKU the message names, else null.
- competitorBrand / competitorProduct: a NON-Betco competitor brand/manufacturer and the specific competitor product name. Strip trademark symbols and marketing filler. Never put a Betco product here. Both null when no competitor is named.
- If the message names TWO OR MORE distinct competitor products, choose ONE deterministically for competitorBrand/competitorProduct: prefer the one adjacent to "equivalent to", "comparable to", "instead of", "replace"/"replacement for", "alternative to"; otherwise the FIRST in reading order. Put the other product (brand + product if known) in otherCompetitorProduct, else null. Never combine two different products into one pair.
- surfaceType: the physical surface or material mentioned (e.g. ${surfaceTerms}), else null.
- taskDescription: a short (<=20 words) paraphrase of what the user is trying to do, else null.
- brandFamily: which brand family the SUBJECT of the question belongs to — one of ${BRAND_FAMILIES.join(', ')} — else null. Betco's brands are Betco (core commercial cleaning chemicals), Basic Coatings (wood floor coatings), EnviroZyme (probiotic cleaning) and 1950; there are no others. Use "basic_coatings" for wood-floor subjects even when no brand is named, "competitor" for a non-Betco manufacturer, and null when no brand is identifiable. Naming a brand family is NOT a claim that the product exists.
- setting: "residential" only when the message says the use is a home/house/apartment or personal ("my floor at home"); "commercial" only when it names a commercial/institutional site (school, hospital, gym, office, restaurant); otherwise null. Do not guess from the product.
- productCategory: the product category being asked about, in the user's own terms ("floor finish", "quat disinfectant", "degreaser", "glass cleaner"), else null. Set this even when a specific product is also named.
- carriedProduct: when the CURRENT message refers to a product only by pronoun or ellipsis ("is it safe on marble?", "what about the concentrate?"), the product name from the EARLIER turns it refers to, else null. Never repeat a product the current message names itself.
- suggestedTool: the single best FIRST tool to call from this list, else null if none clearly applies: ${PRODUCT_TOOL_NAMES.join(', ')}. Suggest lookup_cross_reference or recommend_cross_reference ONLY for genuine competitor cross-reference (routing rule 1).
- crossReferenceIntent: true ONLY when the user wants the Betco equivalent/replacement/comparison for a NON-Betco product they named or clearly referred to. False when no competitor is involved, when the "competitor" is actually a Betco product or brand, and false for a bare chemistry name.
- competitorIsGenericChemistry: true when what the user offered in place of a competitor product is a bare chemistry rather than a product ("bleach", "quat", "hydrogen peroxide", "ammonia", "chlorine"). A branded product that merely contains that chemistry ("Spartan Quat Disinfectant") is NOT generic chemistry.
- isConversionListAsk: true only when the user asks for a WHOLE-line or WHOLE-catalog cross-reference/conversion list, sheet, chart or guide. A single-product equivalence ask ("Betco equivalent to Virex II 256") is false.
- answerShape: the shape of the answer the question asks for.
  * "comparison" — two or more named things weighed against each other ("X vs Y", "difference between").
  * "enumeration" — a LIST is the answer: causes, mistakes, options, fixtures, factors ("what factors...", "which ... most often", "what are the common mistakes").
  * "procedure" — ordered steps, a schedule, an interval, a dry/recoat window ("how do I...", "how often...", "step by step", "maintenance schedule", "why didn't X work" asking for possible causes to work through).
  * "single_value" — one fact: a dilution ratio, a contact time, a pH, a yes/no. Use this when in doubt.
- declineClass: the policy class that makes this message one Bex must decline before retrieving anything, else null. Prefer null.
  * "chemical_mixing_or_safety" — asks whether/how to mix or combine chemicals.
  * "legal_or_compliance" — asks for legal, OSHA, regulatory or compliance guidance.
  * "storage_or_expiration" — asks whether an expired or long-stored product is still safe/effective.
  * "broad_recommendation_without_context" — asks what to use with NO usable context at all. Set this ONLY when the message names no surface or material (${surfaceTerms}), no soil or problem, no site, and no competitor product. If the user already named any of those, or is asking for a competitor cross-reference, use null.
- regulatedSectionIntent: true when the answer would be governed by the product LABEL or SDS — dilution ratios, oz/gal or mL/L, ppm, contact/dwell time, kill or efficacy claims, EPA registration, DIN, hazards, PPE, first aid, storage or directions for use. Err toward true: this only widens which documents are searched first, it never narrows them.
- Only the most recent turns of conversation are provided for context; analyze the CURRENT (last) user message.`;
}

export type SignalsRunLlmResult = { parsed: LlmTurnSignals; usage: LlmTokenUsage };

export type AnalyzeTurnSignalsDeps = {
  runLlm: (
    message: string,
    priorMessages: PriorTurnMessage[],
    signal: AbortSignal,
  ) => Promise<SignalsRunLlmResult>;
  /** Enrichment: resolve a model-asserted Betco product name to a product line. */
  resolveProductEntity: (name: string) => Promise<{
    productLineKey: string | null;
    resolutionSource: ProductEntityResolutionSource;
  }>;
  /** Enrichment: the alias + catalog resolver `classifyCompetitorSelfReference` consumes. */
  resolveBetcoEntity: (name: string) => Promise<BetcoEntityResolution>;
  now: () => number;
};

/**
 * B0-908 — the one model call, through `completeStructuredWithUsage`, which routes on the resolved
 * `BEX_ROUTER_MODEL` id: `claude-*` to the Anthropic Messages API, anything else to the OpenAI
 * Responses API. Prior turns go out as the helper's `priorMessages` via the classifier's shared
 * `classifierPriorMessages` (same cap, blank-turn filter and roles as before, so the OpenAI request
 * bytes are unchanged). A truncated or refused structured answer is thrown by the helper and lands
 * in `analyzeTurnSignals`'s catch — the same keyword-router degradation a parse failure always took.
 *
 * `signal` is `withRouterTimeout`'s abort signal, forwarded through `requestOptions.signal`;
 * `timeoutMs` at the router budget is belt-and-braces.
 */
async function defaultRunLlm(
  message: string,
  priorMessages: PriorTurnMessage[],
  signal: AbortSignal,
): Promise<SignalsRunLlmResult> {
  const result = await completeStructuredWithUsage({
    model: await resolveRouterModel(),
    system: buildSignalsInstructions(),
    priorMessages: classifierPriorMessages(priorMessages),
    user: message,
    schemaName: 'turn_signals',
    schema: SIGNALS_JSON_SCHEMA,
    maxOutputTokens: INTENT_CLASSIFIER_MAX_OUTPUT_TOKENS,
    temperature: 0,
    // maxRetries 0 for the same reason as the intent classifier: a retry can never finish inside
    // the router timeout budget, so it only converts a transient error into a guaranteed timeout.
    requestOptions: { maxRetries: 0, timeoutMs: await resolveRouterTimeoutMs(), signal },
  });

  return {
    parsed: llmTurnSignalsSchema.parse(JSON.parse(result.text)),
    usage: result.usage,
  };
}

const defaultDeps: AnalyzeTurnSignalsDeps = {
  runLlm: defaultRunLlm,
  resolveProductEntity: async (name) => {
    const { productLineKey, resolutionSource } = await resolveProductEntityByName(name);
    return { productLineKey, resolutionSource };
  },
  // Same two-source resolver the workflow used inline before this module existed (B0-751): the
  // curated alias table gives a product line when it can, catalog membership answers "is this ours
  // at all" for the many names with no alias row.
  resolveBetcoEntity: async (name) => {
    const [resolution, catalog] = await Promise.all([
      resolveProductEntityByName(name, { mode: 'freeform' }),
      matchBetcoProductName(name),
    ]);
    return {
      productLineKey: resolution.productLineKey,
      ambiguousAlias: resolution.ambiguousAlias,
      catalogMatch: catalog.matched,
      catalogProductLineKey: catalog.productLineKey,
    };
  },
  now: () => Date.now(),
};

/** Race `run` against `budgetMs`, aborting the underlying request when the budget is exceeded. */
async function withRouterTimeout<T>(
  budgetMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const budget = Math.max(0, Math.floor(budgetMs));
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`analyzeTurnSignals exceeded its ${budget}ms router timeout`));
        }, budget);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Degraded mode. Unlike `classifyUserIntent`'s post-B0-511 fallback (which asserts `ambiguous`),
 * this carries the KEYWORD ROUTER's decision, per the B0-786 rule that `routeUserMessageToSme`
 * stays the floor under the consolidated call. `crossReferenceIntent` likewise falls back to
 * `hasDecisiveCrossReferenceSignal` — the same predicate `shouldForceCrossReferenceLookup`
 * delegates to — so a degraded turn behaves exactly as the pre-B0-786 keyword world did.
 *
 * Every other new signal degrades to its NEUTRAL value, never a guess: the consumers treat a
 * `keyword_fallback` result's `answerShape`/`declineClass` as "no signal" and keep running their
 * own deterministic checks, so a degraded turn loses nothing it had before.
 */
export function fallbackTurnSignals(message: string, fallbackReason: string): LlmTurnSignals & {
  source: 'keyword_fallback';
  fallbackReason: string;
} {
  const trimmed = message.trim();
  const route = routeUserMessageToSme(message);

  return {
    intent: route.agent ?? 'ambiguous',
    confidence: 0,
    betcoProduct: null,
    competitorBrand: null,
    competitorProduct: null,
    otherCompetitorProduct: null,
    surfaceType: null,
    taskDescription: trimmed ? trimmed.slice(0, 512) : null,
    brandFamily: null,
    setting: null,
    productCategory: null,
    carriedProduct: null,
    suggestedTool: null,
    crossReferenceIntent: hasDecisiveCrossReferenceSignal(message),
    competitorIsGenericChemistry: false,
    isConversionListAsk: false,
    answerShape: 'single_value',
    declineClass: null,
    regulatedSectionIntent: false,
    source: 'keyword_fallback',
    fallbackReason,
  };
}

/**
 * Step (b): everything the model must NOT be asked to assert. Resolution against
 * `rag.product_alias` / the product catalog is a database fact, and the self-reference verdict is a
 * decision about those facts — so both are computed here, from the identity step (a) extracted.
 */
async function enrichSignals(
  userMessage: string,
  base: LlmTurnSignals & { source: 'llm' | 'keyword_fallback'; fallbackReason: string | null },
  deps: AnalyzeTurnSignalsDeps,
): Promise<{
  resolvedProductLineKey: string | null;
  resolutionSource: ProductEntityResolutionSource;
  selfReferenceVerdict: CompetitorSelfReferenceVerdict | null;
}> {
  const productName = base.betcoProduct?.trim();
  const crossReferenceCandidate =
    base.crossReferenceIntent || base.intent === 'cross_reference' || base.isConversionListAsk;

  const [resolution, selfReferenceVerdict] = await Promise.all([
    productName
      ? deps
          .resolveProductEntity(productName)
          // Fail open: a resolver outage must not change routing or fail the turn.
          .catch(() => ({ productLineKey: null, resolutionSource: null }))
      : Promise.resolve({ productLineKey: null, resolutionSource: null }),
    crossReferenceCandidate
      ? classifyCompetitorSelfReference({
          userMessage,
          competitorBrand: base.competitorBrand,
          competitorProduct: base.competitorProduct,
          resolveBetcoEntity: deps.resolveBetcoEntity,
          // B0-786 — the LLM's own read of these two replaces the keyword sets/regexes inside the
          // classifier (`CHEMISTRY_TERMS`, `CONVERSION_LIST_PATTERNS`). Only supplied on the `llm`
          // path: a degraded turn leaves them undefined so the classifier keeps its own checks.
          ...(base.source === 'llm'
            ? {
                isConversionListAsk: base.isConversionListAsk,
                competitorIsGenericChemistry: base.competitorIsGenericChemistry,
              }
            : {}),
        })
      : Promise.resolve(null),
  ]);

  return {
    resolvedProductLineKey: resolution.productLineKey,
    resolutionSource: resolution.resolutionSource,
    selfReferenceVerdict,
  };
}

// ---------------------------------------------------------------------------------------------
// Result cache — same contract as the B0-505 intent-classifier cache: in-flight promises shared,
// failures never cached, 5-minute TTL, bounded entry count. The key is the classifier's own key
// with the CONTRACT VERSION folded in, so a schema/prompt change can never serve a stale shape.
// ---------------------------------------------------------------------------------------------

const MAX_CACHE_ENTRIES = 256;

type CacheEntry = { expiresAt: number; promise: Promise<TurnSignals> };

const cache = new Map<string, CacheEntry>();
const cacheStats = { hits: 0, misses: 0 };

export function computeTurnSignalsCacheKey(
  message: string,
  priorMessages: PriorTurnMessage[] = [],
  model?: string,
): string {
  return computeIntentClassifierCacheKey(
    message,
    priorMessages,
    `signals:${SIGNALS_CONTRACT_VERSION}:${model ?? ''}`,
  );
}

function pruneCache(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Observability/test helper. */
export function getTurnSignalsCacheStats(): { hits: number; misses: number; size: number } {
  return { hits: cacheStats.hits, misses: cacheStats.misses, size: cache.size };
}

/** Test helper: drop every cached entry and reset the counters. */
export function resetTurnSignalsCache(): void {
  cache.clear();
  cacheStats.hits = 0;
  cacheStats.misses = 0;
}

async function runAnalysis(
  userMessage: string,
  priorMessages: PriorTurnMessage[],
  deps: AnalyzeTurnSignalsDeps,
): Promise<TurnSignals> {
  const timeoutMs = await resolveRouterTimeoutMs();
  const { parsed, usage } = await withRouterTimeout(timeoutMs, (signal) =>
    deps.runLlm(userMessage, priorMessages, signal),
  );
  const base = {
    ...parsed,
    confidence: clamp01(parsed.confidence),
    source: 'llm' as const,
    fallbackReason: null,
  };
  const enrichment = await enrichSignals(userMessage, base, deps);

  return {
    ...base,
    usage,
    model: await resolveRouterModel(),
    ...enrichment,
  };
}

async function degradedAnalysis(
  userMessage: string,
  reason: string,
  deps: AnalyzeTurnSignalsDeps,
): Promise<TurnSignals> {
  const base = fallbackTurnSignals(userMessage, reason);
  const enrichment = await enrichSignals(userMessage, base, deps).catch(() => ({
    resolvedProductLineKey: null,
    resolutionSource: null,
    selfReferenceVerdict: null,
  }));
  return { ...base, usage: null, model: null, ...enrichment };
}

/**
 * B0-786 — the single entry point. See the module doc for the two-step contract and the
 * never-throws guarantee.
 */
export async function analyzeTurnSignals(
  userMessage: string,
  priorMessages: PriorTurnMessage[] = [],
  deps: AnalyzeTurnSignalsDeps = defaultDeps,
): Promise<TurnSignals> {
  if (!(await isSignalsAnalysisEnabled())) {
    // No model call and no enrichment round-trips on a path nobody is routing on.
    return {
      ...fallbackTurnSignals(userMessage, 'signals_analysis_disabled'),
      usage: null,
      model: null,
      resolvedProductLineKey: null,
      resolutionSource: null,
      selfReferenceVerdict: null,
    };
  }

  const now = deps.now();
  const cacheKey = computeTurnSignalsCacheKey(userMessage, priorMessages);
  const existing = cache.get(cacheKey);

  if (existing && existing.expiresAt > now) {
    cacheStats.hits += 1;
    // A cache hit makes no model call, so the ORIGINAL call's `usage` must not be re-attributed to
    // this turn (it would double-count the same tokens on every hit) — same rule as B0-563.
    return existing.promise.then((cached) => ({ ...cached, usage: null }));
  }

  pruneCache(now);
  cacheStats.misses += 1;

  const promise = runAnalysis(userMessage, priorMessages, deps).catch((error: unknown) => {
    // Evict on failure so only SUCCESSFUL analyses are cached: a cached transient timeout would
    // serve degraded routing for the same message for 5 more minutes (B0-511's lesson).
    cache.delete(cacheKey);
    const reason = error instanceof Error ? error.message : String(error);
    logError('bex.turn_signals.fallback', { reason });
    return degradedAnalysis(userMessage, reason, deps);
  });

  cache.set(cacheKey, { expiresAt: now + INTENT_CLASSIFIER_CACHE_TTL_MS, promise });

  return promise;
}

/**
 * Adapter for the consumers that already speak `IntentClassification` (the routing gate record, the
 * cross-reference intent derivation, the `orchestration_planner` cost attribution). Lossless for
 * every field those consumers read; the B0-786-only signals stay on `TurnSignals` and are persisted
 * whole on the `signals_analysis` gate.
 */
export function toIntentClassification(signals: TurnSignals): IntentClassification {
  return {
    intent: signals.intent,
    confidence: signals.confidence,
    entities: {
      betcoProduct: signals.betcoProduct,
      competitorBrand: signals.competitorBrand,
      competitorProduct: signals.competitorProduct,
      surfaceType: signals.surfaceType,
      taskDescription: signals.taskDescription,
      brandFamily: signals.brandFamily,
      setting: signals.setting,
      productCategory: signals.productCategory,
      carriedProduct: signals.carriedProduct,
    },
    suggestedTool: signals.suggestedTool,
    source: signals.source,
    fallbackReason: signals.fallbackReason,
    usage: signals.usage,
    model: signals.model,
  };
}

/**
 * B0-786 — the turn's competitor identity, taken from the signals call INSTEAD of
 * `extractCompetitorProduct`'s second LLM call. Same contract as that function's return value, so
 * every downstream consumer (the forced-lookup prefetch, the deterministic override safety net, the
 * B0-355 web-search backstop) is unchanged:
 *   - `product` is never empty — it falls back to the raw message so the engine always has a query;
 *   - `resolved` is therefore the ONLY way to tell a real extraction from that stand-in (B0-779).
 *
 * `usage` is zero, not the signals call's usage: those tokens are already attributed once on the
 * `orchestration_planner` step, and reporting them here again would double-count them.
 */
export function competitorIdentityFromSignals(
  signals: TurnSignals,
  userMessage: string,
): ExtractedCompetitor {
  const product = (signals.competitorProduct ?? '').trim();
  return {
    brand: (signals.competitorBrand ?? '').trim() || null,
    product: product || userMessage.trim(),
    otherCompetitorProduct: (signals.otherCompetitorProduct ?? '').trim() || null,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 },
    resolved: Boolean(product),
    // B0-904 — the signals call IS the extraction on this path, so its (router) model is the ground
    // truth for the `competitor_identity_resolution` gate; null on a degraded (keyword) turn.
    model: signals.model,
  };
}
