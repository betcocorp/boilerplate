import { modelProviderFor } from '~/lib/constants/models';

/**
 * B0-912 — names, and only names, WHICH generation loop serves a turn.
 *
 * Two loops exist and both stay (B0-378, decision record `src/docs/generation-runtimes.md`): the
 * OpenAI **Responses** loop (`~/lib/openai/responses-runtime.ts`, canonical/default) and the AI SDK
 * `streamText` loop (`~/lib/bex/ai-sdk-runtime.ts`). Which one runs is NOT a free choice — it is
 * decided per model: the Responses loop throws on a `claude-*` id by design (it IS the OpenAI
 * Responses API), so an Anthropic model FORCES the AI SDK loop, while
 * `BEX_AI_SDK_GENERATION_ENABLED` (a settings row, default false — B0-638) is an opt-in for OpenAI
 * models only.
 *
 * Why this module exists: on 2026-09-08 a paired OpenAI-vs-Anthropic eval comparison was read as a
 * vendor verdict, when in fact the two arms had run on two DIFFERENT generation loops and nothing
 * on either report said so. `selectGenerationRuntime` is the extracted, testable form of the
 * expression `run-product-support-workflow.ts` already evaluated inline, so the run-level label the
 * eval harness persists and the per-turn decision the workflow makes cannot drift apart.
 *
 * SCOPE: visibility only. This module must not change which runtime is selected — converging on
 * one loop is B0-914 and needs a human decision.
 */

export const GENERATION_RUNTIMES = ['responses', 'ai_sdk'] as const;

export type GenerationRuntime = (typeof GENERATION_RUNTIMES)[number];

/** Human-readable name for each loop, spelled the same way on every surface. */
export const GENERATION_RUNTIME_LABELS = {
  responses: 'OpenAI Responses loop',
  ai_sdk: 'AI SDK streamText loop',
} as const satisfies Record<GenerationRuntime, string>;

/** Short chip text, for places where the full label does not fit (badges, table cells). */
export const GENERATION_RUNTIME_SHORT_LABELS = {
  responses: 'responses',
  ai_sdk: 'ai-sdk',
} as const satisfies Record<GenerationRuntime, string>;

export function isGenerationRuntime(value: unknown): value is GenerationRuntime {
  return (
    typeof value === 'string' && (GENERATION_RUNTIMES as readonly string[]).includes(value)
  );
}

export function generationRuntimeLabel(runtime: GenerationRuntime): string {
  return GENERATION_RUNTIME_LABELS[runtime];
}

/**
 * Why this run got the loop it got, in one sentence — so a reader never has to know the flag rule.
 */
export function generationRuntimeRationale(model: string): string {
  return modelProviderFor(model) === 'anthropic'
    ? `${model} is an Anthropic model, which only the AI SDK loop can serve (the OpenAI Responses loop rejects a claude-* id by design).`
    : `${model} is an OpenAI model, so the loop follows the BEX_AI_SDK_GENERATION_ENABLED setting (default off = the canonical Responses loop).`;
}

/**
 * The EFFECTIVE runtime for a resolved model id, given the `BEX_AI_SDK_GENERATION_ENABLED` value
 * this turn observed. Pure, so it can be asserted directly; the setting read is the caller's.
 */
export function selectGenerationRuntime(params: {
  /** A resolved model ID (or tag) — `modelProviderFor`'s `claude-` prefix test is what decides. */
  model: string;
  aiSdkGenerationSetting: boolean;
}): GenerationRuntime {
  return modelProviderFor(params.model) === 'anthropic' || params.aiSdkGenerationSetting
    ? 'ai_sdk'
    : 'responses';
}

/**
 * B0-912 — the runtime a model id can ONLY have been served by, or `null` when the id does not
 * settle it. Anthropic is settled: the OpenAI Responses loop rejects a `claude-*` id, so such a run
 * ran on the AI SDK loop whatever the flag said, and that is recoverable after the fact. An OpenAI
 * id is NOT settled — it depended on `BEX_AI_SDK_GENERATION_ENABLED` as it was at the time, which
 * no longer exists anywhere. Used only as a fallback for runs written before
 * `summary.generationRuntime`: null then omits the label rather than guessing at it.
 */
export function certainGenerationRuntimeForModel(model: string): GenerationRuntime | null {
  return modelProviderFor(model) === 'anthropic' ? 'ai_sdk' : null;
}

/**
 * Deliberately NO settings read in this module: it is imported by client components (the run-report
 * header renders `GENERATION_RUNTIME_LABELS`), and `~/lib/settings/settings-service` pulls in the
 * service-role Supabase client. Callers that need the effective runtime read
 * `BEX_AI_SDK_GENERATION_ENABLED` themselves and pass it in — which is what the workflow already
 * does for its own turn.
 */
