import { describe, expect, it } from 'vitest';

import { resolveCostWindow } from '~/lib/observability/cost-metrics';

const NOW = new Date('2026-08-19T12:00:00.000Z');

describe('resolveCostWindow', () => {
  it('resolves each time range to the expected day-span ending today, in UTC', () => {
    expect(resolveCostWindow({ timeRange: '1d' }, NOW)).toEqual({
      startDate: '2026-08-18',
      endDate: '2026-08-19',
    });
    expect(resolveCostWindow({ timeRange: '1w' }, NOW)).toEqual({
      startDate: '2026-08-12',
      endDate: '2026-08-19',
    });
    expect(resolveCostWindow({ timeRange: '1y' }, NOW)).toEqual({
      startDate: '2025-08-19',
      endDate: '2026-08-19',
    });
  });

  it('honors an explicit endDate instead of "now"', () => {
    expect(resolveCostWindow({ timeRange: '1w', endDate: '2026-01-10' }, NOW)).toEqual({
      startDate: '2026-01-03',
      endDate: '2026-01-10',
    });
  });

  it('honors an explicit startDate, overriding the timeRange-derived one', () => {
    expect(
      resolveCostWindow({ timeRange: '1y', startDate: '2026-08-01', endDate: '2026-08-19' }, NOW),
    ).toEqual({ startDate: '2026-08-01', endDate: '2026-08-19' });
  });
});
