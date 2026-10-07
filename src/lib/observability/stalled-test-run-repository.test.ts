import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-1110 — the stalled-run sweeper's candidate read must cover every chat run mode, not only
 * `full`: a `partial` run cut off by the 300 s budget would otherwise never be re-armed. Search
 * runs never yield/resume and stay excluded.
 */

const calls: { table: string | null; filters: unknown[][] } = { table: null, filters: [] };
let rows: Record<string, unknown>[] = [];

vi.mock('~/lib/observability/logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => {
    const builder: Record<string, unknown> = {};
    const record = (name: string) =>
      (...args: unknown[]) => {
        calls.filters.push([name, ...args]);
        return builder;
      };

    builder.from = (table: string) => {
      calls.table = table;
      return builder;
    };
    builder.select = record('select');
    builder.in = record('in');
    builder.eq = record('eq');
    builder.order = record('order');
    builder.limit = (value: number) => {
      calls.filters.push(['limit', value]);
      // `lastItemCreatedAt` (test_result_items) resolves to no rows; the candidate read to `rows`.
      const data = calls.table === 'test_results' ? rows : [];
      return Promise.resolve({ data, error: null });
    };

    return builder;
  },
}));

const { listStalledTestRunCandidates } = await import(
  '~/lib/observability/stalled-test-run-repository'
);

describe('listStalledTestRunCandidates (B0-1110)', () => {
  beforeEach(() => {
    calls.table = null;
    calls.filters = [];
    rows = [];
  });

  it('reads every chat run mode — full AND partial — and never search', async () => {
    rows = [
      {
        id: 'run-partial',
        test_id: 'test-1',
        status: 'running',
        created_at: '2026-09-29T00:00:00.000Z',
        started_at: '2026-09-29T00:00:00.000Z',
        summary: {},
      },
    ];

    const candidates = await listStalledTestRunCandidates(10);

    const runModeFilter = calls.filters.find(
      (filter) => filter[0] === 'in' && filter[1] === 'run_mode',
    );
    expect(runModeFilter?.[2]).toEqual(['full', 'partial']);
    expect(runModeFilter?.[2]).not.toContain('search');
    // No `.eq('run_mode', …)` survives: the old full-only filter is gone.
    expect(calls.filters.some((filter) => filter[0] === 'eq' && filter[1] === 'run_mode')).toBe(
      false,
    );
    expect(candidates.map((candidate) => candidate.id)).toEqual(['run-partial']);
  });
});
