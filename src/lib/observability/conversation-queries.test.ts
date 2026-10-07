import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildEscalationConfidenceCorrelation,
  buildPassRateByAgent,
  buildPauseTierDistribution,
  getEscalationConfidenceCorrelation,
  getPassRateByAgent,
  getPauseTierDistribution,
} from '~/lib/observability/conversation-queries';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

const WINDOW = { from: '2026-08-10T00:00:00.000Z', to: '2026-08-17T00:00:00.000Z' };

/**
 * Stub for the one query shape the library drives per table:
 * `.from(table).select().gte().lte().order()[.not()].range()`. Results are keyed by table name;
 * a single page (< 1000 rows) per table is all these tests need.
 */
function useClient(resultsByTable: Record<string, { data: unknown[] | null; error: { message: string } | null }>) {
  const from = (table: string) => {
    const builder = {
      select: () => builder,
      gte: () => builder,
      lte: () => builder,
      order: () => builder,
      not: () => builder,
      range: () =>
        Promise.resolve(resultsByTable[table] ?? { data: [], error: null }),
    };
    return builder;
  };

  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    from,
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildPassRateByAgent', () => {
  it('groups completed items by routing decision and computes the rate', () => {
    const rows = [
      { routing_decision: 'product', passed: true, status: 'completed' },
      { routing_decision: 'product', passed: true, status: 'completed' },
      { routing_decision: 'product', passed: false, status: 'completed' },
      { routing_decision: 'dilution', passed: true, status: 'completed' },
    ];

    expect(buildPassRateByAgent(rows)).toEqual([
      { agent: 'product', total: 3, passed: 2, passRate: 0.6667 },
      { agent: 'dilution', total: 1, passed: 1, passRate: 1 },
    ]);
  });

  it('buckets items without a routing decision as unrouted', () => {
    const rows = [
      { routing_decision: null, passed: false, status: 'completed' },
      { routing_decision: '  ', passed: true, status: 'completed' },
    ];

    expect(buildPassRateByAgent(rows)).toEqual([
      { agent: 'unrouted', total: 2, passed: 1, passRate: 0.5 },
    ]);
  });

  it('excludes ungraded items — an errored item has a passed default, not a verdict', () => {
    const rows = [
      { routing_decision: 'product', passed: false, status: 'error' },
      { routing_decision: 'product', passed: true, status: 'completed' },
    ];

    expect(buildPassRateByAgent(rows)).toEqual([
      { agent: 'product', total: 1, passed: 1, passRate: 1 },
    ]);
  });

  it('returns an empty list for an empty window', () => {
    expect(buildPassRateByAgent([])).toEqual([]);
  });
});

describe('buildEscalationConfidenceCorrelation', () => {
  it('buckets with the aggregate-dashboard boundaries and computes per-bucket rates', () => {
    const runs = [
      { id: 'r1', confidence: 0.95 },
      { id: 'r2', confidence: 0.8 }, // boundary: high is >= 0.80
      { id: 'r3', confidence: 0.79 },
      { id: 'r4', confidence: 0.5 }, // boundary: mid is >= 0.50
      { id: 'r5', confidence: 0.3 },
      { id: 'r6', confidence: null },
      { id: 'r7', confidence: Number.NaN },
    ];
    const escalated = new Set(['r3', 'r5', 'r6']);

    expect(buildEscalationConfidenceCorrelation(runs, escalated)).toEqual([
      { bucket: 'high', runCount: 2, escalatedCount: 0, escalationRate: 0 },
      { bucket: 'mid', runCount: 2, escalatedCount: 1, escalationRate: 0.5 },
      { bucket: 'low', runCount: 1, escalatedCount: 1, escalationRate: 1 },
      { bucket: 'none', runCount: 2, escalatedCount: 1, escalationRate: 0.5 },
    ]);
  });

  it('reports empty buckets with a null rate, never a fake 0', () => {
    expect(buildEscalationConfidenceCorrelation([], new Set())).toEqual([
      { bucket: 'high', runCount: 0, escalatedCount: 0, escalationRate: null },
      { bucket: 'mid', runCount: 0, escalatedCount: 0, escalationRate: null },
      { bucket: 'low', runCount: 0, escalatedCount: 0, escalationRate: null },
      { bucket: 'none', runCount: 0, escalatedCount: 0, escalationRate: null },
    ]);
  });
});

describe('buildPauseTierDistribution', () => {
  it('seeds every tier and computes shares over classified turns only', () => {
    const rows = [
      { pause_tier: 'instant' },
      { pause_tier: 'instant' },
      { pause_tier: 'short' },
      { pause_tier: 'abandoned' },
      { pause_tier: 'not-a-tier' }, // untyped text column — dropped, never invented into a tier
    ];

    expect(buildPauseTierDistribution(rows)).toEqual([
      { tier: 'instant', count: 2, share: 0.5 },
      { tier: 'short', count: 1, share: 0.25 },
      { tier: 'medium', count: 0, share: 0 },
      { tier: 'long', count: 0, share: 0 },
      { tier: 'abandoned', count: 1, share: 0.25 },
    ]);
  });

  it('returns all-zero tiers with null shares when nothing is classified', () => {
    expect(buildPauseTierDistribution([])).toEqual([
      { tier: 'instant', count: 0, share: null },
      { tier: 'short', count: 0, share: null },
      { tier: 'medium', count: 0, share: null },
      { tier: 'long', count: 0, share: null },
      { tier: 'abandoned', count: 0, share: null },
    ]);
  });
});

describe('query paths (mocked client)', () => {
  it('getPassRateByAgent folds the scanned harness rows', async () => {
    useClient({
      test_result_items: {
        data: [
          { routing_decision: 'product', passed: true, status: 'completed' },
          { routing_decision: 'product', passed: false, status: 'completed' },
        ],
        error: null,
      },
    });

    expect(await getPassRateByAgent(WINDOW)).toEqual([
      { agent: 'product', total: 2, passed: 1, passRate: 0.5 },
    ]);
  });

  it('getEscalationConfidenceCorrelation intersects review tasks on the scanned run ids', async () => {
    useClient({
      workflow_runs: {
        data: [
          { id: 'r1', confidence: 0.9 },
          { id: 'r2', confidence: 0.2 },
        ],
        error: null,
      },
      review_tasks: {
        data: [
          { workflow_run_id: 'r2' },
          { workflow_run_id: 'r2' }, // second task on the same run must not double-count
          { workflow_run_id: 'r-outside-window' },
        ],
        error: null,
      },
    });

    expect(await getEscalationConfidenceCorrelation(WINDOW)).toEqual([
      { bucket: 'high', runCount: 1, escalatedCount: 0, escalationRate: 0 },
      { bucket: 'mid', runCount: 0, escalatedCount: 0, escalationRate: null },
      { bucket: 'low', runCount: 1, escalatedCount: 1, escalationRate: 1 },
      { bucket: 'none', runCount: 0, escalatedCount: 0, escalationRate: null },
    ]);
  });

  it('getPauseTierDistribution folds the classified message rows', async () => {
    useClient({
      agent_messages: {
        data: [{ pause_tier: 'instant' }, { pause_tier: 'long' }],
        error: null,
      },
    });

    expect(await getPauseTierDistribution(WINDOW)).toEqual([
      { tier: 'instant', count: 1, share: 0.5 },
      { tier: 'short', count: 0, share: 0 },
      { tier: 'medium', count: 0, share: 0 },
      { tier: 'long', count: 1, share: 0.5 },
      { tier: 'abandoned', count: 0, share: 0 },
    ]);
  });

  it('surfaces a scan error as a thrown Error', async () => {
    useClient({
      test_result_items: { data: null, error: { message: 'scan boom' } },
    });

    await expect(getPassRateByAgent(WINDOW)).rejects.toThrow('scan boom');
  });
});
