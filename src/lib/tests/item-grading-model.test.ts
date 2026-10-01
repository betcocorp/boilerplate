import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-902 — the shared model resolver for the three per-item graders. `resolveModel` is mocked so
 * the assertions are about which TAG the resolver hands it (that is the whole contract of this
 * module); the settings row is mocked so each branch of the `run` / explicit-tag / garbage logic
 * can be driven directly.
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
  DEFAULT_ITEM_GRADING_EFFORT,
  DEFAULT_ITEM_GRADING_MODEL_SETTING,
  ITEM_GRADING_EFFORT_SETTING_KEY,
  ITEM_GRADING_FOLLOW_RUN,
  ITEM_GRADING_MODEL_SETTING_KEY,
  loadItemGradingEffort,
  loadItemGradingModelSetting,
  resolveItemGradingConfig,
  resolveItemGradingModel,
} from './item-grading-model';

function settingsRows(rows: Record<string, string>) {
  mockGetStringSetting.mockImplementation(async (key: string, fallback: string) => rows[key] ?? fallback);
}

beforeEach(() => {
  mockResolveModel.mockClear();
  mockGetStringSetting.mockReset();
  mockGetStringSetting.mockImplementation(async (_key: string, fallback: string) => fallback);
});

describe('constants', () => {
  it('uses the TEST_ITEM_GRADING_* keys and defaults to run / high', () => {
    expect(ITEM_GRADING_MODEL_SETTING_KEY).toBe('TEST_ITEM_GRADING_MODEL');
    expect(ITEM_GRADING_EFFORT_SETTING_KEY).toBe('TEST_ITEM_GRADING_EFFORT');
    expect(ITEM_GRADING_FOLLOW_RUN).toBe('run');
    expect(DEFAULT_ITEM_GRADING_MODEL_SETTING).toBe('run');
    expect(DEFAULT_ITEM_GRADING_EFFORT).toBe('high');
  });
});

describe('loadItemGradingModelSetting', () => {
  it('returns run when the row is missing', async () => {
    expect(await loadItemGradingModelSetting()).toBe('run');
    expect(mockGetStringSetting).toHaveBeenCalledWith('TEST_ITEM_GRADING_MODEL', 'run');
  });

  it('returns a stored BEX_MODEL_TAGS tag, trimmed', async () => {
    settingsRows({ TEST_ITEM_GRADING_MODEL: ' claude-sonnet-5 ' });
    expect(await loadItemGradingModelSetting()).toBe('claude-sonnet-5');
    settingsRows({ TEST_ITEM_GRADING_MODEL: 'preview' });
    expect(await loadItemGradingModelSetting()).toBe('preview');
  });

  it('falls back to run on an unrecognised stored value (allowed_values is advisory)', async () => {
    settingsRows({ TEST_ITEM_GRADING_MODEL: 'gpt-9000' });
    expect(await loadItemGradingModelSetting()).toBe('run');
    settingsRows({ TEST_ITEM_GRADING_MODEL: '' });
    expect(await loadItemGradingModelSetting()).toBe('run');
  });
});

describe('resolveItemGradingModel', () => {
  it("run (default) follows the run's own model tag — the pre-B0-902 behaviour", async () => {
    expect(await resolveItemGradingModel('gpt-4.1')).toBe('resolved:gpt-4.1');
    expect(mockResolveModel).toHaveBeenCalledWith('gpt-4.1');
  });

  it('run with no run tag resolves preview', async () => {
    expect(await resolveItemGradingModel(undefined)).toBe('resolved:preview');
    expect(mockResolveModel).toHaveBeenCalledWith('preview');
  });

  it('an explicit tag on the row wins over the run tag', async () => {
    settingsRows({ TEST_ITEM_GRADING_MODEL: 'claude-sonnet-5' });
    expect(await resolveItemGradingModel('gpt-4.1')).toBe('resolved:claude-sonnet-5');
    expect(mockResolveModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(mockResolveModel).not.toHaveBeenCalledWith('gpt-4.1');
  });

  it('an unrecognised row value behaves as run', async () => {
    settingsRows({ TEST_ITEM_GRADING_MODEL: 'not-a-model' });
    expect(await resolveItemGradingModel('gpt-5.6')).toBe('resolved:gpt-5.6');
    expect(mockResolveModel).toHaveBeenCalledWith('gpt-5.6');
  });
});

describe('loadItemGradingEffort', () => {
  it('defaults to high', async () => {
    expect(await loadItemGradingEffort()).toBe('high');
    expect(mockGetStringSetting).toHaveBeenCalledWith('TEST_ITEM_GRADING_EFFORT', 'high');
  });

  it('reads the row, normalising case and whitespace', async () => {
    settingsRows({ TEST_ITEM_GRADING_EFFORT: ' XHIGH ' });
    expect(await loadItemGradingEffort()).toBe('xhigh');
  });

  it('rejects an unrecognised stored value', async () => {
    settingsRows({ TEST_ITEM_GRADING_EFFORT: 'turbo' });
    expect(await loadItemGradingEffort()).toBe('high');
  });
});

describe('resolveItemGradingConfig', () => {
  it('carries the effort only for an Anthropic model', async () => {
    mockResolveModel.mockImplementation(async (tag) => tag ?? 'preview');
    settingsRows({ TEST_ITEM_GRADING_MODEL: 'claude-opus-5', TEST_ITEM_GRADING_EFFORT: 'max' });
    expect(await resolveItemGradingConfig('gpt-4.1')).toEqual({
      model: 'claude-opus-5',
      provider: 'anthropic',
      effort: 'max',
    });
  });

  it('drops the effort for an OpenAI model (it would have no effect and must not be recorded)', async () => {
    mockResolveModel.mockImplementation(async (tag) => tag ?? 'preview');
    settingsRows({ TEST_ITEM_GRADING_EFFORT: 'max' });
    expect(await resolveItemGradingConfig('gpt-4.1')).toEqual({
      model: 'gpt-4.1',
      provider: 'openai',
      effort: undefined,
    });
  });

  it('routes on the RESOLVED id, so a pinned Claude snapshot still counts as Anthropic', async () => {
    mockResolveModel.mockResolvedValue('claude-sonnet-5-20260601');
    settingsRows({ TEST_ITEM_GRADING_MODEL: 'claude-sonnet-5' });
    expect(await resolveItemGradingConfig()).toMatchObject({ provider: 'anthropic', effort: 'high' });
  });
});
