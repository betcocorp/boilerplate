import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-921 — the model resolver behind RAG query rewriting / intent decomposition. `resolveModel` is
 * mocked so the assertions are about which TAG the resolver hands it (the whole contract of this
 * module), and the settings row is mocked so the default / explicit-tag / garbage branches can each
 * be driven directly. The re-validation branch is the important one: `allowed_values` is advisory
 * metadata, not a DB constraint, so a hand-edited row must never reach a provider verbatim.
 */
const { mockResolveModel, mockGetStringSetting } = vi.hoisted(() => ({
  mockResolveModel: vi.fn(async (tag: string | undefined) => `resolved:${tag}`),
  mockGetStringSetting: vi.fn(async (_key: string, fallback: string) => fallback),
}));
vi.mock('~/lib/llm/resolve-model', () => ({
  resolveModel: mockResolveModel,
}));
vi.mock('~/lib/settings/settings-service', () => ({
  getStringSetting: mockGetStringSetting,
}));

import {
  DEFAULT_QUERY_REWRITE_MODEL_TAG,
  loadQueryRewriteModelTag,
  QUERY_REWRITE_MODEL_SETTING_KEY,
  resolveQueryRewriteModel,
} from './query-rewrite-model';

function settingsRows(rows: Record<string, string>) {
  mockGetStringSetting.mockImplementation(async (key: string, fallback: string) => rows[key] ?? fallback);
}

beforeEach(() => {
  mockResolveModel.mockClear();
  mockResolveModel.mockImplementation(async (tag: string | undefined) => `resolved:${tag}`);
  mockGetStringSetting.mockReset();
  mockGetStringSetting.mockImplementation(async (_key: string, fallback: string) => fallback);
});

describe('loadQueryRewriteModelTag', () => {
  it('reads BEX_QUERY_REWRITE_MODEL and defaults to the gpt-4.1-mini mixed-fleet pin', async () => {
    expect(QUERY_REWRITE_MODEL_SETTING_KEY).toBe('BEX_QUERY_REWRITE_MODEL');
    expect(DEFAULT_QUERY_REWRITE_MODEL_TAG).toBe('gpt-4.1-mini');
    expect(await loadQueryRewriteModelTag()).toBe('gpt-4.1-mini');
    expect(mockGetStringSetting).toHaveBeenCalledWith('BEX_QUERY_REWRITE_MODEL', 'gpt-4.1-mini');
  });

  it('returns a stored BEX_MODEL_TAGS tag, trimmed', async () => {
    settingsRows({ BEX_QUERY_REWRITE_MODEL: ' claude-haiku-4-5 ' });
    expect(await loadQueryRewriteModelTag()).toBe('claude-haiku-4-5');
    settingsRows({ BEX_QUERY_REWRITE_MODEL: 'preview' });
    expect(await loadQueryRewriteModelTag()).toBe('preview');
  });

  it('falls back to the default on an unrecognised stored value (allowed_values is advisory)', async () => {
    settingsRows({ BEX_QUERY_REWRITE_MODEL: 'gpt-4.1-nano' });
    expect(await loadQueryRewriteModelTag()).toBe('gpt-4.1-mini');
    settingsRows({ BEX_QUERY_REWRITE_MODEL: '' });
    expect(await loadQueryRewriteModelTag()).toBe('gpt-4.1-mini');
  });
});

describe('resolveQueryRewriteModel', () => {
  it('resolves the default tag through resolveModel, not process.env', async () => {
    expect(await resolveQueryRewriteModel()).toBe('resolved:gpt-4.1-mini');
    expect(mockResolveModel).toHaveBeenCalledWith('gpt-4.1-mini');
  });

  it('an admin can move both calls to Anthropic by editing the row', async () => {
    settingsRows({ BEX_QUERY_REWRITE_MODEL: 'claude-haiku-4-5' });
    expect(await resolveQueryRewriteModel()).toBe('resolved:claude-haiku-4-5');
    expect(mockResolveModel).toHaveBeenCalledWith('claude-haiku-4-5');
  });

  it('preview hands the fleet default through to resolveModel', async () => {
    settingsRows({ BEX_QUERY_REWRITE_MODEL: 'preview' });
    expect(await resolveQueryRewriteModel()).toBe('resolved:preview');
    expect(mockResolveModel).toHaveBeenCalledWith('preview');
  });
});
