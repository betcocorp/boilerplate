import Anthropic from '@anthropic-ai/sdk';

let cached: Anthropic | null = null;

/**
 * The one Anthropic client, mirroring `getOpenAIClient`. `ANTHROPIC_API_KEY` is a secret, so it
 * lives in env rather than a `settings` table row.
 *
 * Any single-shot call site reaches this client through `~/lib/llm/structured-completion.ts`
 * whenever its model tag is `claude-*` (`modelProviderFor`); a streaming chat loop built on
 * `@ai-sdk/anthropic` instead reads the same `ANTHROPIC_API_KEY` env var directly, not through
 * this SDK instance.
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
