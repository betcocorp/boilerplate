import { modelProviderFor } from '~/lib/constants/models';

/**
 * Names WHICH generation loop served a turn or a run.
 *
 * Since B0-914 there is exactly one live loop, the AI SDK `streamText` loop
 * (`~/lib/bex/ai-sdk-runtime.ts`), for every model on every provider. The OpenAI Responses loop and
 * the `BEX_AI_SDK_GENERATION_ENABLED` selector were removed; `src/docs/generation-runtimes.md` holds
 * the decision record and the evidence behind it.
 *
 * `'responses'` stays in this vocabulary for one reason only: runs and prompt records written
 * before the cutover carry it, and the admin run reports must keep labelling them truthfully rather
 * than rewriting history. Nothing new is ever written with it.
 */

export const GENERATION_RUNTIMES = ['responses', 'ai_sdk'] as const;

export type GenerationRuntime = (typeof GENERATION_RUNTIMES)[number];

/** The loop every turn runs on now. Use this rather than a string literal at call sites. */
export const CURRENT_GENERATION_RUNTIME = 'ai_sdk' as const satisfies GenerationRuntime;

/** Human-readable name for each loop, spelled the same way on every surface. */
export const GENERATION_RUNTIME_LABELS = {
  responses: 'OpenAI Responses loop (retired)',
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

/** Why this run got the loop it got, in one sentence. */
export function generationRuntimeRationale(model: string): string {
  return `${model} runs on the AI SDK loop: it is the only generation loop since B0-914.`;
}

/**
 * The runtime a RECORDED run can be proven to have used, or `null` when the record does not settle
 * it. Only meaningful for runs written before `summary.generationRuntime` existed (B0-912): an
 * Anthropic id was always the AI SDK loop, but an OpenAI id depended on a settings row that no
 * longer exists, so it stays unknown and the label is omitted rather than guessed.
 */
export function certainGenerationRuntimeForModel(model: string): GenerationRuntime | null {
  return modelProviderFor(model) === 'anthropic' ? 'ai_sdk' : null;
}
