import {
  isAnthropicModelTag,
  type AnthropicModelTag,
} from '~/lib/constants/models';
import { resolveResponsesModel } from '~/lib/openai/client';
import { getLlmProvider, getStringSetting } from '~/lib/settings/settings-service';

/**
 * B0-899 — the vendor-neutral tag → model-id resolver every generation and judgment call site goes
 * through. `resolveResponsesModel` (`~/lib/openai/client`) keeps owning the per-tag mapping and the
 * `BEX_MODEL_*` env pins; this layer adds exactly one thing on top: the `preview` (and empty) tag
 * is resolved through the `BEX_LLM_PROVIDER` settings row (B0-897), so an admin picks the default
 * VENDOR on /admin/settings and each vendor has its own default MODEL row:
 *
 *   BEX_LLM_PROVIDER = openai    → `preview` → BEX_RESPONSES_MODEL row (OpenAI tags only; the
 *                                   pre-B0-899 behaviour, byte-for-byte)
 *   BEX_LLM_PROVIDER = anthropic → `preview` → BEX_ANTHROPIC_MODEL row (Anthropic tags only)
 *
 * An explicit tag (`gpt-4.1`, `claude-sonnet-5`, …) bypasses the provider row entirely: the vendor
 * is implied by the tag (`modelProviderFor`), never by a flag, so picking a Claude model on the Bex
 * picker or the /admin/tests run form works regardless of the fleet default.
 */

export const ANTHROPIC_MODEL_SETTING_KEY = 'BEX_ANTHROPIC_MODEL';

/**
 * Code fallback when the `BEX_ANTHROPIC_MODEL` row is missing or holds an out-of-set value. The
 * epic (B0-898) left sonnet-vs-opus as an open question for Tom; `claude-sonnet-5` (the gpt-4.1
 * tier equivalent, B0-908) is the cheaper of the two and is what the row is seeded with.
 */
export const DEFAULT_BEX_ANTHROPIC_MODEL_TAG: AnthropicModelTag = 'claude-sonnet-5';

/**
 * The Anthropic counterpart of `resolveGenerationModelDefaultTag`: the `ANTHROPIC_MODEL_TAGS` tag
 * that `preview` resolves to when the fleet provider is `anthropic`. `settings.allowed_values` is
 * advisory (the admin API validates writes against it, the DB does not), so the stored value is
 * re-validated here and anything unrecognised falls back to the default tag instead of reaching
 * the Anthropic API as a non-existent model id.
 */
export async function resolveAnthropicModelDefaultTag(): Promise<AnthropicModelTag> {
  const raw = (
    await getStringSetting(ANTHROPIC_MODEL_SETTING_KEY, DEFAULT_BEX_ANTHROPIC_MODEL_TAG)
  ).trim();
  return isAnthropicModelTag(raw) ? raw : DEFAULT_BEX_ANTHROPIC_MODEL_TAG;
}

/**
 * Resolves a UI/API model tag to the concrete id the provider is called with.
 *
 * - `preview` / empty / undefined → the fleet default for the vendor in `BEX_LLM_PROVIDER` (above).
 * - anything else → `resolveResponsesModel(tag)` unchanged, so the `BEX_MODEL_GPT*` and
 *   `BEX_MODEL_CLAUDE_*` env pins apply exactly as before and a `claude-*` tag passes through as
 *   the exact Claude API id.
 *
 * The return value is what B0-563 stamps into `workflow_steps.output.model` and what the B0-565
 * cost views join to `model_pricing`, so every id this can return must have a pricing row.
 */
export async function resolveModel(modelTag: string | undefined): Promise<string> {
  const tag = (modelTag ?? 'preview').trim();

  if (tag === 'preview' || tag === '') {
    const provider = await getLlmProvider();
    if (provider === 'anthropic') {
      // Back through resolveResponsesModel so the BEX_MODEL_CLAUDE_* pin applies to `preview` too,
      // mirroring what B0-831 does for the OpenAI default tag.
      return resolveResponsesModel(await resolveAnthropicModelDefaultTag());
    }
    return resolveResponsesModel('preview');
  }

  return resolveResponsesModel(tag);
}
