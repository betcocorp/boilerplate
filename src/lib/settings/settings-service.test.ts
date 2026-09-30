import { beforeEach, describe, expect, it, vi } from 'vitest';

const from = vi.fn();
vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => ({ from }),
}));

import {
  DEFAULT_LLM_PROVIDER,
  DEFAULT_ROUTER_TYPE,
  getBooleanSetting,
  getLlmProvider,
  getNumberSetting,
  getRouterType,
  getStringSetting,
  resetSettingsCacheForTest,
  resolveSettingValue,
} from '~/lib/settings/settings-service';

function mockRow(value: string | null, error: { message: string } | null = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: value === null ? null : { value }, error });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  from.mockReturnValue({ select });
}

beforeEach(() => {
  resetSettingsCacheForTest();
  from.mockReset();
});

describe('resolveSettingValue', () => {
  it('prefers the stored value, then default_value, then null', () => {
    expect(resolveSettingValue({ value: 'true', default_value: 'false' })).toBe('true');
    expect(resolveSettingValue({ value: null, default_value: 'false' })).toBe('false');
    expect(resolveSettingValue({ value: null, default_value: null })).toBeNull();
    expect(resolveSettingValue({ value: null })).toBeNull();
    expect(resolveSettingValue(null)).toBeNull();
  });
});

describe('getBooleanSetting', () => {
  it('resolves true only for the exact stored string "true" (case-insensitive)', async () => {
    mockRow('true');
    expect(await getBooleanSetting('K', false)).toBe(true);
  });

  it('resolves false for anything else, including "1"/"yes"', async () => {
    for (const stored of ['false', '1', 'yes', '']) {
      resetSettingsCacheForTest();
      mockRow(stored);
      expect(await getBooleanSetting('K', true), stored).toBe(false);
    }
  });

  it('falls back when the row is missing', async () => {
    mockRow(null);
    expect(await getBooleanSetting('K', true)).toBe(true);
    resetSettingsCacheForTest();
    mockRow(null);
    expect(await getBooleanSetting('K', false)).toBe(false);
  });

  it('falls back rather than throwing when the query errors', async () => {
    mockRow(null, { message: 'db down' });
    await expect(getBooleanSetting('K', true)).resolves.toBe(true);
  });
});

describe('getStringSetting', () => {
  it('returns the stored value, or the fallback when missing', async () => {
    mockRow('custom');
    expect(await getStringSetting('K', 'default')).toBe('custom');
    resetSettingsCacheForTest();
    mockRow(null);
    expect(await getStringSetting('K', 'default')).toBe('default');
  });
});

describe('getNumberSetting', () => {
  it('parses a numeric string', async () => {
    mockRow('1500');
    expect(await getNumberSetting('K', 20_000)).toBe(1500);
  });

  it('falls back on a missing or non-numeric value', async () => {
    mockRow('not-a-number');
    expect(await getNumberSetting('K', 20_000)).toBe(20_000);
    resetSettingsCacheForTest();
    mockRow(null);
    expect(await getNumberSetting('K', 20_000)).toBe(20_000);
  });
});

describe('getRouterType', () => {
  it('returns each allowed router type as stored', async () => {
    mockRow('keyword');
    expect(await getRouterType()).toBe('keyword');
    resetSettingsCacheForTest();
    mockRow('semantic');
    expect(await getRouterType()).toBe('semantic');
  });

  it('normalizes surrounding whitespace and casing', async () => {
    mockRow('  SEMANTIC ');
    expect(await getRouterType()).toBe('semantic');
  });

  it('coerces an unrecognized stored value back to the default (allowed_values is not a DB constraint)', async () => {
    for (const stored of ['llm', 'hybrid', '', 'true']) {
      resetSettingsCacheForTest();
      mockRow(stored);
      expect(await getRouterType(), stored).toBe(DEFAULT_ROUTER_TYPE);
    }
  });

  it('falls back to the default when the row is missing or the query errors', async () => {
    mockRow(null);
    expect(await getRouterType()).toBe(DEFAULT_ROUTER_TYPE);
    resetSettingsCacheForTest();
    mockRow(null, { message: 'db down' });
    await expect(getRouterType()).resolves.toBe(DEFAULT_ROUTER_TYPE);
  });
});

describe('getLlmProvider', () => {
  it('returns each allowed provider as stored', async () => {
    mockRow('openai');
    expect(await getLlmProvider()).toBe('openai');
    resetSettingsCacheForTest();
    mockRow('anthropic');
    expect(await getLlmProvider()).toBe('anthropic');
  });

  it('normalizes surrounding whitespace and casing', async () => {
    mockRow('  Anthropic ');
    expect(await getLlmProvider()).toBe('anthropic');
  });

  it('coerces an unrecognized stored value back to the default (allowed_values is not a DB constraint)', async () => {
    for (const stored of ['claude', 'azure', 'gemini', '', 'true']) {
      resetSettingsCacheForTest();
      mockRow(stored);
      expect(await getLlmProvider(), stored).toBe(DEFAULT_LLM_PROVIDER);
    }
  });

  it('falls back to the default when the row is missing or the query errors', async () => {
    mockRow(null);
    expect(await getLlmProvider()).toBe(DEFAULT_LLM_PROVIDER);
    resetSettingsCacheForTest();
    mockRow(null, { message: 'db down' });
    await expect(getLlmProvider()).resolves.toBe(DEFAULT_LLM_PROVIDER);
  });
});

describe('caching', () => {
  it('serves a second call to the same key from cache, without re-querying', async () => {
    mockRow('true');
    expect(await getBooleanSetting('K', false)).toBe(true);
    from.mockReset();
    // No mock configured this time — a re-query would return `false` (the fallback), so a
    // passing `true` here proves the cached value served the second call.
    expect(await getBooleanSetting('K', false)).toBe(true);
  });
});
