import OpenAI from 'openai';

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
 * Maps UI / API model tags to OpenAI Responses model IDs. Centralize here — do not branch ad hoc.
 */
export function resolveResponsesModel(modelTag: string | undefined): string {
  const tag = (modelTag ?? 'preview').trim();
  const previewDefault =
    process.env.BEX_RESPONSES_MODEL ?? process.env.OPENAI_BEX_MODEL ?? 'gpt-4.1-mini';

  if (tag === 'preview' || tag === '') {
    return previewDefault;
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
      'Custom model tag is not configured; set BEX_RESPONSES_MODEL or pass a concrete model name.',
    );
  }

  return tag;
}
