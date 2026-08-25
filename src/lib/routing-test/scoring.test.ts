import { describe, expect, it } from 'vitest';

import {
  computeRoutingTestSummary,
  formatRoutingTestAccuracy,
  formatRoutingTestRunScore,
  isRoutingTestItemPass,
  mapWithConcurrency,
  normalizeRoutedAgent,
  routingTestAccuracyTone,
} from '~/lib/routing-test/scoring';

describe('normalizeRoutedAgent (B0-659)', () => {
  it('collapses a null keyword route to ambiguous', () => {
    expect(normalizeRoutedAgent(null)).toBe('ambiguous');
    expect(normalizeRoutedAgent(undefined)).toBe('ambiguous');
  });

  it('passes a real agent id through untouched', () => {
    expect(normalizeRoutedAgent('dilution')).toBe('dilution');
    expect(normalizeRoutedAgent('ambiguous')).toBe('ambiguous');
  });
});

describe('isRoutingTestItemPass', () => {
  it('passes only on an exact match', () => {
    expect(isRoutingTestItemPass('floor', 'floor')).toBe(true);
    expect(isRoutingTestItemPass('floor', 'product')).toBe(false);
  });

  it('never passes an ambiguous prediction — no expected agent is "ambiguous"', () => {
    expect(isRoutingTestItemPass('ambiguous', 'product')).toBe(false);
    expect(isRoutingTestItemPass('ambiguous', 'recommendations')).toBe(false);
  });
});

describe('computeRoutingTestSummary', () => {
  it('counts correct items, degradations, accuracy, and timing', () => {
    const summary = computeRoutingTestSummary(
      [
        { passed: true, error: null, elapsedMs: 10 },
        { passed: true, error: null, elapsedMs: 20 },
        { passed: false, error: null, elapsedMs: 30 },
        { passed: false, error: 'openai_error', elapsedMs: 40 },
      ],
      1234,
    );

    expect(summary).toEqual({
      total: 4,
      correct: 2,
      accuracy: 0.5,
      degraded: 1,
      durationMs: 1234,
      avgItemDurationMs: 25,
    });
  });

  it('reports 0 accuracy and 0 avgItemDurationMs (not NaN) for an empty list', () => {
    expect(computeRoutingTestSummary([], 0)).toEqual({
      total: 0,
      correct: 0,
      accuracy: 0,
      degraded: 0,
      durationMs: 0,
      avgItemDurationMs: 0,
    });
  });

  it('rounds accuracy to four decimal places', () => {
    const summary = computeRoutingTestSummary(
      Array.from({ length: 3 }, (_unused, index) => ({
        passed: index === 0,
        error: null,
        elapsedMs: 0,
      })),
      0,
    );
    expect(summary.accuracy).toBe(0.3333);
  });

  it('rounds avgItemDurationMs to the nearest millisecond', () => {
    const summary = computeRoutingTestSummary(
      [
        { passed: true, error: null, elapsedMs: 1 },
        { passed: true, error: null, elapsedMs: 2 },
        { passed: true, error: null, elapsedMs: 2 },
      ],
      0,
    );
    expect(summary.avgItemDurationMs).toBe(2);
  });
});

describe('formatRoutingTestRunScore', () => {
  it('renders "passed/total percent%" with no other text', () => {
    expect(formatRoutingTestRunScore(2, 4)).toBe('2/4 50%');
  });

  it('renders 0% for an empty run without dividing by zero', () => {
    expect(formatRoutingTestRunScore(0, 0)).toBe('0/0 0%');
  });
});

describe('formatRoutingTestAccuracy', () => {
  it('renders the summary line from the ticket', () => {
    const summary = computeRoutingTestSummary(
      Array.from({ length: 10 }, (_unused, index) => ({
        passed: index < 7,
        error: null,
        elapsedMs: 0,
      })),
      0,
    );
    expect(formatRoutingTestAccuracy(summary)).toBe('7/10 correct — 70%');
  });

  it('renders an empty run without dividing by zero', () => {
    expect(formatRoutingTestAccuracy(computeRoutingTestSummary([], 0))).toBe(
      '0/0 correct — 0%',
    );
  });
});

describe('routingTestAccuracyTone (B0-670)', () => {
  it('is "good" strictly above 80%', () => {
    expect(routingTestAccuracyTone(0.801)).toBe('good');
    expect(routingTestAccuracyTone(1)).toBe('good');
  });

  it('is "neutral" at exactly 80% (not strictly above the threshold)', () => {
    expect(routingTestAccuracyTone(0.8)).toBe('neutral');
  });

  it('is "neutral" between the two thresholds', () => {
    expect(routingTestAccuracyTone(0.6)).toBe('neutral');
    expect(routingTestAccuracyTone(0.51)).toBe('neutral');
  });

  it('is "bad" at or below 50%', () => {
    expect(routingTestAccuracyTone(0.5)).toBe('bad');
    expect(routingTestAccuracyTone(0.2)).toBe('bad');
    expect(routingTestAccuracyTone(0)).toBe('bad');
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order and never exceeds the limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const output = await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6, 7],
      3,
      async (value) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return value * 2;
      },
    );

    expect(output).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('handles an empty input list', async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });
});
