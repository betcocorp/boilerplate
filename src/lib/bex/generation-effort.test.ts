import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-913 — the generation-effort settings resolver. The settings row is mocked so each branch of
 * the sentinel / explicit-level / garbage logic can be driven directly, matching
 * `item-grading-model.test.ts`.
 */
const { mockGetStringSetting } = vi.hoisted(() => ({
  mockGetStringSetting: vi.fn(async (_key: string, fallback: string) => fallback),
}));
vi.mock('~/lib/settings/settings-service', () => ({
  getStringSetting: mockGetStringSetting,
}));

import {
  DEFAULT_GENERATION_EFFORT_SETTING,
  GENERATION_EFFORT_PROVIDER_DEFAULT,
  GENERATION_EFFORT_SETTING_KEY,
  loadGenerationEffort,
  loadGenerationEffortSetting,
} from './generation-effort';

function settingsRows(rows: Record<string, string>) {
  mockGetStringSetting.mockImplementation(async (key: string, fallback: string) => rows[key] ?? fallback);
}

beforeEach(() => {
  mockGetStringSetting.mockReset();
  mockGetStringSetting.mockImplementation(async (_key: string, fallback: string) => fallback);
});

describe('constants', () => {
  it('uses the BEX_GENERATION_EFFORT key and defaults to the provider_default sentinel', () => {
    expect(GENERATION_EFFORT_SETTING_KEY).toBe('BEX_GENERATION_EFFORT');
    expect(GENERATION_EFFORT_PROVIDER_DEFAULT).toBe('provider_default');
    expect(DEFAULT_GENERATION_EFFORT_SETTING).toBe('provider_default');
  });
});

describe('loadGenerationEffortSetting', () => {
  it('returns the sentinel when the row is missing', async () => {
    expect(await loadGenerationEffortSetting()).toBe('provider_default');
    expect(mockGetStringSetting).toHaveBeenCalledWith('BEX_GENERATION_EFFORT', 'provider_default');
  });

  it('returns every MODEL_EFFORTS level stored in the row', async () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      settingsRows({ BEX_GENERATION_EFFORT: effort });
      expect(await loadGenerationEffortSetting()).toBe(effort);
    }
  });

  it('trims and lowercases the stored value', async () => {
    settingsRows({ BEX_GENERATION_EFFORT: '  XHigh  ' });
    expect(await loadGenerationEffortSetting()).toBe('xhigh');
    settingsRows({ BEX_GENERATION_EFFORT: ' PROVIDER_DEFAULT ' });
    expect(await loadGenerationEffortSetting()).toBe('provider_default');
  });

  it('falls back to the sentinel on an unrecognised stored value (allowed_values is advisory)', async () => {
    for (const stored of ['ultra', 'none', 'off', '0', '', '   ']) {
      settingsRows({ BEX_GENERATION_EFFORT: stored });
      expect(await loadGenerationEffortSetting()).toBe('provider_default');
    }
  });
});

describe('loadGenerationEffort', () => {
  /**
   * The behaviour-preserving default: the sentinel resolves to `undefined`, which the runtime
   * spreads to nothing, so the request body carries no `output_config` at all — byte-identical to
   * the pre-B0-913 shape.
   */
  it('resolves the sentinel to undefined so no effort field is sent', async () => {
    expect(await loadGenerationEffort()).toBeUndefined();
  });

  it('resolves an explicit level to that level', async () => {
    settingsRows({ BEX_GENERATION_EFFORT: 'low' });
    expect(await loadGenerationEffort()).toBe('low');
    settingsRows({ BEX_GENERATION_EFFORT: 'max' });
    expect(await loadGenerationEffort()).toBe('max');
  });

  it('resolves garbage to undefined rather than passing it to the provider', async () => {
    settingsRows({ BEX_GENERATION_EFFORT: 'extreme' });
    expect(await loadGenerationEffort()).toBeUndefined();
  });
});
