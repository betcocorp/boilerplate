import { describe, expect, it } from 'vitest';

import {
  buildLatencyByStep,
  buildTokenUsage,
  type StepScanRow,
  type TokenUsageScanRow,
} from '~/lib/observability/aggregates';

function step(overrides: Partial<StepScanRow>): StepScanRow {
  return {
    workflow_run_id: 'run-1',
    step_name: 'orchestration_planner',
    started_at: '2026-08-20T12:00:00.000Z',
    completed_at: '2026-08-20T12:00:01.000Z',
    ...overrides,
  };
}

describe('buildLatencyByStep', () => {
  it('clamps a clock-skewed negative duration at 0 and keeps the row in the sample', () => {
    // `started_at` is Postgres now(), `completed_at` is the Node clock — a fast step can
    // land completed_at BEFORE started_at. It must count as 0ms, never vanish.
    const rows = [
      step({
        started_at: '2026-08-20T12:00:00.500Z',
        completed_at: '2026-08-20T12:00:00.400Z', // 100ms "negative"
      }),
      step({
        workflow_run_id: 'run-2',
        started_at: '2026-08-20T12:00:00.000Z',
        completed_at: '2026-08-20T12:00:00.200Z',
      }),
    ];

    expect(buildLatencyByStep(rows)).toEqual([
      {
        stepName: 'orchestration_planner',
        avgDurationMs: 100, // (0 + 200) / 2 — the skewed row contributes 0, not -100
        p95DurationMs: 200,
        sampleSize: 2, // both rows kept
      },
    ]);
  });

  it('excludes steps with no completed_at from the sample without dropping other steps', () => {
    const rows = [
      step({ completed_at: null }),
      step({ step_name: 'validator', completed_at: '2026-08-20T12:00:03.000Z', started_at: '2026-08-20T12:00:00.000Z' }),
    ];

    expect(buildLatencyByStep(rows)).toEqual([
      { stepName: 'validator', avgDurationMs: 3000, p95DurationMs: 3000, sampleSize: 1 },
    ]);
  });
});

function usage(overrides: Partial<TokenUsageScanRow>): TokenUsageScanRow {
  return {
    total_tokens: null,
    prompt_tokens: null,
    cached_prompt_tokens: null,
    ...overrides,
  };
}

describe('buildTokenUsage', () => {
  it('averages totalTokens over runs that recorded usage and computes the cached share', () => {
    const rows = [
      usage({ total_tokens: '1000', prompt_tokens: '800', cached_prompt_tokens: '400' }),
      usage({ total_tokens: '3000', prompt_tokens: '1200', cached_prompt_tokens: '600' }),
    ];

    expect(buildTokenUsage(rows)).toEqual({
      avgTotalTokens: 2000,
      tokenSampleSize: 2,
      cachedPromptShare: 0.5, // (400 + 600) / (800 + 1200)
      cachedShareSampleSize: 2,
    });
  });

  it('excludes pre-B0-324 runs (usage without cachedPromptTokens) from the cache-share denominator only', () => {
    const rows = [
      // Pre-B0-324: usage exists but the cachedPromptTokens key is absent (`->>` = null).
      usage({ total_tokens: '5000', prompt_tokens: '4000', cached_prompt_tokens: null }),
      usage({ total_tokens: '1000', prompt_tokens: '1000', cached_prompt_tokens: '250' }),
    ];

    const result = buildTokenUsage(rows);
    // Both runs count toward tokens/run…
    expect(result.avgTotalTokens).toBe(3000);
    expect(result.tokenSampleSize).toBe(2);
    // …but only the instrumented run is in the cache-share denominator: 250/1000, not 250/5000.
    expect(result.cachedPromptShare).toBe(0.25);
    expect(result.cachedShareSampleSize).toBe(1);
  });

  it('treats a recorded zero cache as a real measurement, not as missing', () => {
    const rows = [usage({ total_tokens: '100', prompt_tokens: '80', cached_prompt_tokens: '0' })];

    expect(buildTokenUsage(rows)).toEqual({
      avgTotalTokens: 100,
      tokenSampleSize: 1,
      cachedPromptShare: 0,
      cachedShareSampleSize: 1,
    });
  });

  it('returns nulls (not zeros) when no run in the window recorded usage', () => {
    expect(buildTokenUsage([usage({}), usage({})])).toEqual({
      avgTotalTokens: null,
      tokenSampleSize: 0,
      cachedPromptShare: null,
      cachedShareSampleSize: 0,
    });
  });
});
