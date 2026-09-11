import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectArgs: { table: string | null; select: string | null; filters: unknown[][] } = {
  table: null,
  select: null,
  filters: [],
};

let rows: Record<string, unknown>[] = [];

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => {
    const builder: Record<string, unknown> = {};
    const record = (name: string) =>
      (...args: unknown[]) => {
        selectArgs.filters.push([name, ...args]);
        return builder;
      };

    builder.from = (table: string) => {
      selectArgs.table = table;
      return builder;
    };
    builder.select = (columns: string) => {
      selectArgs.select = columns;
      return builder;
    };
    builder.in = record('in');
    builder.is = record('is');
    builder.gt = record('gt');
    builder.order = record('order');
    builder.limit = (value: number) => {
      selectArgs.filters.push(['limit', value]);
      return Promise.resolve({ data: rows, error: null });
    };

    return builder;
  },
}));

const { listPendingReportCandidates } = await import(
  '~/lib/observability/pending-report-repository'
);

const NOW_ISO = '2026-09-11T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const now = () => NOW_MS;

function isoAgo(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function reportState(overrides: Record<string, unknown> = {}) {
  return {
    status: 'scoring',
    model: 'claude-opus-5',
    totalCases: 40,
    completedCases: 12,
    startedAt: isoAgo(60 * 60 * 1000),
    updatedAt: isoAgo(30 * 60 * 1000),
    caseScores: {},
    synthesis: null,
    error: null,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    test_id: 'test-1',
    completed_at: isoAgo(60 * 60 * 1000),
    report_state: reportState(),
    ...overrides,
  };
}

const DEFAULTS = { limit: 10, lookbackHours: 72, stalenessMinutes: 10, now };

beforeEach(() => {
  selectArgs.table = null;
  selectArgs.select = null;
  selectArgs.filters = [];
  rows = [];
});

describe('listPendingReportCandidates — Postgres-side predicate', () => {
  it('reads only completed runs with no report inside the lookback, newest first', async () => {
    await listPendingReportCandidates(DEFAULTS);

    expect(selectArgs.table).toBe('test_results');
    expect(selectArgs.select).toBe('id,test_id,completed_at,report_state');
    expect(selectArgs.filters).toEqual([
      ['in', 'status', ['completed', 'completed_with_failures']],
      ['is', 'report', null],
      ['gt', 'completed_at', '2026-09-08T12:00:00.000Z'],
      ['order', 'completed_at', { ascending: false }],
      ['limit', 100],
    ]);
  });
});

describe('listPendingReportCandidates — jsonb predicate', () => {
  it('selects a report frozen at scoring', async () => {
    rows = [row()];

    const candidates = await listPendingReportCandidates(DEFAULTS);

    expect(candidates).toEqual([
      {
        runId: 'run-1',
        testId: 'test-1',
        completedAt: isoAgo(60 * 60 * 1000),
        reportStatus: 'scoring',
        completedCases: 12,
        totalCases: 40,
        updatedAt: isoAgo(30 * 60 * 1000),
      },
    ]);
  });

  it('selects a run with no report_state at all', async () => {
    rows = [row({ id: 'run-no-state', report_state: null })];

    const candidates = await listPendingReportCandidates(DEFAULTS);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      runId: 'run-no-state',
      reportStatus: null,
      completedCases: null,
      totalCases: null,
    });
  });

  it('selects a report frozen at synthesizing', async () => {
    rows = [row({ report_state: reportState({ status: 'synthesizing' }) })];

    const candidates = await listPendingReportCandidates(DEFAULTS);

    expect(candidates.map((candidate) => candidate.reportStatus)).toEqual(['synthesizing']);
  });

  it('does NOT select a terminal report (completed or failed)', async () => {
    rows = [
      row({ id: 'run-done', report_state: reportState({ status: 'completed' }) }),
      row({ id: 'run-failed', report_state: reportState({ status: 'failed' }) }),
    ];

    expect(await listPendingReportCandidates(DEFAULTS)).toEqual([]);
  });

  it('does NOT select a report touched inside the staleness window', async () => {
    rows = [
      row({
        id: 'run-live',
        report_state: reportState({ updatedAt: isoAgo(2 * 60 * 1000) }),
      }),
    ];

    expect(await listPendingReportCandidates(DEFAULTS)).toEqual([]);
  });

  it('requires the idle age to strictly exceed the staleness window', async () => {
    rows = [row({ report_state: reportState({ updatedAt: isoAgo(10 * 60 * 1000) }) })];
    expect(await listPendingReportCandidates(DEFAULTS)).toEqual([]);

    selectArgs.filters = [];
    rows = [row({ report_state: reportState({ updatedAt: isoAgo(10 * 60 * 1000 + 1) }) })];
    expect(await listPendingReportCandidates(DEFAULTS)).toHaveLength(1);
  });

  it('still selects a report_state that fails to parse, honouring its raw updatedAt', async () => {
    rows = [
      // A corrupt state is exactly what the orchestrator restarts from scratch, so it must not be
      // silently skipped — but a fresh `updatedAt` on it still means someone is driving it.
      row({ id: 'run-corrupt-stale', report_state: { status: 'scoring', updatedAt: isoAgo(60_000 * 30) } }),
      row({ id: 'run-corrupt-live', report_state: { status: 'scoring', updatedAt: isoAgo(60_000) } }),
    ];

    const candidates = await listPendingReportCandidates(DEFAULTS);

    expect(candidates.map((candidate) => candidate.runId)).toEqual(['run-corrupt-stale']);
  });

  it('caps the returned candidates at the requested limit', async () => {
    rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];

    const candidates = await listPendingReportCandidates({ ...DEFAULTS, limit: 2 });

    expect(candidates.map((candidate) => candidate.runId)).toEqual(['a', 'b']);
  });
});
