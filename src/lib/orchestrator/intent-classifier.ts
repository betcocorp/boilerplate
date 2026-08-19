import { createHash } from 'node:crypto';

import { z } from 'zod';

import { SME_AGENT_IDS, V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import { logError } from '~/lib/observability/logger';
import { getOpenAIClient } from '~/lib/openai/client';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';
import { routeUserMessageToSme } from '~/lib/orchestrator/sme-routing';
import { PRODUCT_TOOL_NAMES } from '~/lib/tools/tool-schemas';

/**
 * B0-503/504/505/506 — Phase 2 of the B0-497 initiative ("replace the keyword orchestrator with an
 * LLM intent classifier"). This module is the classifier ITSELF: a structured-output LLM call that
 * proposes an SME intent, a confidence, extracted entities, and a suggested first tool call — plus
 * the env-gated rollout knobs and a small in-process result cache.
 *
 * Deliberately NOT wired into `run-orchestration.ts` / `sme-routing.ts` yet. `routeUserMessageToSme`
 * (the keyword router) remains the routing decision actually used by the workflow; this module only
 * (a) offers `classifyUserIntent` for the next phase to call, and (b) falls back to the keyword
 * router itself on any LLM failure/timeout, so it is safe to invoke standalone (e.g. from an eval
 * harness) before that wiring lands.
 */

/** Matches the SME registry (`agent-registry.ts`) plus a catch-all for "doesn't clearly match any". */
export const INTENT_VALUES = [...SME_AGENT_IDS, 'ambiguous'] as const;
export type IntentValue = (typeof INTENT_VALUES)[number];

/**
 * A prior conversation turn replayed to the classifier for context. Mirrors the
 * `{ role, content }` shape `responses-runtime.ts` already replays for the generation loop
 * (B0-519's `history`), plus an `id` — needed here for the B0-505 cache key, not for the model call.
 */
export type PriorTurnMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

export const intentEntitiesSchema = z.object({
  /** A Betco product name/SKU mentioned in the message, else `null`. */
  betcoProduct: z.string().nullable(),
  /** Competitor brand/manufacturer — same concept as `extractCompetitorProduct`'s `brand`. */
  competitorBrand: z.string().nullable(),
  /** Competitor product name — same concept as `extractCompetitorProduct`'s `product`. */
  competitorProduct: z.string().nullable(),
  /** Physical surface/material mentioned (e.g. "VCT floor", "grout"), else `null`. */
  surfaceType: z.string().nullable(),
  /** Short paraphrase of what the user is trying to do, else `null`. */
  taskDescription: z.string().nullable(),
});

export type IntentEntities = z.infer<typeof intentEntitiesSchema>;

/** The raw shape the LLM is constrained to emit (see `JSON_SCHEMA` below); no `source` tag yet. */
const llmIntentClassificationSchema = z.object({
  intent: z.enum(INTENT_VALUES),
  confidence: z.number().min(0).max(1),
  entities: intentEntitiesSchema,
  suggestedTool: z.enum(PRODUCT_TOOL_NAMES).nullable(),
});

/**
 * B0-503 — the classifier's public result. `source` is not part of the LLM's structured output; it
 * is stamped on afterward so a caller (or a future shadow-mode comparison) can tell a real model
 * classification from the keyword-router fallback without re-deriving it.
 *
 * B0-511 — `fallbackReason` (null on the llm path) says WHY a `keyword_fallback` result fell back
 * (disabled flag / timeout / API error). Before this, the reason only went to `logError`, which is
 * unreadable from the persisted trace — post-cutover, a fallback silently routes the turn, so the
 * gate record on `/admin/observability` must carry the reason itself.
 */
export const intentClassificationSchema = llmIntentClassificationSchema.extend({
  source: z.enum(['llm', 'keyword_fallback']),
  fallbackReason: z.string().nullable(),
});

export type IntentClassification = z.infer<typeof intentClassificationSchema>;

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: [...INTENT_VALUES] },
    confidence: { type: 'number' },
    entities: {
      type: 'object',
      additionalProperties: false,
      properties: {
        betcoProduct: { type: ['string', 'null'] },
        competitorBrand: { type: ['string', 'null'] },
        competitorProduct: { type: ['string', 'null'] },
        surfaceType: { type: ['string', 'null'] },
        taskDescription: { type: ['string', 'null'] },
      },
      required: [
        'betcoProduct',
        'competitorBrand',
        'competitorProduct',
        'surfaceType',
        'taskDescription',
      ],
    },
    suggestedTool: { type: ['string', 'null'], enum: [...PRODUCT_TOOL_NAMES, null] },
  },
  required: ['intent', 'confidence', 'entities', 'suggestedTool'],
} as const;

function buildInstructions(): string {
  const smeLines = V1_AGENT_REGISTRY.map((a) => `- ${a.id}: ${a.description}`).join('\n');
  return `You classify a single Bex chat user message into exactly one specialist intent so the orchestrator can route it, without running any tools yourself.

SME specialists:
${smeLines}

Use "ambiguous" when the message does not clearly match any specialist above (small talk, off-topic, or too vague to route).

Rules:
- confidence: your calibrated 0-1 belief that "intent" is correct. Do not default to 1; use lower values when the message is short, vague, or could fit more than one specialist.
- entities.betcoProduct: a Betco product name/SKU mentioned, else null.
- entities.competitorBrand / entities.competitorProduct: a competitor brand/product the user wants a Betco equivalent for, else null. Best-effort only — a dedicated extraction step runs later for the recommendations flow.
- entities.surfaceType: the physical surface or material mentioned (e.g. "VCT floor", "grout", "stainless"), else null.
- entities.taskDescription: a short (<=20 words) paraphrase of what the user is trying to do, else null.
- suggestedTool: the single best FIRST tool to call from this list, else null if none clearly applies: ${PRODUCT_TOOL_NAMES.join(', ')}.
- Only the most recent turns of conversation are provided for context; classify the CURRENT (last) user message.`;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Caps how much prior conversation is replayed into the classifier call — a router should stay cheap. */
const MAX_PRIOR_MESSAGES = 8;

// ---------------------------------------------------------------------------------------------
// B0-506 — env-gated rollout knobs. Follows the `resolveXrefThreshold` / `isConfidenceGatingDisabled`
// pattern in `confidence-scoring.ts`: read directly off `process.env` each call (no caching of the
// raw string), invalid/absent → documented default.
// ---------------------------------------------------------------------------------------------

export const DEFAULT_BEX_ROUTER_MODEL = 'gpt-4o-mini';
/**
 * Default 5000ms. B0-506 originally set this to 800ms based on the ticket's stated 150-2000ms
 * range, but that range was never measured against a real call — B0-511's cutover rollout found
 * live `client.responses.create` structured-output calls on `gpt-4o-mini` for this classifier
 * take ~1.2-1.9s warm (5/5 sampled), with server-runtime tails past 2.5s (a 2500ms interim ceiling
 * still produced fallbacks on real turns). 800ms therefore made the classifier time out and fall
 * back to the keyword router on nearly every turn once cutover made the call synchronous and
 * authoritative (shadow mode never surfaced this — it ran the call concurrently with the tool
 * loop, so a slow/timed-out classifier never blocked anything). This ceiling only binds on slow
 * calls — the median turn pays ~1.5s regardless — and on those slow calls the alternative to
 * waiting is exactly the keyword fallback the cutover exists to replace, so it is set generously;
 * product accepted the added synchronous routing latency (2026-08-18). Tighten via
 * `BEX_ROUTER_TIMEOUT_MS` once real p95s are known (B0-524's dashboard now captures them).
 */
export const DEFAULT_BEX_ROUTER_TIMEOUT_MS = 5000;

/** Which model `classifyUserIntent` calls. Env override → `DEFAULT_BEX_ROUTER_MODEL`. */
export function resolveRouterModel(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BEX_ROUTER_MODEL?.trim();
  return raw || DEFAULT_BEX_ROUTER_MODEL;
}

/** Router call latency ceiling in ms. Invalid/absent/non-positive → `DEFAULT_BEX_ROUTER_TIMEOUT_MS`. */
export function resolveRouterTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BEX_ROUTER_TIMEOUT_MS?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BEX_ROUTER_TIMEOUT_MS;
}

/**
 * Master kill-switch (mirrors `isConfidenceGatingDisabled`): defaults OFF. Until a caller wires this
 * into `run-orchestration.ts`, this only guards whether `classifyUserIntent` attempts the LLM call at
 * all — when off, it returns the keyword-router fallback immediately without spending a model call.
 */
export function isLlmRouterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BEX_LLM_ROUTER_ENABLED === 'true';
}

/**
 * Defaults ON (the safe rollout order: land the classifier in shadow first, cut over later). This
 * module does not itself change behavior based on the flag — `classifyUserIntent` always returns the
 * LLM's own classification when the LLM path runs — it only exposes the flag so the (not-yet-built)
 * orchestrator integration can decide whether to log-and-compare or actually route on it.
 */
export function isLlmRouterShadowMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BEX_LLM_ROUTER_SHADOW_MODE !== 'false';
}

// ---------------------------------------------------------------------------------------------
// B0-505 — result cache. Same shape as `legacy-lookup-cache.ts`: in-flight promises are shared,
// failures are never cached, a TTL + max-entries bound keeps this from growing unbounded in a long-
// lived process. No env knob for the TTL — the four vars above are what B0-506 asked for, and a cache
// lifetime isn't a rollout control, so it's a plain exported constant instead of another env var.
// ---------------------------------------------------------------------------------------------

/** 5 minutes: long enough to de-dupe an eval replay or an immediate repeat call, short enough that a model/prompt change shows up promptly. */
export const INTENT_CLASSIFIER_CACHE_TTL_MS = 5 * 60_000;
/** Bound on distinct cached classifications; a turn only ever needs a handful. */
const MAX_CACHE_ENTRIES = 256;

/** `hash(message + prior-turn-ids)`, per the B0-505 ticket. Length-prefixed fields so no ambiguous concatenation. */
export function computeIntentClassifierCacheKey(
  message: string,
  priorMessages: PriorTurnMessage[] = [],
): string {
  const ids = priorMessages.map((m) => m.id);
  const canonical = [
    `msg:${message.length}:${message}`,
    `ids:${ids.length}:${ids.join(',')}`,
  ].join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

type CacheEntry = {
  expiresAt: number;
  promise: Promise<IntentClassification>;
};

const cache = new Map<string, CacheEntry>();
const cacheStats = { hits: 0, misses: 0 };

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
export function getIntentClassifierCacheStats(): { hits: number; misses: number; size: number } {
  return { hits: cacheStats.hits, misses: cacheStats.misses, size: cache.size };
}

/** Test helper: drop every cached entry and reset the counters. */
export function resetIntentClassifierCache(): void {
  cache.clear();
  cacheStats.hits = 0;
  cacheStats.misses = 0;
}

// ---------------------------------------------------------------------------------------------
// B0-504 — the classifier call itself.
// ---------------------------------------------------------------------------------------------

export type ClassifyUserIntentDeps = {
  runLlm: (
    message: string,
    priorMessages: PriorTurnMessage[],
    signal: AbortSignal,
  ) => Promise<z.infer<typeof llmIntentClassificationSchema>>;
  now: () => number;
};

async function defaultRunLlm(
  message: string,
  priorMessages: PriorTurnMessage[],
  signal: AbortSignal,
): Promise<z.infer<typeof llmIntentClassificationSchema>> {
  const client = getOpenAIClient();
  const input = [
    ...priorMessages
      .slice(-MAX_PRIOR_MESSAGES)
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content, type: 'message' as const })),
    { role: 'user' as const, content: message, type: 'message' as const },
  ];

  const res = await client.responses.create(
    {
      model: resolveRouterModel(),
      instructions: buildInstructions(),
      input,
      text: {
        format: {
          type: 'json_schema',
          name: 'intent_classification',
          strict: true,
          schema: JSON_SCHEMA,
        },
      },
      store: false,
      stream: false,
      temperature: 0,
    },
    // maxRetries 0: the SDK's default 2 retries back off ~0.5s+ then replay the full ~1.2-1.9s
    // call — that can never finish inside `withRouterTimeout`'s budget, so a transient 429/500
    // just converts into a guaranteed timeout. Our keyword fallback owns resilience here.
    { signal, maxRetries: 0 },
  );

  return llmIntentClassificationSchema.parse(JSON.parse(extractAssistantText(res)));
}

const defaultDeps: ClassifyUserIntentDeps = {
  runLlm: defaultRunLlm,
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
          reject(new Error(`classifyUserIntent exceeded its ${budget}ms router timeout`));
        }, budget);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Keyword-router fallback, reshaped into an `IntentClassification`. Used whenever the LLM router is
 * disabled, times out, or errors — a router failure must never break the turn.
 *
 * `confidence`: the keyword router has no calibrated probability to offer, so this is a fixed,
 * deliberately-moderate placeholder (0.5 when a specialist matched, 0 for `ambiguous`) rather than a
 * number that would misleadingly imply model-level certainty.
 */
const FALLBACK_MATCHED_CONFIDENCE = 0.5;

function fallbackClassification(message: string, fallbackReason: string): IntentClassification {
  const decision = routeUserMessageToSme(message);
  const intent: IntentValue = decision.agent ?? 'ambiguous';
  const trimmed = message.trim();

  return {
    intent,
    confidence: decision.agent ? FALLBACK_MATCHED_CONFIDENCE : 0,
    entities: {
      betcoProduct: null,
      competitorBrand: null,
      competitorProduct: null,
      surfaceType: null,
      taskDescription: trimmed ? trimmed.slice(0, 512) : null,
    },
    suggestedTool: null,
    source: 'keyword_fallback',
    fallbackReason,
  };
}

async function runLlmClassification(
  message: string,
  priorMessages: PriorTurnMessage[],
  deps: ClassifyUserIntentDeps,
): Promise<IntentClassification> {
  const timeoutMs = resolveRouterTimeoutMs();
  const raw = await withRouterTimeout(timeoutMs, (signal) =>
    deps.runLlm(message, priorMessages, signal),
  );

  return {
    ...raw,
    confidence: clamp01(raw.confidence),
    source: 'llm',
    fallbackReason: null,
  };
}

/**
 * B0-504 — classify a user message's intent via a structured-output LLM call (temp 0,
 * `BEX_ROUTER_MODEL`, bounded by `BEX_ROUTER_TIMEOUT_MS`). Falls back to the existing keyword router
 * (`routeUserMessageToSme`) on timeout, LLM error, or invalid output — never throws, and never lets a
 * router failure break the turn. Also gated by `BEX_LLM_ROUTER_ENABLED` (default off): when disabled,
 * returns the keyword fallback immediately without a model call.
 *
 * B0-505 — results are cached in-process, keyed on `hash(message + prior-turn-ids)`, so an eval
 * replay or an immediate duplicate call does not re-hit the model. Cache is skipped when the LLM
 * router is disabled (the fallback path is already free).
 */
export async function classifyUserIntent(
  message: string,
  priorMessages: PriorTurnMessage[] = [],
  deps: ClassifyUserIntentDeps = defaultDeps,
): Promise<IntentClassification> {
  if (!isLlmRouterEnabled()) {
    return fallbackClassification(message, 'llm_router_disabled');
  }

  const now = deps.now();
  const cacheKey = computeIntentClassifierCacheKey(message, priorMessages);
  const existing = cache.get(cacheKey);

  if (existing && existing.expiresAt > now) {
    cacheStats.hits += 1;
    return existing.promise;
  }

  pruneCache(now);
  cacheStats.misses += 1;

  const promise = runLlmClassification(message, priorMessages, deps).catch((error: unknown) => {
    /**
     * B0-511 — evict on failure so only SUCCESSFUL classifications are cached. Pre-cutover this
     * deliberately cached the fallback too ("don't re-hit a down model"), which was harmless while
     * the result was log-only — but a live router that caches a transient timeout serves poisoned
     * keyword-fallback routing for the same message for 5 more minutes. The in-flight entry still
     * dedupes concurrent callers; volume here is one bounded call per turn, so a genuinely down
     * model costs one timed-out call per turn, not a hammer.
     */
    cache.delete(cacheKey);
    const reason = error instanceof Error ? error.message : String(error);
    logError('bex.intent_classifier.fallback', { reason });
    return fallbackClassification(message, reason);
  });

  cache.set(cacheKey, { expiresAt: now + INTENT_CLASSIFIER_CACHE_TTL_MS, promise });

  return promise;
}
