import { beforeEach, describe, expect, it, vi } from 'vitest';

const from = vi.fn();
vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => ({ from }),
}));

import {
  getBooleanSetting,
  getNumberSetting,
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

describe('resolveSettingValue ', () => {
  it('prefers the stored value, then default_value, then null', () => {
    expect(resolveSettingValue({ value: 'true', default_value: 'false' })).toBe('true');
    expect(resolveSettingValue({ value: null, default_value: 'false' })).toBe('false');
    expect(resolveSettingValue({ value: null, default_value: null })).toBeNull();
    expect(resolveSettingValue({ value: null })).toBeNull();
    expect(resolveSettingValue(null)).toBeNull();
  });

  it('lets a row with a null value fall back to default_value before the caller fallback', async () => {
    const maybeSingle = vi
      .fn()
      .mockResolvedValue({ data: { value: null, default_value: 'false' }, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    from.mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) });
    // default_value 'false' wins over the caller's `true`.
    await expect(getBooleanSetting('FEATURE_FLAG', true)).resolves.toBe(false);
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
    mockRow('tavily');
    expect(await getStringSetting('PROVIDER', 'mock')).toBe('tavily');
    resetSettingsCacheForTest();
    mockRow(null);
    expect(await getStringSetting('PROVIDER', 'mock')).toBe('mock');
  });
});

describe('getNumberSetting', () => {
  it('parses a numeric string', async () => {
    mockRow('1500');
    expect(await getNumberSetting('TIMEOUT_MS', 20_000)).toBe(1500);
  });

  it('falls back on a missing or non-numeric value', async () => {
    mockRow('not-a-number');
    expect(await getNumberSetting('K', 20_000)).toBe(20_000);
    resetSettingsCacheForTest();
    mockRow(null);
    expect(await getNumberSetting('K', 20_000)).toBe(20_000);
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
