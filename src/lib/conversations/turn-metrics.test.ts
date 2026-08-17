import { describe, expect, it } from 'vitest';

import {
  clampedDurationMs,
  classifyPauseTier,
  PAUSE_TIER_BOUNDARIES_MS,
  PAUSE_TIER_ORDER,
  readPauseTier,
} from '~/lib/conversations/turn-metrics';

/**
 * B0-531 — the classifier mirrors the `pause_tier` stored generated column
 * (migration 20260817120000). Every boundary is asserted on both sides so a drifted constant
 * fails loudly here rather than silently disagreeing with what Postgres stamps.
 */
describe('classifyPauseTier', () => {
  it('classifies each tier at and around its boundaries', () => {
    expect(classifyPauseTier(0)).toBe('instant');
    expect(classifyPauseTier(4_999)).toBe('instant');
    expect(classifyPauseTier(5_000)).toBe('short');
    expect(classifyPauseTier(29_999)).toBe('short');
    expect(classifyPauseTier(30_000)).toBe('medium');
    expect(classifyPauseTier(299_999)).toBe('medium');
    expect(classifyPauseTier(300_000)).toBe('long');
    expect(classifyPauseTier(3_599_999)).toBe('long');
    expect(classifyPauseTier(3_600_000)).toBe('abandoned');
    expect(classifyPauseTier(86_400_000)).toBe('abandoned');
  });

  it('treats a negative (clock-skewed) duration as instant, never an error', () => {
    expect(classifyPauseTier(-1)).toBe('instant');
    expect(classifyPauseTier(-100)).toBe('instant');
  });

  it('boundary constants match the documented values', () => {
    // These are also baked into the pause_tier generated column — change both together.
    expect(PAUSE_TIER_BOUNDARIES_MS).toEqual({
      instant: 5_000,
      short: 30_000,
      medium: 300_000,
      long: 3_600_000,
    });
    expect(PAUSE_TIER_ORDER).toEqual(['instant', 'short', 'medium', 'long', 'abandoned']);
  });
});

describe('readPauseTier', () => {
  it('accepts every stored tier value', () => {
    for (const tier of PAUSE_TIER_ORDER) {
      expect(readPauseTier(tier)).toBe(tier);
    }
  });

  it('returns null for pre-instrumentation rows and unknown text', () => {
    expect(readPauseTier(null)).toBeNull();
    expect(readPauseTier('')).toBeNull();
    expect(readPauseTier('INSTANT')).toBeNull();
    expect(readPauseTier('forever')).toBeNull();
  });
});

/**
 * B0-532 — the duration computation. The clamp exists because of the known cross-clock
 * precedent: `workflow_steps.started_at` is Postgres `now()` while `completed_at` is the Node
 * clock, so fast spans can come out negative. Clamped to 0, never dropped.
 */
describe('clampedDurationMs', () => {
  it('computes a forward span', () => {
    expect(
      clampedDurationMs('2026-08-17T12:00:00.000Z', '2026-08-17T12:00:07.250Z'),
    ).toBe(7_250);
  });

  it('returns 0 for an identical timestamp (same-millisecond turn)', () => {
    expect(
      clampedDurationMs('2026-08-17T12:00:00.000Z', '2026-08-17T12:00:00.000Z'),
    ).toBe(0);
  });

  it('clamps a negative (skewed) span to 0 instead of dropping it', () => {
    expect(
      clampedDurationMs('2026-08-17T12:00:00.150Z', '2026-08-17T12:00:00.000Z'),
    ).toBe(0);
  });

  it('returns null (unknown), not 0, when a timestamp is unparseable', () => {
    expect(clampedDurationMs('not-a-date', '2026-08-17T12:00:00.000Z')).toBeNull();
    expect(clampedDurationMs('2026-08-17T12:00:00.000Z', 'not-a-date')).toBeNull();
    expect(clampedDurationMs('', '')).toBeNull();
  });
});
