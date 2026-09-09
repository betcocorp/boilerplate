import {
  isAnthropicModelTag,
  modelProviderFor,
  type AnthropicModelTag,
} from '~/lib/constants/models';
import { resolveResponsesModel } from '~/lib/openai/client';
import { getLlmProvider, getStringSetting } from '~/lib/settings/settings-service';

/**
 * B0-899 — the vendor-neutral tag → model-id resolver every generation and judgment call site goes
 * through. `resolveResponsesModel` (`~/lib/openai/client`) keeps owning the per-tag mapping and the
 * `BEX_MODEL_*` env pins; this layer adds exactly one thing on top: what the `preview` (and empty)
 * tag resolves to when the caller has not named a model.
 *
 * **The precedence rule for `preview`, defined here and nowhere else.** Two rows can speak, and the
 * more specific one wins — the same principle that already makes an explicit picker tag beat the
 * fleet default:
 *
 *   1. `BEX_RESPONSES_MODEL` names a `claude-*` model → that model. A named model is an explicit
 *      choice, so it beats the vendor switch. This is the pre-B0-899 control: setting
 *      `claude-opus-5` here is how the fleet is put on Claude, and it keeps working.
 *   2. Otherwise `BEX_LLM_PROVIDER = anthropic` → the `BEX_ANTHROPIC_MODEL` row. This is the vendor
 *      switch: flip one row and every `preview` caller moves to Claude without retyping a model.
 *   3. Otherwise → `BEX_RESPONSES_MODEL`, i.e. today's OpenAI behaviour.
 *
 * So `BEX_ANTHROPIC_MODEL` answers "which Claude model do I use when the vendor switch is thrown",
 * and it is consulted only while the model row names an OpenAI model. Both controls work; neither
 * silently overrides the other.
 *
 * An explicit tag (`gpt-4.1`, `claude-sonnet-5`, …) skips all of that: the vendor is implied by the
 * tag (`modelProviderFor`), never by a flag, so picking a Claude model on the Bex picker or the
 * /admin/tests run form works regardless of either row.
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
 * `preview` resolves to when the vendor switch is thrown AND the fleet-default row names an OpenAI
 * model (step 2 of the precedence rule above). `settings.allowed_values` is
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
 * - `preview` / empty / undefined → the fleet default, by the three-step precedence rule above.
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
    /**
     * Step 1 — a Claude model named in the fleet-default row is an explicit choice and wins.
     *
     * Resolved via `resolveResponsesModel('preview')` rather than by reading the row directly: that
     * already applies `BEX_RESPONSES_MODEL` and the `BEX_MODEL_*` env pins, so the vendor is decided
     * on the FINAL model id and a pinned Claude snapshot is recognised too.
     */
    const fleetModel = await resolveResponsesModel('preview');
    if (modelProviderFor(fleetModel) === 'anthropic') {
      return fleetModel;
    }

    // Step 2 — the vendor switch, consulted only while the row above names an OpenAI model. Sent
    // back through resolveResponsesModel so the BEX_MODEL_CLAUDE_* pin applies to `preview` too,
    // mirroring what B0-831 does for the OpenAI default tag.
    if ((await getLlmProvider()) === 'anthropic') {
      return resolveResponsesModel(await resolveAnthropicModelDefaultTag());
    }

    // Step 3 — OpenAI, unchanged.
    return fleetModel;
  }

  return resolveResponsesModel(tag);
}
