import OpenAI from 'openai';

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
export const DEFAULT_BEX_RESPONSES_MODEL = 'gpt-4.1-mini';

/**
 * B0-757 — the `BEX_RESPONSES_MODEL` settings row: the concrete model id `preview` (and any
 * missing or empty `modelTag`) resolves to.
 *
 * Deliberately NOT restricted to `BEX_MODEL_TAGS` the way `resolveValidatorModelTag`/
 * `resolveRouterModelTag` restrict their rows: the old `BEX_RESPONSES_MODEL`/`OPENAI_BEX_MODEL` env
 * vars accepted ANY concrete model id (e.g. a dated snapshot like `gpt-4.1-mini-2026-01-01`, the
 * same "pin an exact id without a deploy" pattern as `BEX_MODEL_GPT55`/`BEX_MODEL_GPT41`), and this
 * row replaces them one-for-one. The only guard is against the literal string `'preview'`, which
 * would otherwise make this resolve to itself.
 */
export async function resolveGenerationModelDefaultTag(): Promise<string> {
  const raw = (
    await getStringSetting('BEX_RESPONSES_MODEL', DEFAULT_BEX_RESPONSES_MODEL)
  ).trim();
  return raw && raw !== 'preview' ? raw : DEFAULT_BEX_RESPONSES_MODEL;
}

/**
 * Maps UI / API model tags to OpenAI Responses model IDs. Centralize here — do not branch ad hoc.
 *
 * Async since B0-757: the `preview` branch now reads the `BEX_RESPONSES_MODEL` settings row
 * instead of an env var. Every other branch stays a synchronous mapping; only `preview`/empty needs
 * the settings round trip, cached 30s by `~/lib/settings/settings-service`.
 */
export async function resolveResponsesModel(modelTag: string | undefined): Promise<string> {
  const tag = (modelTag ?? 'preview').trim();

  if (tag === 'preview' || tag === '') {
    return resolveGenerationModelDefaultTag();
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

  return tag;
}
