import OpenAI from 'openai';

import {
  isBexModelTag,
  modelProviderFor,
  type ExplicitBexModelTag,
} from '~/lib/constants/models';
import { getStringSetting } from '~/lib/settings/settings-service';

let cached: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (cached) {
    return cached;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  cached = new OpenAI({ apiKey });
  return cached;
}

/**
 * B0-757 — real prior default: neither BEX_RESPONSES_MODEL nor OPENAI_BEX_MODEL was ever actually
 * set as an env var in any environment, so `preview` has always silently resolved to this. Seeded
 * as the settings row default so this migration is behavior-preserving.
 */
export const DEFAULT_BEX_RESPONSES_MODEL_TAG: ExplicitBexModelTag = 'gpt-4.1-mini';

/**
 * B0-831 — the `BEX_RESPONSES_MODEL` settings row: the `BEX_MODEL_TAGS` TAG that `preview` (and any
 * missing or empty `modelTag`) resolves to, re-validated against the enum before use exactly like
 * `resolveRouterModelTag` / `resolveValidatorModelTag`. `settings.allowed_values` is advisory
 * metadata the admin API validates writes against, NOT a database constraint, so an unrecognized
 * stored value falls back to the default tag rather than being handed to the API as a non-existent
 * model id. `preview` is excluded because it would resolve to itself. Pinning an exact id (a dated
 * snapshot, a `-sol`/`-terra` variant) is what the `BEX_MODEL_*` env overrides are for — and since
 * the tag goes back through `resolveResponsesModel`, those pins now apply to `preview` too.
 */
export async function resolveGenerationModelDefaultTag(): Promise<ExplicitBexModelTag> {
  const raw = (
    await getStringSetting('BEX_RESPONSES_MODEL', DEFAULT_BEX_RESPONSES_MODEL_TAG)
  ).trim();
  return isBexModelTag(raw) && raw !== 'preview' ? raw : DEFAULT_BEX_RESPONSES_MODEL_TAG;
}

/**
 * Maps UI / API model tags to OpenAI Responses model IDs. Centralize here — do not branch ad hoc.
 *
 * Async since B0-757: the `preview` branch reads the `BEX_RESPONSES_MODEL` settings row instead of
 * an env var. Since B0-831 that row holds a tag, which is resolved by recursing into this function
 * so `preview` picks up the same env pins every explicit tag does. Every other branch stays a
 * synchronous mapping; only `preview`/empty needs the settings round trip, cached 30s by
 * `~/lib/settings/settings-service`.
 *
 * B0-908 — despite the name, this also resolves Anthropic tags (`claude-*`): the return value is
 * whatever id the provider chosen by `modelProviderFor` is called with, so a `BEX_RESPONSES_MODEL`
 * row set to `claude-sonnet-5` makes `preview` resolve to `claude-sonnet-5`.
 */
export async function resolveResponsesModel(modelTag: string | undefined): Promise<string> {
  const tag = (modelTag ?? 'preview').trim();

  if (tag === 'preview' || tag === '') {
    // B0-831 — the row holds a tag (never `preview`, so this cannot loop); sending it back through
    // here applies the same BEX_MODEL_* env pins every explicit tag gets, like resolveRouterModel.
    return resolveResponsesModel(await resolveGenerationModelDefaultTag());
  }

  if (tag === 'gpt-4o') {
    return process.env.BEX_MODEL_GPT4O ?? 'gpt-4o';
  }

  if (tag === 'gpt-4.1') {
    return process.env.BEX_MODEL_GPT41 ?? 'gpt-4.1';
  }

  /**
   * B0-598 — explicit branches so these two tags get the same env-override escape hatch every other
   * named tag has (pin a dated snapshot, or repoint at a variant, without a deploy).
   *
   * Both already worked via the passthrough at the bottom of this function, verified against the
   * live API on 2026-08-20: 'gpt-5.5' resolves to gpt-5.5-2026-04-23, and 'gpt-5.6' is a servable
   * alias for gpt-5.6-sol (it does NOT appear in /v1/models, but the Responses API accepts it).
   *
   * COST CAVEAT: `public.model_pricing` is keyed to the TAG string, because B0-563 stamps
   * `workflow_steps.output.model` from this function's return value. Overriding either env var to a
   * model id with no pricing row silently drops those steps from the B0-565 cost views (INNER
   * lateral join) rather than pricing them at zero. Add a matching pricing row alongside any
   * override. Same hazard already applies to BEX_MODEL_GPT4O / BEX_MODEL_GPT41.
   */
  if (tag === 'gpt-5.5') {
    return process.env.BEX_MODEL_GPT55 ?? 'gpt-5.5';
  }

  if (tag === 'gpt-5.6') {
    return process.env.BEX_MODEL_GPT56 ?? 'gpt-5.6';
  }

  if (tag === 'custom') {
    throw new Error(
      "Custom model tag is not configured; pass a concrete model name instead of 'custom'.",
    );
  }

  /**
   * B0-908 — Anthropic tags. An Anthropic tag IS the exact Claude API id (`claude-sonnet-5`,
   * `claude-opus-5`, …) and is called on the Anthropic Messages API (or the AI SDK Anthropic
   * provider for chat), never on OpenAI Responses — so the default is the tag itself. The env pin
   * mirrors the gpt branches above, keyed by the upper-snake tag: `BEX_MODEL_CLAUDE_SONNET_5`,
   * `BEX_MODEL_CLAUDE_OPUS_4_8`, `BEX_MODEL_CLAUDE_HAIKU_4_5`, … Use it to pin a dated snapshot
   * or repoint a tier without a deploy.
   *
   * SAME COST CAVEAT as the gpt pins: `public.model_pricing` is keyed to the string this function
   * returns, so pinning to an id with no pricing row silently drops those steps from the B0-565
   * cost views (INNER lateral join). Add a matching `model_pricing` row alongside any override.
   */
  if (modelProviderFor(tag) === 'anthropic') {
    return process.env[anthropicModelPinEnvKey(tag)] ?? tag;
  }

  return tag;
}

/** `claude-sonnet-5` → `BEX_MODEL_CLAUDE_SONNET_5`; `claude-opus-4-8` → `BEX_MODEL_CLAUDE_OPUS_4_8`. */
export function anthropicModelPinEnvKey(tag: string): string {
  return `BEX_MODEL_${tag.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}
