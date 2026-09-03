import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const from = vi.fn();
vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => ({ from }),
}));

import {
  DEFAULT_HIGH_CONFIDENCE_ABSOLUTE,
  DEFAULT_MIN_LOCK_MARGIN,
  DEFAULT_MIN_LOCK_SIMILARITY,
} from '~/lib/retrieval/product-line-resolution';
import {
  DEFAULT_RAG_CHUNK_STRATEGY,
  DEFAULT_ROUTER_TYPE,
  getBooleanSetting,
  getNumberSetting,
  getProductLineLockThresholds,
  getRagBoostConfig,
  getRagBoostWeights,
  getRagChunkingConfig,
  getRagChunkStrategy,
  getRouterType,
  getStringSetting,
  resetSettingsCacheForTest,
} from '~/lib/settings/settings-service';

function mockRow(value: string | null, error: { message: string } | null = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: value === null ? null : { value }, error });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  from.mockReturnValue({ select });
}

/** Per-key mock: keys absent from `values` behave as a missing row. */
function mockRows(values: Record<string, string>) {
  const select = vi.fn().mockReturnValue({
    eq: vi.fn((_col: string, key: string) => ({
      maybeSingle: vi.fn().mockResolvedValue({
        data: key in values ? { value: values[key] } : null,
        error: null,
      }),
    })),
  });
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

describe('getProductLineLockThresholds (B0-757)', () => {
  it('returns the DEFAULT_* fallbacks when no rows exist', async () => {
    mockRows({});
    expect(await getProductLineLockThresholds()).toEqual({
      minLockSimilarity: DEFAULT_MIN_LOCK_SIMILARITY,
      minLockMargin: DEFAULT_MIN_LOCK_MARGIN,
      highConfidenceAbsolute: DEFAULT_HIGH_CONFIDENCE_ABSOLUTE,
    });
  });

  it('returns stored values', async () => {
    mockRows({
      BEX_PRODUCT_LINE_LOCK_MIN_SIMILARITY: '0.55',
      BEX_PRODUCT_LINE_LOCK_MARGIN: '0.1',
      BEX_PRODUCT_LINE_LOCK_HIGH_CONFIDENCE: '0.7',
    });
    expect(await getProductLineLockThresholds()).toEqual({
      minLockSimilarity: 0.55,
      minLockMargin: 0.1,
      highConfidenceAbsolute: 0.7,
    });
  });
});

describe('getRouterType (B0-656)', () => {
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

  it('coerces an unrecognized stored value back to keyword (allowed_values is not a DB constraint)', async () => {
    for (const stored of ['llm', 'hybrid', '', 'true']) {
      resetSettingsCacheForTest();
      mockRow(stored);
      expect(await getRouterType(), stored).toBe('keyword');
    }
  });

  it('falls back to keyword when the row is missing or the query errors', async () => {
    mockRow(null);
    expect(await getRouterType()).toBe(DEFAULT_ROUTER_TYPE);
    resetSettingsCacheForTest();
    mockRow(null, { message: 'db down' });
    await expect(getRouterType()).resolves.toBe('keyword');
  });
});

describe('getRagChunkStrategy (B0-686)', () => {
  it('returns each allowed strategy as stored, normalizing case and whitespace', async () => {
    mockRow('heading-aware');
    expect(await getRagChunkStrategy()).toBe('heading-aware');
    resetSettingsCacheForTest();
    mockRow('  NAIVE ');
    expect(await getRagChunkStrategy()).toBe('naive');
  });

  it('coerces an unrecognized stored value back to naive (allowed_values is not a DB constraint)', async () => {
    for (const stored of ['semantic', 'heading', '', 'true']) {
      resetSettingsCacheForTest();
      mockRow(stored);
      expect(await getRagChunkStrategy(), stored).toBe('naive');
    }
  });

  it('falls back to naive when the row is missing or the query errors', async () => {
    mockRow(null);
    expect(await getRagChunkStrategy()).toBe(DEFAULT_RAG_CHUNK_STRATEGY);
    resetSettingsCacheForTest();
    mockRow(null, { message: 'db down' });
    await expect(getRagChunkStrategy()).resolves.toBe('naive');
  });
});

describe('getRagChunkingConfig (B0-686)', () => {
  it('returns the inert defaults when no rows exist', async () => {
    mockRows({});
    expect(await getRagChunkingConfig()).toEqual({
      strategy: 'naive',
      minTokens: 300,
      maxTokens: 600,
      overlapTokens: 50,
    });
  });

  it('returns stored values', async () => {
    mockRows({
      RAG_CHUNK_STRATEGY: 'heading-aware',
      RAG_CHUNK_MIN_TOKENS: '250',
      RAG_CHUNK_MAX_TOKENS: '800',
      RAG_CHUNK_OVERLAP_TOKENS: '75',
    });
    expect(await getRagChunkingConfig()).toEqual({
      strategy: 'heading-aware',
      minTokens: 250,
      maxTokens: 800,
      overlapTokens: 75,
    });
  });

  it('clamps out-of-range stored values to the admin form bounds', async () => {
    mockRows({
      RAG_CHUNK_MIN_TOKENS: '5',
      RAG_CHUNK_MAX_TOKENS: '99999',
      RAG_CHUNK_OVERLAP_TOKENS: '-40',
    });
    expect(await getRagChunkingConfig()).toEqual({
      strategy: 'naive',
      minTokens: 50,
      maxTokens: 2000,
      overlapTokens: 0,
    });
  });

  it('never reports min > max, even when the stored rows say so', async () => {
    mockRows({ RAG_CHUNK_MIN_TOKENS: '600', RAG_CHUNK_MAX_TOKENS: '100' });
    const config = await getRagChunkingConfig();
    expect(config.minTokens).toBe(600);
    expect(config.maxTokens).toBe(600);
  });

  it('falls back per key on a non-numeric stored value', async () => {
    mockRows({ RAG_CHUNK_MIN_TOKENS: 'lots', RAG_CHUNK_MAX_TOKENS: '700' });
    expect(await getRagChunkingConfig()).toEqual({
      strategy: 'naive',
      minTokens: 300,
      maxTokens: 700,
      overlapTokens: 50,
    });
  });
});

describe('getRagBoostConfig (B0-686)', () => {
  it('reports every weight as 0 when the feature is disabled, so callers need no second branch', async () => {
    mockRows({
      RAG_BOOST_ENABLED: 'false',
      RAG_BOOST_SURFACE_TYPE: '0.30',
      RAG_BOOST_DWELL_TIME: '0.20',
      RAG_BOOST_DILUTION_RATIO: '0.10',
    });
    expect(await getRagBoostConfig()).toEqual({
      enabled: false,
      surfaceType: 0,
      dwellTime: 0,
      dilutionRatio: 0,
    });
  });

  it('defaults to disabled when no rows exist', async () => {
    mockRows({});
    expect(await getRagBoostConfig()).toEqual({
      enabled: false,
      surfaceType: 0,
      dwellTime: 0,
      dilutionRatio: 0,
    });
  });

  it('returns the stored weights once enabled', async () => {
    mockRows({
      RAG_BOOST_ENABLED: 'true',
      RAG_BOOST_SURFACE_TYPE: '0.12',
      RAG_BOOST_DWELL_TIME: '0.03',
      RAG_BOOST_DILUTION_RATIO: '0.07',
    });
    expect(await getRagBoostConfig()).toEqual({
      enabled: true,
      surfaceType: 0.12,
      dwellTime: 0.03,
      dilutionRatio: 0.07,
    });
  });

  it('clamps an out-of-range weight and falls back on a non-numeric one', async () => {
    mockRows({
      RAG_BOOST_ENABLED: 'true',
      RAG_BOOST_SURFACE_TYPE: '9',
      RAG_BOOST_DWELL_TIME: '-1',
      RAG_BOOST_DILUTION_RATIO: 'heavy',
    });
    expect(await getRagBoostConfig()).toEqual({
      enabled: true,
      surfaceType: 0.5,
      dwellTime: 0,
      dilutionRatio: 0.05,
    });
  });
});

describe('getRagBoostWeights (B0-686)', () => {
  it('reports the stored weights even while boosting is disabled, for the admin form to seed from', async () => {
    mockRows({
      RAG_BOOST_ENABLED: 'false',
      RAG_BOOST_SURFACE_TYPE: '0.12',
      RAG_BOOST_DWELL_TIME: '0.03',
      RAG_BOOST_DILUTION_RATIO: '0.07',
    });
    expect(await getRagBoostWeights()).toEqual({
      surfaceType: 0.12,
      dwellTime: 0.03,
      dilutionRatio: 0.07,
    });
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
    // B0-466 — read through getObservabilityAlertConfig(); the alerter's thresholds have never
    // had a process.env read. (The optional webhook URL is env-only ON PURPOSE — it is a
    // credential — and is deliberately not a settings key, so it is not listed here.)
    'ALERT_GOLDEN_GATE_MISS_ENABLED',
    'ALERT_GOLDEN_MIN_GRADED_ITEMS',
    'ALERT_GOLDEN_PASS_RATE_DROP_CRITICAL',
    'ALERT_GOLDEN_PASS_RATE_DROP_WARNING',
    'ALERT_SENTRY_ENABLED',
    'ALERT_TOOL_FAILURE_LOOKBACK_DAYS',
    'ALERT_TOOL_FAILURE_MIN_SETTLED_CALLS',
    'ALERT_TOOL_FAILURE_RATE_CRITICAL',
    'ALERT_TOOL_FAILURE_RATE_WARNING',
    'ALERT_TOOL_FAILURE_SPIKE_DELTA',
    'ALERT_TOOL_FAILURE_SPIKE_RATIO',
    // B0-378 — permanent selector between the Responses and AI SDK generation loops. Deliberately
    // NOT retired by B0-68, which removed only the transitional streaming/Elements rollout gates.
    'BEX_AI_SDK_GENERATION_ENABLED',
    'BEX_DISABLE_CONFIDENCE_GATING',
    // B0-734 — the early-decline gate switch, moved off process.env; defaults to false.
    'BEX_EARLY_DECLINE_GATE_ENABLED',
    'BEX_LLM_ROUTER_ENABLED',
    'BEX_LLM_ROUTER_SHADOW_MODE',
    'BEX_PERMISSIONS_ENFORCED',
    // B0-757 — read through resolveProductLineFromMatches' callers via
    // getProductLineLockThresholds(); none of these three was ever actually set as an env var.
    'BEX_PRODUCT_LINE_LOCK_MIN_SIMILARITY',
    'BEX_PRODUCT_LINE_LOCK_MARGIN',
    'BEX_PRODUCT_LINE_LOCK_HIGH_CONFIDENCE',
    // B0-757 — read through resolveGenerationModelDefaultTag() (~/lib/openai/client.ts);
    // BEX_RESPONSES_MODEL/OPENAI_BEX_MODEL were never actually set as env vars anywhere, so moving
    // this here is behavior-preserving, not a model change.
    'BEX_RESPONSES_MODEL',
    // B0-603 — read through resolveValidatorModelTag(); BEX_VALIDATOR_MODEL was never actually
    // set as an env var anywhere, so moving it here is behavior-preserving, not a model change.
    'BEX_VALIDATOR_MODEL',
    'COHERE_RERANK_MODEL',
    'ENABLE_RERANKER',
    // B0-686 — read through getRagBoostConfig()/getRagChunkingConfig(); these rows replaced a
    // clipboard "paste this into a migration" panel, never a process.env read.
    'RAG_BOOST_DILUTION_RATIO',
    'RAG_BOOST_DWELL_TIME',
    'RAG_BOOST_ENABLED',
    'RAG_BOOST_SURFACE_TYPE',
    'RAG_CHUNK_MAX_TOKENS',
    'RAG_CHUNK_MIN_TOKENS',
    'RAG_CHUNK_OVERLAP_TOKENS',
    'RAG_CHUNK_STRATEGY',
    // B0-719/B0-720 — read through loadConsistencyConfig(); multi-pass report grading has never
    // had a process.env read, and per the config rule it never will.
    'REPORT_CONSISTENCY_SPREAD_THRESHOLD',
    'REPORT_GRADING_PASSES',
    // B0-656 — read through getRouterType(); no process.env.ROUTER_TYPE read has ever existed.
    'ROUTER_TYPE',
    'WEBSEARCH_DB_CACHE_ENABLED',
    'WEBSEARCH_PROVIDER',
    'XREF_RECOMMENDATION_TIMEOUT_MS',
  ];

  // Not wired to any behavior in code — the settings-table row exists but nothing reads it, so
  // there is no `process.env.<KEY>` read to guard against regressing to. Add a key here (and drop
  // it from DB_BACKED_KEYS) only for a row that is deliberately kept unread; B0-68 instead DELETED
  // the two rows that used to sit here (`BEX_AI_SDK_ROUNDTRIPS_ENABLED`,
  // `NEXT_PUBLIC_BEX_STREAMING_UI_ENABLED`) along with the streaming/Elements rollout gates,
  // rather than leaving stale config nothing reads.
  const ORPHANED_KEYS: string[] = [];

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
