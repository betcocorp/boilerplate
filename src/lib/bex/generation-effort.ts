import { isModelEffort, type ModelEffort } from '~/lib/constants/models';
import { getStringSetting } from '~/lib/settings/settings-service';

/**
 * B0-913 — how hard an Anthropic model thinks while GENERATING a Bex answer.
 *
 * Anthropic bills adaptive thinking tokens as output. A paired eval on 2026-09-08 (106 generation
 * steps each) put claude-opus-5 at 141,693 completion tokens against gpt-5.6's 68,276 — 2.08x — even
 * though Opus 5 is the cheaper model per output token ($25.00 vs $30.00 per Mtok in
 * `public.model_pricing`). Grading already had a per-route effort knob (`REPORT_GRADING_EFFORT`,
 * `TEST_ITEM_GRADING_EFFORT`); generation had none, so there was no way to trade depth for spend on
 * the answering path without switching model.
 *
 * This is a settings row (B0-638 — never env), read by `runAiSdkWithToolLoop`
 * (`~/lib/bex/ai-sdk-runtime.ts`) and forwarded as `providerOptions.anthropic.effort`, which
 * `@ai-sdk/anthropic` emits as `output_config.effort`. OpenAI models never see it: the Responses
 * loop is a different runtime and the AI SDK's OpenAI branch is gated on provider.
 */

export const GENERATION_EFFORT_SETTING_KEY = 'BEX_GENERATION_EFFORT';

/**
 * The sentinel row value meaning "send no `effort` at all" — the pre-B0-913 behaviour, where the
 * request carried no `output_config` and Anthropic's own default applied. It is the seeded default,
 * so applying this ticket changes nothing on the wire until an admin picks a level.
 *
 * Deliberately a sentinel rather than the literal `'high'`: Anthropic documents `high` as
 * equivalent to omitting `effort`, but "equivalent" is a claim about the server, and a
 * cost/behaviour lever should be a provable no-op in its default state — with the sentinel the
 * request body is byte-identical to what shipped before.
 */
export const GENERATION_EFFORT_PROVIDER_DEFAULT = 'provider_default';

export type GenerationEffortSetting = typeof GENERATION_EFFORT_PROVIDER_DEFAULT | ModelEffort;

export const DEFAULT_GENERATION_EFFORT_SETTING: GenerationEffortSetting =
  GENERATION_EFFORT_PROVIDER_DEFAULT;

/**
 * Reads the `BEX_GENERATION_EFFORT` row as a typed value. `settings.allowed_values` is advisory
 * metadata the admin API validates writes against, NOT a DB constraint (only `value_type` has a
 * CHECK), so the stored string is re-validated here: anything that is neither the sentinel nor a
 * `MODEL_EFFORTS` level falls back to the sentinel rather than reaching the API as an invalid
 * `output_config.effort`.
 */
export async function loadGenerationEffortSetting(): Promise<GenerationEffortSetting> {
  const raw = (await getStringSetting(GENERATION_EFFORT_SETTING_KEY, DEFAULT_GENERATION_EFFORT_SETTING))
    .trim()
    .toLowerCase();
  if (raw === GENERATION_EFFORT_PROVIDER_DEFAULT) return GENERATION_EFFORT_PROVIDER_DEFAULT;
  return isModelEffort(raw) ? raw : DEFAULT_GENERATION_EFFORT_SETTING;
}

/**
 * The effort to actually send, or `undefined` for "send nothing" — the shape the runtime spreads
 * into `providerOptions.anthropic`. Callers must still gate on the model supporting it
 * (`supportsAnthropicAdaptiveThinking`, `~/lib/llm/structured-completion.ts`): Haiku-class and older
 * Claude ids reject `output_config.effort` with a 400.
 */
export async function loadGenerationEffort(): Promise<ModelEffort | undefined> {
  const setting = await loadGenerationEffortSetting();
  return setting === GENERATION_EFFORT_PROVIDER_DEFAULT ? undefined : setting;
}
