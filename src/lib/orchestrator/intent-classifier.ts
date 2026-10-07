import { createHash } from 'node:crypto';

import { z } from 'zod';

import { SME_AGENT_IDS, V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import { logError } from '~/lib/observability/logger';
import { isBexModelTag, type BexModelTag } from '~/lib/constants/models';
import { nullableEnum } from '~/lib/llm/json-schema';
import { resolveModel } from '~/lib/llm/resolve-model';
import { completeStructuredWithUsage, type PriorMessage } from '~/lib/llm/structured-completion';
import {
  getBooleanSetting,
  getNumberSetting,
  getStringSetting,
} from '~/lib/settings/settings-service';
import {
  resolveFloorSpecialistForSurface,
  SURFACE_VOCABULARY_PROMPT_EXAMPLES,
} from '~/lib/orchestrator/surface-vocabulary';
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
 * `{ role, content }` shape `ai-sdk-runtime.ts` replays for the generation loop
 * (B0-519's `history`), plus an `id` — needed here for the B0-505 cache key, not for the model call.
 */
export type PriorTurnMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

/**
 * B0-758 — the four brand families named in the org brand rule, plus `competitor` for anything
 * outside them. NEVER extend this with a sub-brand: the rule is that Betco's brands are Betco,
 * Basic Coatings (wood floor coatings), EnviroZyme and 1950, and nothing else exists.
 */
export const BRAND_FAMILIES = [
  'betco',
  'basic_coatings',
  'envirozyme',
  '1950',
  'competitor',
] as const;
export type BrandFamily = (typeof BRAND_FAMILIES)[number];

/** B0-758 — commercial vs residential end use. Residential is outside the business entirely. */
export const USE_SETTINGS = ['commercial', 'residential'] as const;
export type UseSetting = (typeof USE_SETTINGS)[number];

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
  /**
   * B0-758 — which brand family owns the subject of the question. Extracted because the eval set's
   * largest identifiable failure cluster was scope: wood-floor questions belong to Basic Coatings
   * (which has almost no corpus, so the right answer is a referral, not a Betco-core product), and
   * a competitor brand is what separates a genuine cross-reference from a Betco-vs-Betco
   * comparison. `null` when no brand is identifiable from the message.
   */
  brandFamily: z.enum(BRAND_FAMILIES).nullable(),
  /**
   * B0-758 — commercial vs residential end use. Betco is a commercial manufacturer, so a
   * residential ask ("for my floor at home") is out of scope regardless of whether a matching
   * product exists. Only set when the message actually says so; `null` is the common case.
   */
  setting: z.enum(USE_SETTINGS).nullable(),
  /**
   * B0-758 — the product category being asked about ("floor finish", "quat disinfectant",
   * "degreaser"), independent of any named product. This is the one signal nothing on the chat
   * path produced: `routeCategoryQuery` exists but only fires inside the
   * `find_products_by_category` tool, i.e. after generation has already started.
   */
  productCategory: z.string().nullable(),
  /**
   * B0-758 — a product named in an EARLIER turn that the current message refers to only by
   * pronoun or ellipsis ("is it safe on marble?", "what about the concentrate?"). The routers
   * otherwise see the current message alone, so a follow-up loses its subject entirely.
   */
  carriedProduct: z.string().nullable(),
});

export type IntentEntities = z.infer<typeof intentEntitiesSchema>;

/**
 * The raw shape the LLM is constrained to emit (see `INTENT_CLASSIFICATION_JSON_SCHEMA` below); no
 * `source` tag yet.
 */
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
/**
 * B0-563 — mirrors `LlmTokenUsage` (`~/lib/llm/generation-shared.ts`) as a validated shape.
 * B0-786 — exported so the consolidated signals contract (`~/lib/orchestrator/signals`) reuses this
 * exact shape rather than declaring a second copy of it.
 */
export const llmTokenUsageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  cachedPromptTokens: z.number(),
});

export const intentClassificationSchema = llmIntentClassificationSchema.extend({
  source: z.enum(['llm', 'keyword_fallback']),
  fallbackReason: z.string().nullable(),
  /**
   * B0-977 — non-null when `applyFloorSurfaceRoutingOverride` deterministically re-routed the
   * model's `intent` (a `recommendations` verdict for a named floor substrate → the owning floor
   * specialist). Distinct from `fallbackReason` on purpose: the model call succeeded and this is
   * not a degradation, so `describeRoutingFallback` must never report it as one. Absent
   * (`undefined`) on results built before the override existed or on paths that never evaluate it.
   */
  routingOverrideReason: z.string().nullable().optional(),
  /**
   * B0-563 — this call's token usage, so the `orchestration_planner` step can attribute cost.
   * Null on the `keyword_fallback` path (no model call was made).
   */
  usage: llmTokenUsageSchema.nullable(),
  /** B0-563 — the model actually called, null alongside `usage` on the fallback path. */
  model: z.string().nullable(),
});

export type IntentClassification = z.infer<typeof intentClassificationSchema>;

export const INTENT_CLASSIFICATION_JSON_SCHEMA = {
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
        brandFamily: nullableEnum(BRAND_FAMILIES),
        setting: nullableEnum(USE_SETTINGS),
        productCategory: { type: ['string', 'null'] },
        carriedProduct: { type: ['string', 'null'] },
      },
      // `strict: true` requires EVERY property to be listed here — a missing name is a 400, and a
      // new field added above without a line here fails at the API rather than in a type check.
      required: [
        'betcoProduct',
        'competitorBrand',
        'competitorProduct',
        'surfaceType',
        'taskDescription',
        'brandFamily',
        'setting',
        'productCategory',
        'carriedProduct',
      ],
    },
    suggestedTool: nullableEnum(PRODUCT_TOOL_NAMES),
  },
  required: ['intent', 'confidence', 'entities', 'suggestedTool'],
} as const;

/**
 * B0-786 — the substantive routing rules, extracted so the consolidated signals prompt
 * (`~/lib/orchestrator/signals/analyze-turn-signals.ts`) renders the SAME text instead of
 * keeping a second, silently-diverging copy of it. Only the surrounding output-field
 * instructions differ between the two prompts.
 */
export const SME_ROUTING_RULES_PROMPT = `Routing rules (apply in order):
1. "cross_reference" is ONLY competitor cross-reference: the message names or clearly refers to a NON-Betco competitor brand or product and wants the Betco equivalent, replacement, or comparison for it. If no competitor product is involved, never use "cross_reference".
2. Asking to recommend/suggest the best product for a job, task, surface, or situation — with no competitor product named — is a question for the specialist that owns the job. Floor care is split by substrate (B0-746): "floor_wood_sport" for wood/hardwood sport and gym floor finish and coating; "floor_concrete" for concrete floor cleaning, densifying, sealing, coating, stripping, and scrubbing; "floor_stg" for cleaning and protecting natural stone, tile, and grout surfaces (STG Cleaner and Protectant — a continual clean-and-protect product, NOT a stripped-and-recoated film finish); "floor_vct" for VCT, terrazzo, and other resilient/hard tile stripping, finishing, burnishing, and maintenance programs. Outside floor care: "bathroom" for restroom cleaning, disinfection, and odor control; "dilution" for dispensers, proportioners, metering, and dilution setup. When the job or problem does NOT fit one of these domains (i.e. it would otherwise fall to "product" as a generic catch-all) AND the message describes an open-ended JOB, TASK, PROBLEM, or SITUATION for the model to solve — not merely a request to compare or pick among an already-named product category — AND no competitor product is named, use "recommendations" instead of "product". Be conservative: when in doubt between a generic product QUESTION and a recommendation ASK, prefer "product" (or the owning domain specialist). When a floor-care job names no substrate at all (no wood/gym/sport, concrete, stone/tile/grout, or VCT/terrazzo wording), and no other signal disambiguates it, prefer "floor_vct" as the default floor-care specialist.

   Superlative phrasing ("best X", "strongest X", "most effective X", "which X works best") is NOT by itself a recommendation signal. When X names a product TYPE or CATEGORY that already exists in Betco's catalog (e.g. "glass cleaner", "floor stripper", "disinfectant", "degreaser", "hand soap") and the message is asking which product in that category wins the comparison, that is a catalog/spec lookup, not a job/problem-driven recommendation ask — route it per the domain list above (the owning floor substrate/"bathroom"/"dilution" if the category is theirs, else "product"). Never route it to "recommendations" on the strength of "best"/"strongest" alone: Betco's product data has no cross-product "strength" or overall "best" ranking field, so only the domain/product specialist (which can look up specs and correctly decline if no ranking basis exists) should handle it — inventing a winner is the failure mode this rule exists to prevent. Reserve "recommendations" for asks that describe a job, problem, or situation WITHOUT already naming the product category and asking which one wins it (e.g. "what should I use for X", "what do you recommend for X", or a described task/problem with no category named).

   Examples:
   - "What is the best glass cleaner?" → product (names an existing category and asks which wins; no job/problem described; no domain specialist owns "glass cleaner")
   - "What is the strongest floor stripper you have for VCT?" → floor_vct (floor-care category comparison naming a resilient-tile substrate; stays with the domain specialist, never "recommendations", even though "strongest" appears)
   - "What stripping and finish products should I use for my VCT floor?" → floor_vct (a product-selection ask for a NAMED resilient-tile substrate; floor_vct owns VCT stripping and finishing, so this is never "recommendations" even though it asks what to use — the answer enumerates the documented strippers and finishes per category)
   - "What disinfectant works best against norovirus?" → bathroom (disinfection category narrowed by a pathogen claim — still a catalog/spec filter within bathroom's domain, not an open-ended job)
   - "What should I use to get grease off a kitchen floor?" → recommendations (describes a job/problem; no product category named up front; kitchen degreasing is not any floor specialist's stripping/finishing/cleaning domain)
   - "I need something for a gym floor that keeps getting scuffed" → floor_wood_sport (a gym/sports floor problem is the wood/sport floor specialist's domain per this rule; "recommendations" is only for jobs no domain specialist owns)

   Procedure, diagnosis, and frequency questions are NOT recommendation asks, even when the answer will name a product. "How do I…", "How should we…", "Why is my…", "Why does…", "How often…", "What's the right way to…" about a floor, restroom, or dispenser task belong to the domain specialist that owns the task (the owning floor substrate, bathroom, dilution), never to "recommendations". Route to "recommendations" only when the user is asking WHICH product to use for a job that none of those specialists owns.

   Examples:
   - "How do I strip and wax a VCT floor?" → floor_vct (procedure; floor_vct owns resilient-tile stripping and finishing)
   - "Why is my VCT flooring dull?" → floor_vct (diagnosis of a resilient-tile floor-care problem)
   - "Why does the grout stay dirty even after we mop it?" → bathroom (diagnosis of a restroom-cleaning problem)
   - "How often should we dust mop the gym?" → floor_wood_sport (frequency question about a wood/sport floor maintenance program)
   - "How do I reapply the protectant on our stone lobby floor?" → floor_stg (stone/tile/grout cleaning and protection procedure)
   - "What sealer do you recommend for our new concrete warehouse floor?" → floor_concrete (concrete floor-care product/procedure question)
3. "Can I use <product> on <surface>?" and other usage/compatibility/how-to questions about a product belong to the specialist that owns the surface or task per rule 2 ("product" when none clearly does) — never "cross_reference", and never "recommendations" either (it is a factual lookup, not a recommendation ask).
4. Use "ambiguous" only when the message does not clearly match any specialist (small talk, off-topic, or too vague to route).`;

function buildInstructions(): string {
  const smeLines = V1_AGENT_REGISTRY.map((a) => `- ${a.id}: ${a.description}`).join('\n');
  return `You classify a single Bex chat user message into exactly one specialist intent so the orchestrator can route it, without running any tools yourself.

SME specialists:
${smeLines}

${SME_ROUTING_RULES_PROMPT}

Output rules:
- confidence: your calibrated 0-1 belief that "intent" is correct. Do not default to 1; use lower values when the message is short, vague, or could fit more than one specialist.
- entities.betcoProduct: a Betco product name/SKU mentioned, else null.
- entities.competitorBrand / entities.competitorProduct: a NON-Betco competitor brand/product the user wants a Betco equivalent for, else null. Never put a Betco product here. Best-effort only — a dedicated extraction step runs later for the cross_reference flow.
- entities.surfaceType: the physical surface or material mentioned (e.g. ${SURFACE_VOCABULARY_PROMPT_EXAMPLES.map((example) => `"${example}"`).join(', ')}), else null.
- entities.taskDescription: a short (<=20 words) paraphrase of what the user is trying to do, else null.
- entities.brandFamily: which brand family the SUBJECT of the question belongs to — one of ${BRAND_FAMILIES.join(', ')} — else null. Betco's brands are Betco (core commercial cleaning chemicals), Basic Coatings (wood floor coatings), EnviroZyme (probiotic cleaning) and 1950; there are no others. Use "basic_coatings" for wood-floor subjects even when no brand is named, "competitor" for a non-Betco manufacturer, and null when no brand is identifiable. Naming a brand family is NOT a claim that the product exists.
- entities.setting: "residential" only when the message says the use is a home/house/apartment or personal ("my floor at home"); "commercial" only when it names a commercial/institutional site (school, hospital, gym, office, restaurant); otherwise null. Do not guess from the product.
- entities.productCategory: the product category being asked about, in the user's own terms ("floor finish", "quat disinfectant", "degreaser", "glass cleaner"), else null. Set this even when a specific product is also named.
- entities.carriedProduct: when the CURRENT message refers to a product only by pronoun or ellipsis ("is it safe on marble?", "what about the concentrate?"), the product name from the EARLIER turns it refers to, else null. Never repeat a product the current message names itself — that belongs in betcoProduct or competitorProduct.
- suggestedTool: the single best FIRST tool to call from this list, else null if none clearly applies: ${PRODUCT_TOOL_NAMES.join(', ')}. Suggest lookup_cross_reference or recommend_cross_reference ONLY for genuine competitor cross-reference (rule 1).
- Only the most recent turns of conversation are provided for context; classify the CURRENT (last) user message.`;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * B0-977 — deterministic safety net applied to the model's routing verdict AFTER the call, on both
 * the classifier path (`runLlmClassification`) and the consolidated signals path
 * (`analyzeTurnSignals`). Rule 2 of `SME_ROUTING_RULES_PROMPT` says a floor substrate's stripping/
 * finishing/maintenance asks belong to the owning floor specialist, never `recommendations` (which
 * since B0-497/511/663 handles job asks no domain specialist owns); the model violated it on the
 * VCT golden item at confidence 0.85. Only `recommendations` is ever overridden, and only when the
 * model ITSELF extracted a floor substrate into `surfaceType` — nothing is inferred from the message
 * text here, so a turn with no surface entity is untouched.
 */
export function applyFloorSurfaceRoutingOverride(input: {
  intent: IntentValue;
  surfaceType: string | null | undefined;
}): { intent: IntentValue; routingOverrideReason: string | null } {
  if (input.intent !== 'recommendations') {
    return { intent: input.intent, routingOverrideReason: null };
  }
  const owner = resolveFloorSpecialistForSurface(input.surfaceType);
  if (!owner) {
    return { intent: input.intent, routingOverrideReason: null };
  }
  return {
    intent: owner,
    routingOverrideReason: `floor_surface_override: classifier chose "recommendations" but surfaceType "${(input.surfaceType ?? '').trim()}" is a floor substrate owned by "${owner}" (routing rule 2)`,
  };
}

/** Caps how much prior conversation is replayed into the classifier call — a router should stay cheap. */
const MAX_PRIOR_MESSAGES = 8;

/**
 * B0-908 — output cap for the router-class structured calls (this classifier and the consolidated
 * signals call). `completeStructuredWithUsage` requires one; the Responses calls it replaced set
 * none (SDK default, i.e. the model's own maximum). The strict-schema answer is a few hundred tokens
 * at most, so this is headroom, not a constraint — the helper adds its own thinking allowance on top
 * for Anthropic models, so the cap never has to account for reasoning tokens.
 */
export const INTENT_CLASSIFIER_MAX_OUTPUT_TOKENS = 2048;

/**
 * B0-908 — the prior turns replayed to the model, as the helper's `priorMessages`: most recent
 * `MAX_PRIOR_MESSAGES` only, blank turns dropped, oldest first, `{ role, content }` exactly as the
 * Responses `input` items carried them before. On OpenAI the helper turns each into a
 * `{ role, content, type: 'message' }` item ahead of the current message, so the request bytes are
 * identical to the pre-B0-908 call; on Anthropic they become `messages`. Shared with the
 * consolidated signals call (`analyze-turn-signals.ts`) so the two never diverge.
 */
export function classifierPriorMessages(priorMessages: PriorTurnMessage[]): PriorMessage[] {
  return priorMessages
    .slice(-MAX_PRIOR_MESSAGES)
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
}

// ---------------------------------------------------------------------------------------------
// B0-506 — rollout knobs. B0-786 moved the model and the timeout off `process.env` and into
// `public.settings` (the B0-638 rule: env is for secrets and runtime-required values; flags,
// models, thresholds and timeouts are settings rows). Both getters are therefore async now.
// ---------------------------------------------------------------------------------------------

/**
 * B0-786 — a `BEX_MODEL_TAGS` TAG, not a raw OpenAI model id: `resolveRouterModel` puts it through
 * `resolveModel` (`~/lib/llm/resolve-model`, B0-903) exactly like `REPORT_GRADING_MODEL` does, so
 * the router picks up the same env-override/alias layer every other model selection goes through
 * (and so its resolved id keeps matching a `public.model_pricing` row for the B0-565 cost views).
 *
 * The default moved from `gpt-4o-mini` to `gpt-4.1` (product owner, 2026-09-01): ~5x the input and
 * ~13x the output rate, on a per-turn call, bought for routing/signal accuracy.
 */
export const DEFAULT_BEX_ROUTER_MODEL_TAG: BexModelTag = 'gpt-4.1';
/**
 * Default 5000ms. B0-506 originally set this to 800ms based on the ticket's stated 150-2000ms
 * range, but that range was never measured against a real call — B0-511's cutover rollout found
 * live Responses structured-output calls on `gpt-4o-mini` for this classifier
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

/**
 * B0-786 — the `BEX_ROUTER_MODEL` settings row, re-validated against `BEX_MODEL_TAGS` before use.
 * `settings.allowed_values` is advisory metadata the admin API validates writes against, NOT a
 * database constraint, so an unrecognized stored value falls back to the default tag rather than
 * being handed to the API as a non-existent model id.
 *
 * B0-908 — `claude-*` tags are valid here: the call below routes by provider, so the row may hold
 * either an OpenAI or an Anthropic tag.
 */
export async function resolveRouterModelTag(): Promise<BexModelTag> {
  const raw = (await getStringSetting('BEX_ROUTER_MODEL', DEFAULT_BEX_ROUTER_MODEL_TAG)).trim();
  return isBexModelTag(raw) ? raw : DEFAULT_BEX_ROUTER_MODEL_TAG;
}

/**
 * Which concrete model id `classifyUserIntent` calls: the settings tag through `resolveModel`
 * (B0-903). An explicit tag resolves exactly as before (`BEX_MODEL_*` env pins, `claude-*`
 * passthrough); the `preview` tag follows the `BEX_LLM_PROVIDER` row's per-vendor default.
 */
export async function resolveRouterModel(): Promise<string> {
  return resolveModel(await resolveRouterModelTag());
}

/** Router call latency ceiling in ms. Invalid/absent/non-positive → `DEFAULT_BEX_ROUTER_TIMEOUT_MS`. */
export async function resolveRouterTimeoutMs(): Promise<number> {
  const value = await getNumberSetting('BEX_ROUTER_TIMEOUT_MS', DEFAULT_BEX_ROUTER_TIMEOUT_MS);
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

/**
 * B0-908 — the one model call, through `completeStructuredWithUsage`, which routes on the resolved
 * model id: a `claude-*` id goes to the Anthropic Messages API, anything else to the OpenAI
 * Responses API (same `store: false`, strict json_schema, temperature-gating as before). A
 * truncated or refused structured answer surfaces from the helper as an error, which
 * `classifyUserIntent` treats exactly like the JSON/Zod parse failure it used to be: the keyword
 * fallback route.
 *
 * `signal` is `withRouterTimeout`'s abort signal, forwarded to the SDK through
 * `requestOptions.signal` so a raced-out request is cancelled, exactly as before; `timeoutMs` at the
 * same router budget is belt-and-braces for the SDK's own deadline.
 */
async function defaultRunLlm(
  message: string,
  priorMessages: PriorTurnMessage[],
  signal: AbortSignal,
  model?: string,
): Promise<{
  parsed: z.infer<typeof llmIntentClassificationSchema>;
  usage: z.infer<typeof llmTokenUsageSchema>;
}> {
  const result = await completeStructuredWithUsage({
    model: model ?? (await resolveRouterModel()),
    system: buildInstructions(),
    priorMessages: classifierPriorMessages(priorMessages),
    user: message,
    schemaName: 'intent_classification',
    schema: INTENT_CLASSIFICATION_JSON_SCHEMA,
    maxOutputTokens: INTENT_CLASSIFIER_MAX_OUTPUT_TOKENS,
    temperature: 0,
    // maxRetries 0: the SDK's default 2 retries back off ~0.5s+ then replay the full ~1.2-1.9s
    // call — that can never finish inside `withRouterTimeout`'s budget, so a transient 429/500
    // just converts into a guaranteed timeout. Our keyword fallback owns resilience here.
    requestOptions: { maxRetries: 0, timeoutMs: await resolveRouterTimeoutMs(), signal },
  });

  return {
    parsed: llmIntentClassificationSchema.parse(JSON.parse(result.text)),
    usage: result.usage,
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
      // B0-758 — a degraded turn asserts no signals. Per B0-511 this path must never guess.
      brandFamily: null,
      setting: null,
      productCategory: null,
      carriedProduct: null,
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
  const timeoutMs = await resolveRouterTimeoutMs();
  const { parsed: raw, usage } = await withRouterTimeout(timeoutMs, (signal) =>
    deps.runLlm(message, priorMessages, signal, model),
  );

  // B0-977 — deterministic floor-substrate override on the model's verdict; see the function doc.
  const override = applyFloorSurfaceRoutingOverride({
    intent: raw.intent,
    surfaceType: raw.entities.surfaceType,
  });

  return {
    ...raw,
    intent: override.intent,
    confidence: clamp01(raw.confidence),
    source: 'llm',
    fallbackReason: null,
    routingOverrideReason: override.routingOverrideReason,
    usage,
    model: model ?? (await resolveRouterModel()),
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
 * id (e.g. what `resolveModel` returns for a `BexModelTag`), NOT a tag itself — this
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
