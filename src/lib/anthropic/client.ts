import Anthropic from '@anthropic-ai/sdk';

let cached: Anthropic | null = null;

/**
 * B0-819 — the one Anthropic client, mirroring `getOpenAIClient`. `ANTHROPIC_API_KEY` is a secret,
 * so it is the one piece of this provider that lives in env rather than `public.settings` (B0-638).
 *
 * B0-908 — no longer grader-only. Every single-shot call site (run-report grader, router,
 * validator, …) reaches this client through `~/lib/llm/structured-completion.ts` whenever its model
 * tag is `claude-*` (`modelProviderFor`), and the Bex chat AI SDK loop uses `@ai-sdk/anthropic`,
 * which reads the same `ANTHROPIC_API_KEY` env var directly rather than this SDK instance.
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
