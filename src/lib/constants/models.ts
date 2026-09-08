/**
 * B0-599 — the single canonical list of selectable chat model tags.
 *
 * Deliberately NOT duplicated into `~/types/bex.ts` even though the ticket names that file: this
 * list already backs the /admin/tests run form, the Bex chat picker and
 * `POST /api/admin/tests/runs`, and a second copy is exactly the drift that let the test-runner
 * action silently coerce newer models to `preview` (B0-564). `~/types/bex.ts` re-exports these
 * symbols so the ticket's stated import path works without a second source of truth.
 *
 * A tag is NOT necessarily a model id — `resolveResponsesModel` (`~/lib/openai/client`) maps tags
 * to concrete ids and applies env overrides, and `modelProviderFor` decides which API is called
 * (OpenAI Responses for gpt tags, Anthropic Messages / AI SDK Anthropic provider for `claude-*`
 * tags, B0-908). Adding a tag here requires two follow-ups or it will misbehave silently:
 *   1. a branch in `resolveResponsesModel` if the tag needs an env override (B0-598; Anthropic tags
 *      share one generic `BEX_MODEL_CLAUDE_*` branch);
 *   2. a `public.model_pricing` row keyed to the TAG STRING, because B0-563 stamps
 *      `workflow_steps.output.model` from our resolver, and the B0-565 cost views join it with an
 *      INNER lateral — an unpriced model is dropped from cost reporting entirely, not zeroed.
 */

/**
 * B0-908 — the Anthropic tier-for-tier equivalents of the OpenAI tags. Exact Claude API ids — never
 * append a date suffix. Unlike a gpt tag, an Anthropic tag IS the model id the Messages API is
 * called with (`resolveResponsesModel` only layers the optional `BEX_MODEL_CLAUDE_*` env pin on it).
 *
 *   gpt-4.1-mini → claude-haiku-4-5
 *   gpt-4o       → claude-sonnet-4-6
 *   gpt-4.1      → claude-sonnet-5
 *   gpt-5.5      → claude-opus-4-8
 *   gpt-5.6      → claude-opus-5
 */
export const ANTHROPIC_MODEL_TAGS = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-opus-5',
] as const;

export type AnthropicModelTag = (typeof ANTHROPIC_MODEL_TAGS)[number];

/**
 * Every selectable tag, including the env-configured `preview` default. `preview` first, then the
 * OpenAI tags, then their Anthropic equivalents (B0-908).
 */
export const BEX_MODEL_TAGS = [
  'preview',
  'gpt-4o',
  'gpt-4.1-mini',
  'gpt-4.1',
  'gpt-5.5',
  'gpt-5.6',
  ...ANTHROPIC_MODEL_TAGS,
] as const;

export type BexModelTag = (typeof BEX_MODEL_TAGS)[number];

/** Tags that name a concrete model, i.e. everything except the env-driven `preview`. */
export type ExplicitBexModelTag = Exclude<BexModelTag, 'preview'>;

export type SupportedModel = {
  name: ExplicitBexModelTag;
  label: string;
};

export function isBexModelTag(value: string): value is BexModelTag {
  return (BEX_MODEL_TAGS as readonly string[]).includes(value);
}

/**
 * B0-806 introduced the Anthropic tags as GRADING-only (`REPORT_GRADING_MODEL`), because every other
 * picker fed the OpenAI Responses runtime. As of B0-908 they are selectable everywhere: every
 * consumer routes on `modelProviderFor` — single-shot call sites (router, validator, grader) go
 * through `~/lib/llm/structured-completion` (OpenAI Responses vs Anthropic Messages), and the chat
 * loop uses the AI SDK with `@ai-sdk/anthropic` for a `claude-*` tag. These aliases are kept so
 * existing imports keep compiling; both now equal the unified lists (no duplicates).
 */
export const ANTHROPIC_GRADING_MODEL_TAGS = ANTHROPIC_MODEL_TAGS;

export type AnthropicGradingModelTag = (typeof ANTHROPIC_GRADING_MODEL_TAGS)[number];

/** Every tag the run-report grader may be pointed at — since B0-908, the same list as every other picker. */
export const GRADING_MODEL_TAGS = BEX_MODEL_TAGS;

export type GradingModelTag = (typeof GRADING_MODEL_TAGS)[number];

export function isGradingModelTag(value: string): value is GradingModelTag {
  return (GRADING_MODEL_TAGS as readonly string[]).includes(value);
}

export type ModelProvider = 'openai' | 'anthropic';

/**
 * Which API serves a model tag or resolved model id. Every Claude API id starts with `claude-`, so
 * the prefix — not membership in a list — is the test: a pinned Anthropic id outside
 * `ANTHROPIC_MODEL_TAGS` still routes to Anthropic instead of being sent to OpenAI.
 */
export function modelProviderFor(modelOrTag: string): ModelProvider {
  return modelOrTag.trim().toLowerCase().startsWith('claude-') ? 'anthropic' : 'openai';
}

/**
 * B0-806 — Anthropic `output_config.effort` levels: how much the model thinks before it answers.
 * OpenAI models ignore it. Grading reads the `REPORT_GRADING_EFFORT` settings row (default `high`).
 */
export const MODEL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export function isModelEffort(value: string): value is ModelEffort {
  return (MODEL_EFFORTS as readonly string[]).includes(value);
}

/**
 * Shown under the model selector so whoever starts a run knows what they are choosing and what it
 * costs. Rates are the published standard $/Mtok input→output seeded in `public.model_pricing`;
 * they are a decision aid, not a billing source — the cost views are.
 *
 * `custom` is intentionally absent: `resolveResponsesModel` unconditionally THROWS on that tag (a
 * caller must pass a concrete model id directly instead), so offering it in a dropdown just
 * produces a failed run.
 */
export const MODEL_DESCRIPTIONS: Record<BexModelTag, string> = {
  preview:
    'Settings-table default (BEX_RESPONSES_MODEL row at /admin/settings; gpt-4.1-mini unless changed). Use this as the A/B baseline.',
  'gpt-4o': 'Older general-purpose model. $2.50 → $10.00 per Mtok.',
  'gpt-4.1-mini': 'Cheapest option and what `preview` resolves to today. $0.40 → $1.60 per Mtok.',
  'gpt-4.1':
    'Former report-grading default (gpt-5.6 from B0-765, claude-opus-5 from B0-822). $2.00 → $8.00 per Mtok.',
  'gpt-5.5':
    'Resolves to gpt-5.5-2026-04-23. Candidate validator model (B0-603). $5.00 → $30.00 per Mtok — ~2.5x gpt-4.1 in, ~3.75x out.',
  'gpt-5.6':
    'Alias for gpt-5.6-sol. Candidate orchestrator/routing model (B0-604). $5.00 → $30.00 per Mtok. Pin an explicit -sol/-terra/-luna id if the alias target matters.',
  // B0-908 — Anthropic first-party Claude API standard rates (model table cached 2026-06-24).
  'claude-haiku-4-5':
    'Anthropic equivalent of gpt-4.1-mini. Cheapest Claude tier; 200K context. $1.00 → $5.00 per Mtok. Called on the Anthropic Messages API; needs ANTHROPIC_API_KEY.',
  'claude-sonnet-4-6':
    'Anthropic equivalent of gpt-4o. Previous-generation Sonnet. $3.00 → $15.00 per Mtok. Called on the Anthropic Messages API; needs ANTHROPIC_API_KEY.',
  'claude-sonnet-5':
    'Anthropic equivalent of gpt-4.1. Current Sonnet; cheaper than sonnet-4-6. $2.00 → $10.00 per Mtok. Called on the Anthropic Messages API; needs ANTHROPIC_API_KEY.',
  'claude-opus-4-8':
    'Anthropic equivalent of gpt-5.5. Previous-generation Opus. $5.00 → $25.00 per Mtok. Called on the Anthropic Messages API; needs ANTHROPIC_API_KEY.',
  'claude-opus-5':
    'Anthropic equivalent of gpt-5.6. Current Opus and the report-grading default since B0-822. $5.00 → $25.00 per Mtok. Called on the Anthropic Messages API; needs ANTHROPIC_API_KEY.',
};

const supportedModels: SupportedModel[] = [
  {
    name: 'gpt-4o',
    label: 'Model: gpt-4o',
  },
  {
    name: 'gpt-4.1-mini',
    label: 'Model: gpt-4.1-mini',
  },
  {
    name: 'gpt-4.1',
    label: 'Model: gpt-4.1',
  },
  { name: 'gpt-5.5', label: 'Model: gpt-5.5' },
  { name: 'gpt-5.6', label: 'Model: gpt-5.6' },
  // B0-908 — Anthropic equivalents, same order as ANTHROPIC_MODEL_TAGS.
  { name: 'claude-haiku-4-5', label: 'Model: claude-haiku-4-5' },
  { name: 'claude-sonnet-4-6', label: 'Model: claude-sonnet-4-6' },
  { name: 'claude-sonnet-5', label: 'Model: claude-sonnet-5' },
  { name: 'claude-opus-4-8', label: 'Model: claude-opus-4-8' },
  { name: 'claude-opus-5', label: 'Model: claude-opus-5' },
];

export default supportedModels;
