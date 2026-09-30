/**
 * The single canonical list of selectable chat model tags.
 *
 * A tag is NOT necessarily a model id — `resolveModel` (`~/lib/llm/resolve-model`) is the resolver
 * every call site goes through: it sends `preview` to the default row of the vendor in
 * `BEX_LLM_PROVIDER` (`BEX_RESPONSES_MODEL` for OpenAI, `BEX_ANTHROPIC_MODEL` for Anthropic) and
 * every explicit tag to `resolveResponsesModel` (`~/lib/openai/client`), which owns the per-tag
 * mapping and the `BEX_MODEL_*` env pins. `modelProviderFor` decides which API is called (OpenAI
 * Responses for gpt tags, Anthropic Messages / AI SDK Anthropic provider for `claude-*` tags).
 * Adding a tag here requires one follow-up: a branch in `resolveResponsesModel` if the tag needs an
 * env override.
 */

/** The OpenAI tags, as their own list so the OpenAI default row can be validated against exactly this subset. */
export const OPENAI_MODEL_TAGS = ['gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'] as const;

export type OpenAiModelTag = (typeof OPENAI_MODEL_TAGS)[number];

export function isOpenAiModelTag(value: string): value is OpenAiModelTag {
  return (OPENAI_MODEL_TAGS as readonly string[]).includes(value);
}

/**
 * Anthropic tier-for-tier equivalents of the OpenAI tags. Exact Claude API ids — never append a
 * date suffix. Unlike a gpt tag, an Anthropic tag IS the model id the Messages API is called with
 * (`resolveResponsesModel` only layers the optional `BEX_MODEL_CLAUDE_*` env pin on it).
 */
export const ANTHROPIC_MODEL_TAGS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5'] as const;

export type AnthropicModelTag = (typeof ANTHROPIC_MODEL_TAGS)[number];

export function isAnthropicModelTag(value: string): value is AnthropicModelTag {
  return (ANTHROPIC_MODEL_TAGS as readonly string[]).includes(value);
}

/**
 * Every selectable tag, including the settings-driven `preview` default. This is the union list
 * every picker renders; the two per-vendor subsets above are what the two default rows validate
 * against.
 */
export const BEX_MODEL_TAGS = ['preview', ...OPENAI_MODEL_TAGS, ...ANTHROPIC_MODEL_TAGS] as const;

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
 * Anthropic `output_config.effort` levels: how much the model thinks before it answers. OpenAI
 * models ignore it.
 */
export const MODEL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export function isModelEffort(value: string): value is ModelEffort {
  return (MODEL_EFFORTS as readonly string[]).includes(value);
}

/**
 * Shown under the model selector so whoever starts a run knows what they are choosing. Rates are
 * illustrative — wire these to `public.model_pricing` (or your own pricing source) once you have one.
 *
 * `custom` is intentionally absent: `resolveResponsesModel` unconditionally THROWS on that tag (a
 * caller must pass a concrete model id directly instead), so offering it in a dropdown just
 * produces a failed run.
 */
export const MODEL_DESCRIPTIONS: Record<BexModelTag, string> = {
  preview:
    'Settings-table default: resolves via the BEX_LLM_PROVIDER row to BEX_RESPONSES_MODEL (OpenAI) or BEX_ANTHROPIC_MODEL (Anthropic). Use this as the A/B baseline.',
  'gpt-4o': 'Older general-purpose OpenAI model.',
  'gpt-4.1-mini': 'Cheapest OpenAI tier; the default `preview` resolves to when BEX_LLM_PROVIDER is openai.',
  'gpt-4.1': 'Mid-tier OpenAI model.',
  'claude-haiku-4-5': 'Anthropic equivalent of gpt-4.1-mini. Cheapest Claude tier. Needs ANTHROPIC_API_KEY.',
  'claude-sonnet-4-6': 'Anthropic equivalent of gpt-4o. Needs ANTHROPIC_API_KEY.',
  'claude-sonnet-5': 'Anthropic equivalent of gpt-4.1; the default `preview` resolves to when BEX_LLM_PROVIDER is anthropic. Needs ANTHROPIC_API_KEY.',
};

const supportedModels: SupportedModel[] = [
  { name: 'gpt-4o', label: 'Model: gpt-4o' },
  { name: 'gpt-4.1-mini', label: 'Model: gpt-4.1-mini' },
  { name: 'gpt-4.1', label: 'Model: gpt-4.1' },
  { name: 'claude-haiku-4-5', label: 'Model: claude-haiku-4-5' },
  { name: 'claude-sonnet-4-6', label: 'Model: claude-sonnet-4-6' },
  { name: 'claude-sonnet-5', label: 'Model: claude-sonnet-5' },
];

export default supportedModels;
