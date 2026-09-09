import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-899 — `resolveModel` is the provider-aware layer over `resolveResponsesModel`. Only the two
 * settings getters are mocked (the same module `resolveResponsesModel` reads `BEX_RESPONSES_MODEL`
 * through), mirroring `~/lib/openai/model-resolution.test.ts`; every explicit-tag branch is the
 * synchronous mapping over `process.env.BEX_MODEL_*` that file already covers.
 */
vi.mock('~/lib/settings/settings-service', () => ({
  getStringSetting: vi.fn((_key: string, fallback: string) => Promise.resolve(fallback)),
  getLlmProvider: vi.fn(() => Promise.resolve('openai')),
}));

import { getLlmProvider, getStringSetting } from '~/lib/settings/settings-service';
import {
  ANTHROPIC_MODEL_SETTING_KEY,
  DEFAULT_BEX_ANTHROPIC_MODEL_TAG,
  resolveAnthropicModelDefaultTag,
  resolveModel,
} from '~/lib/llm/resolve-model';
import {
  anthropicModelPinEnvKey,
  DEFAULT_BEX_RESPONSES_MODEL_TAG,
  resolveGenerationModelDefaultTag,
  resolveResponsesModel,
} from '~/lib/openai/client';
import {
  ANTHROPIC_MODEL_TAGS,
  BEX_MODEL_TAGS,
  OPENAI_MODEL_TAGS,
  modelProviderFor,
} from '~/lib/constants/models';

const MODEL_ENV_KEYS = [
  'BEX_MODEL_GPT4O',
  'BEX_MODEL_GPT41',
  'BEX_MODEL_GPT55',
  'BEX_MODEL_GPT56',
  ...ANTHROPIC_MODEL_TAGS.map(anthropicModelPinEnvKey),
];

const saved: Record<string, string | undefined> = {};

/** Stored settings for a test; anything not listed resolves to the caller's fallback. */
function stubSettings(rows: Record<string, string>) {
  vi.mocked(getStringSetting).mockImplementation((key, fallback) =>
    Promise.resolve(key in rows ? rows[key]! : fallback),
  );
}

beforeEach(() => {
  for (const key of MODEL_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  vi.mocked(getStringSetting).mockClear();
  vi.mocked(getLlmProvider).mockClear();
  stubSettings({});
  vi.mocked(getLlmProvider).mockResolvedValue('openai');
});

afterEach(() => {
  for (const key of MODEL_ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe('resolveModel — explicit tags bypass the provider row (B0-899)', () => {
  it('passes claude-sonnet-5 through as the exact Claude API id, whatever the fleet provider says', async () => {
    vi.mocked(getLlmProvider).mockResolvedValue('openai');
    expect(await resolveModel('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(modelProviderFor(await resolveModel('claude-sonnet-5'))).toBe('anthropic');
    // The provider row is not even consulted for an explicit tag.
    expect(getLlmProvider).not.toHaveBeenCalled();
  });

  it('resolves gpt-4.1 exactly as resolveResponsesModel does, env pin included', async () => {
    expect(await resolveModel('gpt-4.1')).toBe(await resolveResponsesModel('gpt-4.1'));
    expect(await resolveModel('gpt-4.1')).toBe('gpt-4.1');

    process.env.BEX_MODEL_GPT41 = 'gpt-4.1-2026-01-01';
    expect(await resolveModel('gpt-4.1')).toBe('gpt-4.1-2026-01-01');
    expect(await resolveModel('gpt-4.1')).toBe(await resolveResponsesModel('gpt-4.1'));
  });

  it('applies a BEX_MODEL_CLAUDE_* pin to an explicit Anthropic tag', async () => {
    process.env.BEX_MODEL_CLAUDE_OPUS_5 = 'claude-opus-5-20260101';
    expect(await resolveModel('claude-opus-5')).toBe('claude-opus-5-20260101');
    expect(await resolveModel('claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('resolves every selectable tag to a non-empty id under either provider', async () => {
    for (const provider of ['openai', 'anthropic'] as const) {
      vi.mocked(getLlmProvider).mockResolvedValue(provider);
      for (const tag of BEX_MODEL_TAGS) {
        expect((await resolveModel(tag)).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('resolveModel — preview under BEX_LLM_PROVIDER = openai (B0-899)', () => {
  it('is byte-identical to resolveResponsesModel("preview") for preview, empty and undefined', async () => {
    vi.mocked(getLlmProvider).mockResolvedValue('openai');

    expect(await resolveModel('preview')).toBe(await resolveResponsesModel('preview'));
    expect(await resolveModel('preview')).toBe('gpt-4.1-mini');
    expect(await resolveModel('')).toBe(await resolveResponsesModel(''));
    expect(await resolveModel(undefined)).toBe(await resolveResponsesModel(undefined));

    stubSettings({ BEX_RESPONSES_MODEL: 'gpt-4.1' });
    process.env.BEX_MODEL_GPT41 = 'gpt-4.1-pinned';
    expect(await resolveModel('preview')).toBe('gpt-4.1-pinned');
    expect(await resolveModel('preview')).toBe(await resolveResponsesModel('preview'));
  });

  it('ignores a claude value stored in BEX_RESPONSES_MODEL — that row is the OpenAI default only', async () => {
    vi.mocked(getLlmProvider).mockResolvedValue('openai');
    stubSettings({ BEX_RESPONSES_MODEL: 'claude-sonnet-5' });

    expect(await resolveGenerationModelDefaultTag()).toBe(DEFAULT_BEX_RESPONSES_MODEL_TAG);
    expect(await resolveModel('preview')).toBe('gpt-4.1-mini');
    expect(await resolveResponsesModel('preview')).toBe('gpt-4.1-mini');
    expect(modelProviderFor(await resolveModel('preview'))).toBe('openai');
  });

  it('never reads BEX_ANTHROPIC_MODEL while the provider is openai', async () => {
    vi.mocked(getLlmProvider).mockResolvedValue('openai');
    stubSettings({ [ANTHROPIC_MODEL_SETTING_KEY]: 'claude-opus-5' });

    expect(await resolveModel('preview')).toBe('gpt-4.1-mini');
    expect(vi.mocked(getStringSetting).mock.calls.map(([key]) => key)).not.toContain(
      ANTHROPIC_MODEL_SETTING_KEY,
    );
  });
});

describe('resolveModel — preview under BEX_LLM_PROVIDER = anthropic (B0-899)', () => {
  it('resolves preview to the BEX_ANTHROPIC_MODEL value', async () => {
    vi.mocked(getLlmProvider).mockResolvedValue('anthropic');
    stubSettings({ [ANTHROPIC_MODEL_SETTING_KEY]: 'claude-opus-5', BEX_RESPONSES_MODEL: 'gpt-4.1' });

    expect(await resolveModel('preview')).toBe('claude-opus-5');
    expect(await resolveModel('')).toBe('claude-opus-5');
    expect(await resolveModel(undefined)).toBe('claude-opus-5');
    expect(modelProviderFor(await resolveModel('preview'))).toBe('anthropic');
  });

  it('defaults to claude-sonnet-5 when the row is missing', async () => {
    vi.mocked(getLlmProvider).mockResolvedValue('anthropic');
    stubSettings({});

    expect(DEFAULT_BEX_ANTHROPIC_MODEL_TAG).toBe('claude-sonnet-5');
    expect(await resolveAnthropicModelDefaultTag()).toBe('claude-sonnet-5');
    expect(await resolveModel('preview')).toBe('claude-sonnet-5');
  });

  it('falls back to claude-sonnet-5 for an out-of-set stored value (allowed_values is advisory)', async () => {
    vi.mocked(getLlmProvider).mockResolvedValue('anthropic');

    for (const stored of ['claude-opus-4-5', 'gpt-4.1', 'preview', '', 'claude-sonnet-5-20260101']) {
      stubSettings({ [ANTHROPIC_MODEL_SETTING_KEY]: stored });
      expect(await resolveAnthropicModelDefaultTag()).toBe('claude-sonnet-5');
      expect(await resolveModel('preview')).toBe('claude-sonnet-5');
    }
  });

  it('accepts every Anthropic tag and rejects every OpenAI tag on the Anthropic row', async () => {
    vi.mocked(getLlmProvider).mockResolvedValue('anthropic');
    for (const tag of ANTHROPIC_MODEL_TAGS) {
      stubSettings({ [ANTHROPIC_MODEL_SETTING_KEY]: tag });
      expect(await resolveModel('preview')).toBe(tag);
    }
    for (const tag of OPENAI_MODEL_TAGS) {
      stubSettings({ [ANTHROPIC_MODEL_SETTING_KEY]: tag });
      expect(await resolveModel('preview')).toBe('claude-sonnet-5');
    }
  });

  it('sends the stored tag back through resolveResponsesModel so the BEX_MODEL_CLAUDE_* pin applies to preview too', async () => {
    vi.mocked(getLlmProvider).mockResolvedValue('anthropic');
    stubSettings({ [ANTHROPIC_MODEL_SETTING_KEY]: 'claude-sonnet-5' });
    process.env.BEX_MODEL_CLAUDE_SONNET_5 = 'claude-sonnet-5-20260101';

    expect(await resolveModel('preview')).toBe('claude-sonnet-5-20260101');
    // The OpenAI row is untouched by the pin and still never consulted.
    expect(vi.mocked(getStringSetting).mock.calls.map(([key]) => key)).not.toContain(
      'BEX_RESPONSES_MODEL',
    );
  });

  it('does not let the anthropic provider capture an explicit OpenAI tag', async () => {
    vi.mocked(getLlmProvider).mockResolvedValue('anthropic');
    stubSettings({ [ANTHROPIC_MODEL_SETTING_KEY]: 'claude-opus-5' });

    expect(await resolveModel('gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(await resolveModel('gpt-5.6')).toBe('gpt-5.6');
  });
});
