import { describe, expect, it } from 'vitest';

import {
  buildApiAnalytics,
  computeDailySeries,
  computeLatencyPercentiles,
  computeRollup,
  computeStatusBreakdown,
  type RequestLogRow,
} from '~/lib/api/analytics-repository';

const NOW = new Date('2026-07-15T12:00:00Z').getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function row(over: Partial<RequestLogRow> & { agoMs: number }): RequestLogRow {
  return {
    projectId: 'p1',
    appId: 'a1',
    status: 200,
    latencyMs: 100,
    promptTokens: null,
    completionTokens: null,
    totalTokens: 0,
    method: 'POST',
    path: '/api/v1/orchestrator',
    createdAt: new Date(NOW - over.agoMs).toISOString(),
    ...over,
  };
}

describe('computeRollup (B0-120)', () => {
  it('counts rolling windows, error rate, avg latency, tokens, and last-used', () => {
    const rows = [
      row({ agoMs: 1 * HOUR, status: 200, latencyMs: 100, totalTokens: 10 }),
      row({ agoMs: 3 * DAY, status: 500, latencyMs: 300, totalTokens: 20 }),
      row({ agoMs: 20 * DAY, status: 200, latencyMs: 200, totalTokens: 30 }),
    ];
    const r = computeRollup(rows, NOW);
    expect(r.requestsToday).toBe(1);
    expect(r.requests7d).toBe(2);
    expect(r.requests30d).toBe(3);
    expect(r.errorRate).toBe(Math.round((1 / 3) * 1000) / 1000);
    expect(r.avgLatencyMs).toBe(200); // (100+300+200)/3
    expect(r.totalTokens).toBe(60);
    expect(r.lastUsedAt).toBe(new Date(NOW - 1 * HOUR).toISOString());
  });

  it('is all-zero for no rows', () => {
    const r = computeRollup([], NOW);
    expect(r).toMatchObject({ requestsToday: 0, requests30d: 0, errorRate: 0, avgLatencyMs: null, totalTokens: 0, lastUsedAt: null });
  });
});

describe('computeLatencyPercentiles (B0-120)', () => {
  it('returns null when no row has latency', () => {
    expect(computeLatencyPercentiles([row({ agoMs: HOUR, latencyMs: null })])).toBeNull();
  });
  it('computes p50/p95/p99', () => {
    const rows = Array.from({ length: 100 }, (_, i) => row({ agoMs: HOUR, latencyMs: i + 1 }));
    const p = computeLatencyPercentiles(rows)!;
    expect(p.p50).toBe(50);
    expect(p.p95).toBe(95);
    expect(p.p99).toBe(99);
  });
});

describe('computeStatusBreakdown (B0-120)', () => {
  it('buckets by class, most-frequent first, omitting empty buckets', () => {
    const rows = [
      row({ agoMs: HOUR, status: 200 }),
      row({ agoMs: HOUR, status: 201 }),
      row({ agoMs: HOUR, status: 404 }),
      row({ agoMs: HOUR, status: 500 }),
    ];
    const breakdown = computeStatusBreakdown(rows);
    expect(breakdown[0]).toEqual({ bucket: '2xx', count: 2 });
    expect(breakdown.find((b) => b.bucket === '4xx')?.count).toBe(1);
    expect(breakdown.find((b) => b.bucket === '3xx')).toBeUndefined();
  });
});

describe('computeDailySeries (B0-120)', () => {
  it('zero-fills the window and buckets requests + tokens by UTC day', () => {
    const rows = [
      row({ agoMs: 0, totalTokens: 5 }),
      row({ agoMs: 0, totalTokens: 5 }),
      row({ agoMs: 2 * DAY, totalTokens: 7 }),
    ];
    const series = computeDailySeries(rows, NOW, 7);
    expect(series).toHaveLength(7);
    expect(series[series.length - 1]).toEqual({ date: '2026-07-15', requests: 2, tokens: 10 });
    expect(series[series.length - 3]).toEqual({ date: '2026-07-13', requests: 1, tokens: 7 });
  });
});

describe('buildApiAnalytics (B0-120)', () => {
  it('groups rollups by project and app', () => {
    const rows = [
      row({ agoMs: HOUR, projectId: 'p1', appId: 'a1' }),
      row({ agoMs: HOUR, projectId: 'p1', appId: 'a2' }),
      row({ agoMs: HOUR, projectId: 'p2', appId: 'a3' }),
    ];
    const analytics = buildApiAnalytics({
      rows,
      projects: [{ id: 'p1', name: 'C360' }, { id: 'p2', name: 'betco.com' }],
      apps: [
        { id: 'a1', name: 'Web', projectId: 'p1' },
        { id: 'a2', name: 'Mobile', projectId: 'p1' },
        { id: 'a3', name: 'Web', projectId: 'p2' },
      ],
      now: NOW,
      windowDays: 30,
      generatedAt: new Date(NOW).toISOString(),
    });
    expect(analytics.overall.requests30d).toBe(3);
    const c360 = analytics.projects.find((p) => p.id === 'p1')!;
    expect(c360.rollup.requests30d).toBe(2);
    expect(c360.apps).toHaveLength(2);
    expect(c360.apps.map((a) => a.rollup.requests30d)).toEqual([1, 1]);
  });
});
