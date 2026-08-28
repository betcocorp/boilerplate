import { createHash } from 'node:crypto';

import { z } from 'zod';

import { SME_AGENT_IDS, V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import { logError } from '~/lib/observability/logger';
import { getOpenAIClient } from '~/lib/openai/client';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';
import { usageFromResponse } from '~/lib/openai/responses-runtime';
import { getBooleanSetting } from '~/lib/settings/settings-service';
import { SURFACE_VOCABULARY_PROMPT_EXAMPLES } from '~/lib/orchestrator/surface-vocabulary';
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
  /**
   * Physical surface/material mentioned (e.g. {@link SURFACE_VOCABULARY_PROMPT_EXAMPLES}), else
   * `null`.
   */
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
/** B0-563 — mirrors `LlmTokenUsage` (`~/lib/openai/responses-runtime.ts`) as a validated shape. */
const llmTokenUsageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  cachedPromptTokens: z.number(),
});

export const intentClassificationSchema = llmIntentClassificationSchema.extend({
  source: z.enum(['llm', 'keyword_fallback']),
  fallbackReason: z.string().nullable(),
  /**
   * B0-563 — this call's token usage, so the `orchestration_planner` step can attribute cost.
   * Null on the `keyword_fallback` path (no model call was made).
   */
  usage: llmTokenUsageSchema.nullable(),
  /** B0-563 — the model actually called, null alongside `usage` on the fallback path. */
  model: z.string().nullable(),
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

Routing rules (apply in order):
1. "cross_reference" is ONLY competitor cross-reference: the message names or clearly refers to a NON-Betco competitor brand or product and wants the Betco equivalent, replacement, or comparison for it. If no competitor product is involved, never use "cross_reference".
2. Asking to recommend/suggest the best product for a job, task, surface, or situation — with no competitor product named — is a question for the specialist that owns the job: "floor" for floor coatings, finishes, sealers, stripping, scrubbing, burnishing, and maintenance programs (gym, sports, wood, VCT, and concrete floors included); "bathroom" for restroom cleaning, disinfection, and odor control; "dilution" for dispensers, proportioners, metering, and dilution setup. When the job or problem does NOT fit floor/bathroom/dilution's specific domains (i.e. it would otherwise fall to "product" as a generic catch-all) AND the message describes an open-ended JOB, TASK, PROBLEM, or SITUATION for the model to solve — not merely a request to compare or pick among an already-named product category — AND no competitor product is named, use "recommendations" instead of "product". Be conservative: when in doubt between a generic product QUESTION and a recommendation ASK, prefer "product" (or the owning domain specialist).

   Superlative phrasing ("best X", "strongest X", "most effective X", "which X works best") is NOT by itself a recommendation signal. When X names a product TYPE or CATEGORY that already exists in Betco's catalog (e.g. "glass cleaner", "floor stripper", "disinfectant", "degreaser", "hand soap") and the message is asking which product in that category wins the comparison, that is a catalog/spec lookup, not a job/problem-driven recommendation ask — route it per the domain list above ("floor"/"bathroom"/"dilution" if the category is theirs, else "product"). Never route it to "recommendations" on the strength of "best"/"strongest" alone: Betco's product data has no cross-product "strength" or overall "best" ranking field, so only the domain/product specialist (which can look up specs and correctly decline if no ranking basis exists) should handle it — inventing a winner is the failure mode this rule exists to prevent. Reserve "recommendations" for asks that describe a job, problem, or situation WITHOUT already naming the product category and asking which one wins it (e.g. "what should I use for X", "what do you recommend for X", or a described task/problem with no category named).

   Examples:
   - "What is the best glass cleaner?" → product (names an existing category and asks which wins; no job/problem described; no domain specialist owns "glass cleaner")
   - "What is the strongest floor stripper you have?" → floor (floor-care category comparison; stays with the domain specialist, never "recommendations", even though "strongest" appears)
   - "What disinfectant works best against norovirus?" → bathroom (disinfection category narrowed by a pathogen claim — still a catalog/spec filter within bathroom's domain, not an open-ended job)
   - "What should I use to get grease off a kitchen floor?" → recommendations (describes a job/problem; no product category named up front; kitchen degreasing is not floor care's stripping/finishing/maintenance-program domain)
   - "I need something for a gym floor that keeps getting scuffed" → floor (a gym/sports floor problem is the floor specialist's domain per this rule; "recommendations" is only for jobs no domain specialist owns)

   Procedure, diagnosis, and frequency questions are NOT recommendation asks, even when the answer will name a product. "How do I…", "How should we…", "Why is my…", "Why does…", "How often…", "What's the right way to…" about a floor, restroom, or dispenser task belong to the domain specialist that owns the task (floor, bathroom, dilution), never to "recommendations". Route to "recommendations" only when the user is asking WHICH product to use for a job that none of those three specialists owns.

   Examples:
   - "How do I strip and wax a floor?" → floor (procedure; floor owns stripping and finishing)
   - "Why is my VCT flooring dull?" → floor (diagnosis of a floor-care problem)
   - "Why does the grout stay dirty even after we mop it?" → bathroom (diagnosis of a restroom-cleaning problem)
   - "How often should we dust mop the gym?" → floor (frequency question about a sports floor maintenance program)
3. "Can I use <product> on <surface>?" and other usage/compatibility/how-to questions about a product belong to the specialist that owns the surface or task per rule 2 ("product" when none clearly does) — never "cross_reference", and never "recommendations" either (it is a factual lookup, not a recommendation ask).
4. Use "ambiguous" only when the message does not clearly match any specialist (small talk, off-topic, or too vague to route).

Output rules:
- confidence: your calibrated 0-1 belief that "intent" is correct. Do not default to 1; use lower values when the message is short, vague, or could fit more than one specialist.
- entities.betcoProduct: a Betco product name/SKU mentioned, else null.
- entities.competitorBrand / entities.competitorProduct: a NON-Betco competitor brand/product the user wants a Betco equivalent for, else null. Never put a Betco product here. Best-effort only — a dedicated extraction step runs later for the cross_reference flow.
- entities.surfaceType: the physical surface or material mentioned (e.g. ${SURFACE_VOCABULARY_PROMPT_EXAMPLES.map((example) => `"${example}"`).join(', ')}), else null.
- entities.taskDescription: a short (<=20 words) paraphrase of what the user is trying to do, else null.
- suggestedTool: the single best FIRST tool to call from this list, else null if none clearly applies: ${PRODUCT_TOOL_NAMES.join(', ')}. Suggest lookup_cross_reference or recommend_cross_reference ONLY for genuine competitor cross-reference (rule 1).
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
 * Master kill-switch — defaults ON since the B0-511 cutover hardening. The original rollout gated
 * the LLM router behind opt-in env vars, which meant any environment nobody hand-configured
 * (production included) silently stayed on keyword routing forever; product's directive is that
 * LLM intent classification is THE router, so the default inverted (2026-08-18). Moved to the
 * `settings` table (B0-618/B0-638); flip `BEX_LLM_ROUTER_ENABLED` off there to roll back to the
 * pure keyword-routing world.
 */
export async function isLlmRouterEnabled(): Promise<boolean> {
  return getBooleanSetting('BEX_LLM_ROUTER_ENABLED', true);
}

/**
 * Defaults OFF since the B0-511 cutover (shadow was the pre-cutover default: land the classifier
 * as log-and-compare first, route on it later). Set `BEX_LLM_ROUTER_SHADOW_MODE=true` in the
 * `settings` table to demote the classifier back to log-only comparison while keeping it running.
 * This module does not itself change behavior based on the flag — `classifyUserIntent` always
 * returns the LLM's own classification when the LLM path runs — the workflow integration decides
 * whether to route on it.
 */
export async function isLlmRouterShadowMode(): Promise<boolean> {
  return getBooleanSetting('BEX_LLM_ROUTER_SHADOW_MODE', false);
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

/**
 * `hash(message + prior-turn-ids + model)`, per the B0-505 ticket (the `model` segment added by
 * B0-671). Length-prefixed fields so no ambiguous concatenation.
 *
 * B0-671 — `model` is folded into the key so a routing-test run with an explicit model override
 * never reads back a classification cached under a different model for the same message: every
 * existing caller omits `model`, so their keys are unaffected relative to one another (same
 * `model:` suffix on every one of them), only the raw hash value changes.
 */
export function computeIntentClassifierCacheKey(
  message: string,
  priorMessages: PriorTurnMessage[] = [],
  model?: string,
): string {
  const ids = priorMessages.map((m) => m.id);
  const canonical = [
    `msg:${message.length}:${message}`,
    `ids:${ids.length}:${ids.join(',')}`,
    `model:${model ?? ''}`,
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
    /** B0-671 — resolved model id override for this call only; omitted → `resolveRouterModel()`. */
    model?: string,
  ) => Promise<{
    parsed: z.infer<typeof llmIntentClassificationSchema>;
    usage: z.infer<typeof llmTokenUsageSchema>;
  }>;
  now: () => number;
};

async function defaultRunLlm(
  message: string,
  priorMessages: PriorTurnMessage[],
  signal: AbortSignal,
  model?: string,
): Promise<{
  parsed: z.infer<typeof llmIntentClassificationSchema>;
  usage: z.infer<typeof llmTokenUsageSchema>;
}> {
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
      model: model ?? resolveRouterModel(),
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

  return {
    parsed: llmIntentClassificationSchema.parse(JSON.parse(extractAssistantText(res))),
    usage: usageFromResponse(res),
  };
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
 * Degraded-mode fallback, used whenever the LLM router is disabled, times out, or errors — a
 * router failure must never break the turn.
 *
 * B0-511 hardening: this used to reshape `routeUserMessageToSme`'s keyword decision, which meant
 * keyword scoring could still silently DECIDE a live turn whenever the classifier hiccuped —
 * the exact behavior the cutover exists to remove. It now returns `ambiguous` (confidence 0), so a
 * degraded turn runs the generalist product-specialist fallthrough (`systemPromptForDecision`)
 * with the full default toolset, and the persisted gate says plainly that routing was degraded,
 * instead of a keyword guess that can trigger the forced cross-reference machinery.
 */
function fallbackClassification(message: string, fallbackReason: string): IntentClassification {
  const trimmed = message.trim();

  return {
    intent: 'ambiguous',
    confidence: 0,
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
    usage: null,
    model: null,
  };
}

async function runLlmClassification(
  message: string,
  priorMessages: PriorTurnMessage[],
  deps: ClassifyUserIntentDeps,
  model?: string,
): Promise<IntentClassification> {
  const timeoutMs = resolveRouterTimeoutMs();
  const { parsed: raw, usage } = await withRouterTimeout(timeoutMs, (signal) =>
    deps.runLlm(message, priorMessages, signal, model),
  );

  return {
    ...raw,
    confidence: clamp01(raw.confidence),
    source: 'llm',
    fallbackReason: null,
    usage,
    model: model ?? resolveRouterModel(),
  };
}

/**
 * B0-504 — classify a user message's intent via a structured-output LLM call (temp 0,
 * `BEX_ROUTER_MODEL`, bounded by `BEX_ROUTER_TIMEOUT_MS`). Falls back to the existing keyword router
 * (`routeUserMessageToSme`) on timeout, LLM error, or invalid output — never throws, and never lets a
 * router failure break the turn. Also gated by `BEX_LLM_ROUTER_ENABLED` (default off): when disabled,
 * returns the keyword fallback immediately without a model call.
 *
 * B0-505 — results are cached in-process, keyed on `hash(message + prior-turn-ids + model)`, so an
 * eval replay or an immediate duplicate call does not re-hit the model. Cache is skipped when the LLM
 * router is disabled (the fallback path is already free).
 *
 * B0-671 — the optional `model` param overrides `resolveRouterModel()` for this call only (used by
 * the routing-test workbench to compare LLM router accuracy across models). It is a resolved model
 * id (e.g. what `resolveResponsesModel` returns for a `BexModelTag`), NOT a tag itself — this
 * function does no tag resolution. Every existing caller omits it and sees byte-for-byte the same
 * behavior as before this parameter existed.
 */
export async function classifyUserIntent(
  message: string,
  priorMessages: PriorTurnMessage[] = [],
  deps: ClassifyUserIntentDeps = defaultDeps,
  model?: string,
): Promise<IntentClassification> {
  if (!(await isLlmRouterEnabled())) {
    return fallbackClassification(message, 'llm_router_disabled');
  }

  const now = deps.now();
  const cacheKey = computeIntentClassifierCacheKey(message, priorMessages, model);
  const existing = cache.get(cacheKey);

  if (existing && existing.expiresAt > now) {
    cacheStats.hits += 1;
    // B0-563 — a cache hit makes no model call, so the ORIGINAL call's `usage` must not be
    // re-attributed to this turn (it would double-count the same tokens on every hit).
    return existing.promise.then((cached) => ({ ...cached, usage: null }));
  }

  pruneCache(now);
  cacheStats.misses += 1;

  const promise = runLlmClassification(message, priorMessages, deps, model).catch((error: unknown) => {
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
