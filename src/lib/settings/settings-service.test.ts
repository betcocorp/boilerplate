import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
    expect(await getStringSetting('WEBSEARCH_PROVIDER', 'mock')).toBe('tavily');
    resetSettingsCacheForTest();
    mockRow(null);
    expect(await getStringSetting('WEBSEARCH_PROVIDER', 'mock')).toBe('mock');
  });
});

describe('getNumberSetting', () => {
  it('parses a numeric string', async () => {
    mockRow('1500');
    expect(await getNumberSetting('XREF_RECOMMENDATION_TIMEOUT_MS', 20_000)).toBe(1500);
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

/**
 * B0-638 — every one of these `settings` rows used to be a `process.env.<KEY>` read. Guards
 * against a future edit silently reverting one back to reading the env var instead of this
 * module, by scanning the source tree (excluding this module and test files) for the literal
 * pattern. Add a key here whenever a new row is wired to `getBooleanSetting`/`getStringSetting`/
 * `getNumberSetting`.
 */
describe('settings-table coverage does not regress to process.env (B0-638)', () => {
  const DB_BACKED_KEYS = [
    'BEX_AI_SDK_GENERATION_ENABLED',
    'BEX_AI_SDK_STREAMING_ENABLED',
    'BEX_AI_SDK_STREAMING_ROLLOUT_MODE',
    'BEX_DISABLE_CONFIDENCE_GATING',
    'BEX_LLM_ROUTER_ENABLED',
    'BEX_LLM_ROUTER_SHADOW_MODE',
    'BEX_PERMISSIONS_ENFORCED',
    'COHERE_RERANK_MODEL',
    'ENABLE_RERANKER',
    'NEXT_PUBLIC_BEX_AI_ELEMENTS_UI',
    'NEXT_PUBLIC_BEX_STREAMING_ROLLOUT_COHORT',
    'WEBSEARCH_DB_CACHE_ENABLED',
    'WEBSEARCH_PROVIDER',
    'XREF_RECOMMENDATION_TIMEOUT_MS',
  ];

  // Not wired to any behavior in code as of B0-638 — the settings-table row exists but nothing
  // reads it, so there is no `process.env.<KEY>` read to guard against regressing to. Remove from
  // this list (and add to DB_BACKED_KEYS above) once/if a ticket wires one of these up for real.
  const ORPHANED_KEYS = ['BEX_AI_SDK_ROUNDTRIPS_ENABLED', 'NEXT_PUBLIC_BEX_STREAMING_UI_ENABLED'];

  const SRC_ROOT = join(__dirname, '..', '..');
  const SKIP_DIRS = new Set(['node_modules', '.next']);

  function collectSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        collectSourceFiles(full, out);
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  it('lists every settings-table key exactly once, covered or orphaned', () => {
    // Sanity check on the guard's own bookkeeping, not the source tree.
    const overlap = DB_BACKED_KEYS.filter((k) => ORPHANED_KEYS.includes(k));
    expect(overlap).toEqual([]);
  });

  it('has no process.env.<KEY> reads left for any DB-backed settings-table key', () => {
    const files = collectSourceFiles(SRC_ROOT).filter(
      (f) => !f.endsWith(`${join('settings', 'settings-service.ts')}`),
    );
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const key of DB_BACKED_KEYS) {
        if (content.includes(`process.env.${key}`)) {
          offenders.push(`${file}: process.env.${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
