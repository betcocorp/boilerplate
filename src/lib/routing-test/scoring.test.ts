import { describe, expect, it } from 'vitest';

import {
  computeRoutingTestSummary,
  formatRoutingTestAccuracy,
  isRoutingTestItemPass,
  mapWithConcurrency,
  normalizeRoutedAgent,
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
  it('counts correct items, degradations, and accuracy', () => {
    const summary = computeRoutingTestSummary([
      { passed: true, error: null },
      { passed: true, error: null },
      { passed: false, error: null },
      { passed: false, error: 'openai_error' },
    ]);

    expect(summary).toEqual({
      total: 4,
      correct: 2,
      accuracy: 0.5,
      degraded: 1,
    });
  });

  it('reports 0 accuracy (not NaN) for an empty list', () => {
    expect(computeRoutingTestSummary([])).toEqual({
      total: 0,
      correct: 0,
      accuracy: 0,
      degraded: 0,
    });
  });

  it('rounds accuracy to four decimal places', () => {
    const summary = computeRoutingTestSummary(
      Array.from({ length: 3 }, (_unused, index) => ({
        passed: index === 0,
        error: null,
      })),
    );
    expect(summary.accuracy).toBe(0.3333);
  });
});

describe('formatRoutingTestAccuracy', () => {
  it('renders the summary line from the ticket', () => {
    const summary = computeRoutingTestSummary(
      Array.from({ length: 10 }, (_unused, index) => ({
        passed: index < 7,
        error: null,
      })),
    );
    expect(formatRoutingTestAccuracy(summary)).toBe('7/10 correct — 70%');
  });

  it('renders an empty run without dividing by zero', () => {
    expect(formatRoutingTestAccuracy(computeRoutingTestSummary([]))).toBe(
      '0/0 correct — 0%',
    );
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
