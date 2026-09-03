import Anthropic from '@anthropic-ai/sdk';

let cached: Anthropic | null = null;

/**
 * B0-819 — the one Anthropic client, mirroring `getOpenAIClient`. `ANTHROPIC_API_KEY` is a secret,
 * so it is the one piece of this provider that lives in env rather than `public.settings` (B0-638).
 * Reached only through `~/lib/llm/structured-completion.ts` by the run-report grader; the Bex chat
 * runtimes stay on OpenAI.
 */
export function getAnthropicClient(): Anthropic {
  if (cached) {
    return cached;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured.');
  }

  cached = new Anthropic({ apiKey });
  return cached;
}
