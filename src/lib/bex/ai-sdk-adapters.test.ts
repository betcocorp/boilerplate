import { describe, expect, it, vi } from 'vitest';

// The tag → id mapping is `resolveResponsesModel`'s job (env pins, the `preview` settings row);
// here it is a passthrough so the test exercises only the provider choice.
vi.mock('~/lib/openai/client', () => ({
  resolveResponsesModel: (tag?: string) => Promise.resolve(tag ?? 'gpt-4.1-mini'),
}));

import { aiSdkProviderFor, resolveAiSdkLanguageModel } from '~/lib/bex/ai-sdk-adapters';

describe('resolveAiSdkLanguageModel (B0-908)', () => {
  it('serves a claude-* id through the Anthropic provider', async () => {
    const model = await resolveAiSdkLanguageModel('claude-sonnet-5');
    expect(model.modelId).toBe('claude-sonnet-5');
    expect(model.provider.startsWith('anthropic')).toBe(true);
  });

  it('keeps OpenAI ids on the OpenAI provider', async () => {
    const model = await resolveAiSdkLanguageModel('gpt-4.1');
    expect(model.modelId).toBe('gpt-4.1');
    expect(model.provider.startsWith('openai')).toBe(true);
  });

  it('decides by the claude- prefix, not by list membership', () => {
    expect(aiSdkProviderFor('claude-haiku-4-5')).toBe('anthropic');
    expect(aiSdkProviderFor('claude-opus-4-8')).toBe('anthropic');
    expect(aiSdkProviderFor('gpt-5.6')).toBe('openai');
    expect(aiSdkProviderFor('o4-mini')).toBe('openai');
  });

  it('does not need ANTHROPIC_API_KEY until a request is made', async () => {
    // The provider reads its key lazily (request headers), so constructing a Claude model must not
    // throw whatever the test runner's env holds.
    await expect(resolveAiSdkLanguageModel('claude-opus-5')).resolves.toBeDefined();
  });
});
