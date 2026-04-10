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

  if (tag === 'custom') {
    throw new Error(
      'Custom model tag is not configured; set BEX_RESPONSES_MODEL or pass a concrete model name.',
    );
  }

  return tag;
}
