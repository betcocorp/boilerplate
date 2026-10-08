import { describe, expect, it } from 'vitest';

import {
  CRON_SWEEP_NAME,
  MANUAL_SWEEP_NAME,
  type ScheduledTestItem,
  type ScheduledTestRunWithItems,
} from '~/lib/observability/scheduled-test-types';
import type { ReportRunRow } from '~/lib/tests/repository';
import {
  buildThursdayScorecardSnapshot,
  selectThursdayNightSweeps,
} from '~/lib/tests/thursday-scorecard';
import {
  thursdayScorecardSnapshotSchema,
  type ThursdayScorecardSupporting,
} from '~/lib/tests/thursday-scorecard-schemas';

/* -------------------------------------------------------------------------- *
 * Fixtures — pure, no I/O (same style as report-trend.test.ts)
 * -------------------------------------------------------------------------- */

const child = (
  overrides: Partial<ScheduledTestItem> & Pick<ScheduledTestItem, 'test_id' | 'test_name'>,
): ScheduledTestItem => ({
  id: `item-${overrides.test_id}`,
  scheduled_run_id: 'sweep',
  test_run_id: `run-${overrides.test_id}`,
  status: 'completed',
  started_at: null,
  completed_at: null,
  elapsed_ms: null,
  items_total: null,
  items_passed: null,
  items_failed: null,
  pass_rate: null,
  grade: null,
  confidence: null,
  error_code: null,
  error_message: null,
  error_details: null,
  retry_count: 0,
  last_retry_at: null,
  claimed_by: null,
  created_at: '2026-09-18T00:00:45Z',
  updated_at: '2026-09-18T00:00:45Z',
  ...overrides,
});

const sweep = (
  overrides: Partial<ScheduledTestRunWithItems> &
    Pick<ScheduledTestRunWithItems, 'id' | 'sweep_triggered_at'>,
): ScheduledTestRunWithItems => ({
  sweep_name: CRON_SWEEP_NAME,
  run_mode: 'full',
  partial_score_threshold: null,
  status: 'completed',
  error_message: null,
  started_at: null,
  completed_at: null,
  elapsed_ms: null,
  total_tests: 0,
  successful_tests: 0,
  failed_tests: 0,
  timed_out_tests: 0,
  success_rate: null,
  avg_elapsed_ms: null,
  metadata: {},
  created_at: overrides.sweep_triggered_at,
  updated_at: overrides.sweep_triggered_at,
  items: [],
  ...overrides,
});

const reportRow = (
  overrides: Partial<ReportRunRow> & Pick<ReportRunRow, 'runId' | 'testId'>,
): ReportRunRow => ({
  testName: 'Dataset',
  startedAt: '2026-09-18T00:01:00Z',
  reportGeneratedAt: '2026-09-18T01:00:00Z',
  reportStatus: 'completed',
  score: 90,
  grade: 'A',
  failCount: 2,
  triggeredBy: 'cron',
  modelTag: 'gpt-4.1',
  appVersion: '8.0.0',
  averageTtftMs: 1200,
  averageElapsedMs: 8000,
  reportState: null,
  ...overrides,
});

const byRunId = (rows: ReportRunRow[]) => new Map(rows.map((row) => [row.runId, row]));

/* -------------------------------------------------------------------------- *
 * selectThursdayNightSweeps — the one-per-Thursday rule
 * -------------------------------------------------------------------------- */

describe('selectThursdayNightSweeps', () => {
  it('keeps the 00:00 UTC cron firings that are Thursday evening in Eastern (EDT)', () => {
    // 2026-09-25T00:00:50Z = Thu Sep 24, 8:00 PM EDT — a FRIDAY UTC date.
    const thu = sweep({ id: 'thu-0924', sweep_triggered_at: '2026-09-25T00:00:50.461+00:00' });
    expect(selectThursdayNightSweeps([thu]).map((run) => run.id)).toEqual(['thu-0924']);
  });

  it('keeps the 00:00 UTC firing in EST too (Thu Dec 17, 7:00 PM EST) and excludes 01:00 UTC', () => {
    const dec = sweep({ id: 'thu-1217', sweep_triggered_at: '2026-12-18T00:00:40Z' });
    // 01:00 UTC is still Thursday 8:00 PM EST, but outside the cron's nominal hour → excluded.
    const lateHour = sweep({ id: 'late', sweep_triggered_at: '2026-12-18T01:00:00Z' });
    expect(selectThursdayNightSweeps([lateHour, dec]).map((run) => run.id)).toEqual(['thu-1217']);
  });

  it('is decided in America/New_York: 2026-10-08 00:00 UTC is a Wednesday, 2026-10-02 00:00 UTC is a Thursday', () => {
    const wed = sweep({ id: 'wed-1007', sweep_triggered_at: '2026-10-08T00:00:44.268+00:00' });
    const thu = sweep({ id: 'thu-1001', sweep_triggered_at: '2026-10-02T00:00:46.423+00:00' });
    expect(selectThursdayNightSweeps([wed, thu]).map((run) => run.id)).toEqual(['thu-1001']);
  });

  it('excludes daytime re-triggers on the same Thursday and collapses two in-window firings to the earliest', () => {
    const scheduled = sweep({ id: 'first', sweep_triggered_at: '2026-10-02T00:00:34Z' });
    const retry = sweep({ id: 'retry', sweep_triggered_at: '2026-10-02T00:00:45Z' });
    const daytimeA = sweep({ id: 'day-a', sweep_triggered_at: '2026-10-01T17:22:31Z' });
    const daytimeB = sweep({ id: 'day-b', sweep_triggered_at: '2026-10-01T18:39:56Z' });
    const result = selectThursdayNightSweeps([daytimeB, daytimeA, retry, scheduled]);
    expect(result.map((run) => run.id)).toEqual(['first']);
  });

  it('ignores manual sweeps and partial sweeps even inside the window', () => {
    const manual = sweep({
      id: 'manual',
      sweep_name: MANUAL_SWEEP_NAME,
      sweep_triggered_at: '2026-09-25T00:00:50Z',
    });
    const partial = sweep({
      id: 'partial',
      run_mode: 'partial',
      sweep_triggered_at: '2026-09-25T00:00:50Z',
    });
    expect(selectThursdayNightSweeps([manual, partial])).toEqual([]);
  });

  it('returns newest first, one per Thursday', () => {
    const a = sweep({ id: 'thu-0917', sweep_triggered_at: '2026-09-18T00:00:44Z' });
    const b = sweep({ id: 'thu-0924', sweep_triggered_at: '2026-09-25T00:00:50Z' });
    const c = sweep({ id: 'thu-1001', sweep_triggered_at: '2026-10-02T00:00:46Z' });
    expect(selectThursdayNightSweeps([a, c, b]).map((run) => run.id)).toEqual([
      'thu-1001',
      'thu-0924',
      'thu-0917',
    ]);
  });
});

/* -------------------------------------------------------------------------- *
 * buildThursdayScorecardSnapshot — the fold
 * -------------------------------------------------------------------------- */

const AGENTS = ['dilution', 'product', 'bathroom', 'floor_vct', 'floor_wood_sport'] as const;

function fiveChildren(prefix: string, status: ScheduledTestItem['status'] = 'completed') {
  return AGENTS.map((agent, index) =>
    child({
      // Bulk-inserted children share one created_at; `id` is the deterministic tiebreak.
      id: `${prefix}-item-${index}`,
      test_id: `${prefix}-${agent}`,
      test_name: `${agent} golden set`,
      test_run_id: status === 'completed' || status === 'running' ? `run-${prefix}-${agent}` : null,
      status,
    }),
  );
}

const CURRENT = sweep({
  id: 'thu-0924',
  sweep_triggered_at: '2026-09-25T00:00:50Z',
  items: fiveChildren('cur'),
});
const PREVIOUS = sweep({
  id: 'thu-0917',
  sweep_triggered_at: '2026-09-18T00:00:44Z',
  items: fiveChildren('cur'), // same test ids — same datasets both weeks
});

const registryLabels = new Map<string, string | null>(
  AGENTS.map((agent) => [`cur-${agent}`, agent]),
);

describe('buildThursdayScorecardSnapshot', () => {
  it('parses with thursdayScorecardSnapshotSchema and yields one row per child in ledger order', () => {
    const snapshot = buildThursdayScorecardSnapshot({
      sweep: CURRENT,
      previousSweep: null,
      reportRowsByRunId: byRunId(
        CURRENT.items.map((item) =>
          reportRow({ runId: item.test_run_id!, testId: item.test_id, score: 92.7, grade: 'A' }),
        ),
      ),
      previousReportRowsByRunId: new Map(),
      intendedAgentByTestId: registryLabels,
    });
    expect(thursdayScorecardSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.agents.map((row) => row.testId)).toEqual(CURRENT.items.map((i) => i.test_id));
    expect(snapshot.agents.map((row) => row.agentLabel)).toEqual([
      'Dilution Control Specialist',
      'Betco Product Specialist',
      'Bathroom specialist',
      'VCT & Resilient Tile Floor Care Specialist',
      'Wood/Sport Floor Care Specialist',
    ]);
    expect(snapshot.sweep).toEqual({
      id: 'thu-0924',
      sweepTriggeredAt: '2026-09-25T00:00:50Z',
      status: 'completed',
      totalTests: 5,
      successfulTests: 5,
      failedTests: 0,
      timedOutTests: 0,
    });
    expect(snapshot.previousSweep).toBeNull();
  });

  it('no prior Thursday → change null on every row', () => {
    const snapshot = buildThursdayScorecardSnapshot({
      sweep: CURRENT,
      previousSweep: null,
      reportRowsByRunId: byRunId(
        CURRENT.items.map((item) => reportRow({ runId: item.test_run_id!, testId: item.test_id })),
      ),
      previousReportRowsByRunId: new Map(),
      intendedAgentByTestId: registryLabels,
    });
    expect(snapshot.agents.every((row) => row.score === 90 && row.change === null)).toBe(true);
  });

  it('prior Thursday exists but is unscored (report failed) → change null, previousSweep still named', () => {
    const snapshot = buildThursdayScorecardSnapshot({
      sweep: CURRENT,
      previousSweep: PREVIOUS,
      reportRowsByRunId: byRunId(
        CURRENT.items.map((item) => reportRow({ runId: item.test_run_id!, testId: item.test_id })),
      ),
      previousReportRowsByRunId: byRunId(
        PREVIOUS.items.map((item) =>
          reportRow({
            runId: item.test_run_id!,
            testId: item.test_id,
            reportStatus: 'failed',
            score: null,
            grade: null,
          }),
        ),
      ),
      intendedAgentByTestId: registryLabels,
    });
    expect(snapshot.previousSweep).toEqual({
      id: 'thu-0917',
      sweepTriggeredAt: '2026-09-18T00:00:44Z',
    });
    expect(snapshot.agents.every((row) => row.change === null)).toBe(true);
  });

  it('computes change against the same test_id in the previous sweep: delta, percent, tie → 0, previous 0 → percent null', () => {
    const current = byRunId([
      reportRow({ runId: 'run-cur-dilution', testId: 'cur-dilution', score: 92.7 }),
      reportRow({ runId: 'run-cur-product', testId: 'cur-product', score: 78.7 }),
      reportRow({ runId: 'run-cur-bathroom', testId: 'cur-bathroom', score: 89.1 }),
      reportRow({ runId: 'run-cur-floor_vct', testId: 'cur-floor_vct', score: 50 }),
      reportRow({ runId: 'run-cur-floor_wood_sport', testId: 'cur-floor_wood_sport', score: 88.4 }),
    ]);
    const previous = byRunId([
      reportRow({ runId: 'prev-dilution', testId: 'cur-dilution', score: 90.1 }),
      reportRow({ runId: 'prev-product', testId: 'cur-product', score: 80 }),
      reportRow({ runId: 'prev-bathroom', testId: 'cur-bathroom', score: 89.1 }),
      reportRow({ runId: 'prev-floor_vct', testId: 'cur-floor_vct', score: 0 }),
      // floor_wood_sport: no previous row at all
    ]);
    const previousSweep = sweep({
      id: 'thu-0917',
      sweep_triggered_at: '2026-09-18T00:00:44Z',
      items: AGENTS.map((agent) =>
        child({ test_id: `cur-${agent}`, test_name: agent, test_run_id: `prev-${agent}` }),
      ),
    });

    const snapshot = buildThursdayScorecardSnapshot({
      sweep: CURRENT,
      previousSweep,
      reportRowsByRunId: current,
      previousReportRowsByRunId: previous,
      intendedAgentByTestId: registryLabels,
    });
    const byTest = new Map(snapshot.agents.map((row) => [row.testId, row]));

    expect(byTest.get('cur-dilution')?.change).toEqual({
      runId: 'run-cur-dilution',
      previousRunId: 'prev-dilution',
      previousScore: 90.1,
      deltaPoints: 2.6,
      changePercent: 2.9,
    });
    expect(byTest.get('cur-product')?.change).toEqual({
      runId: 'run-cur-product',
      previousRunId: 'prev-product',
      previousScore: 80,
      deltaPoints: -1.3,
      changePercent: -1.6,
    });
    // Tie.
    expect(byTest.get('cur-bathroom')?.change).toMatchObject({ deltaPoints: 0, changePercent: 0 });
    // Previous score 0 → percent undefined, not infinite.
    expect(byTest.get('cur-floor_vct')?.change).toMatchObject({
      previousScore: 0,
      deltaPoints: 50,
      changePercent: null,
    });
    // Present this week, absent last week.
    expect(byTest.get('cur-floor_wood_sport')?.change).toBeNull();
  });

  it('a re-seeded dataset (different test_id each week) gets no comparison', () => {
    const previousSweep = sweep({
      id: 'thu-0917',
      sweep_triggered_at: '2026-09-18T00:00:44Z',
      items: fiveChildren('old'),
    });
    const snapshot = buildThursdayScorecardSnapshot({
      sweep: CURRENT,
      previousSweep,
      reportRowsByRunId: byRunId(
        CURRENT.items.map((item) => reportRow({ runId: item.test_run_id!, testId: item.test_id })),
      ),
      previousReportRowsByRunId: byRunId(
        previousSweep.items.map((item) =>
          reportRow({ runId: item.test_run_id!, testId: item.test_id, score: 70 }),
        ),
      ),
      intendedAgentByTestId: registryLabels,
    });
    expect(snapshot.agents.every((row) => row.change === null)).toBe(true);
  });

  it('a failed sweep (0/5) still yields five rows with ledgerStatus failed and score null', () => {
    const failed = sweep({
      id: 'thu-1001',
      sweep_triggered_at: '2026-10-02T00:00:46Z',
      items: fiveChildren('new', 'failed'),
    });
    const snapshot = buildThursdayScorecardSnapshot({
      sweep: failed,
      previousSweep: CURRENT,
      reportRowsByRunId: new Map(),
      previousReportRowsByRunId: byRunId(
        CURRENT.items.map((item) => reportRow({ runId: item.test_run_id!, testId: item.test_id })),
      ),
      intendedAgentByTestId: new Map(),
    });
    expect(snapshot.agents).toHaveLength(5);
    for (const row of snapshot.agents) {
      expect(row.ledgerStatus).toBe('failed');
      expect(row.runId).toBeNull();
      expect(row.score).toBeNull();
      expect(row.grade).toBeNull();
      expect(row.reportStatus).toBeNull();
      expect(row.failCount).toBeNull();
      expect(row.change).toBeNull();
      expect(row.conceptPercent).toBeNull();
      expect(row.supporting).toBeNull();
    }
    expect(snapshot.sweep).toMatchObject({ totalTests: 5, successfulTests: 0, failedTests: 5 });
    expect(thursdayScorecardSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('a completed child whose report failed keeps reportStatus "failed" and a null score', () => {
    const snapshot = buildThursdayScorecardSnapshot({
      sweep: CURRENT,
      previousSweep: null,
      reportRowsByRunId: byRunId(
        CURRENT.items.map((item) =>
          reportRow({
            runId: item.test_run_id!,
            testId: item.test_id,
            reportStatus: 'failed',
            score: null,
            grade: null,
            failCount: 3,
          }),
        ),
      ),
      previousReportRowsByRunId: new Map(),
      intendedAgentByTestId: registryLabels,
    });
    for (const row of snapshot.agents) {
      expect(row.ledgerStatus).toBe('completed');
      expect(row.reportStatus).toBe('failed');
      expect(row.score).toBeNull();
      expect(row.failCount).toBe(3);
      expect(row.modelTag).toBe('gpt-4.1');
    }
  });

  it('agentLabel falls back to test_name for a retired id ("floor") and for null', () => {
    const run = sweep({
      id: 'thu',
      sweep_triggered_at: '2026-09-18T00:00:44Z',
      items: [
        child({ id: 'i-1', test_id: 't-floor', test_name: 'Floor (VCT) golden set' }),
        child({ id: 'i-2', test_id: 't-null', test_name: 'Unlabelled set' }),
        child({ id: 'i-3', test_id: 't-missing', test_name: 'Deleted set' }),
        child({ id: 'i-4', test_id: 't-product', test_name: 'Product set' }),
      ],
    });
    const snapshot = buildThursdayScorecardSnapshot({
      sweep: run,
      previousSweep: null,
      reportRowsByRunId: new Map(),
      previousReportRowsByRunId: new Map(),
      intendedAgentByTestId: new Map([
        ['t-floor', 'floor'],
        ['t-null', null],
        ['t-product', 'product'],
      ]),
    });
    expect(snapshot.agents.map((row) => [row.intendedAgent, row.agentLabel])).toEqual([
      ['floor', 'Floor (VCT) golden set'],
      [null, 'Unlabelled set'],
      [null, 'Deleted set'],
      ['product', 'Betco Product Specialist'],
    ]);
    expect(snapshot.agents.every((row) => row.agentLabel.length > 0)).toBe(true);
  });

  it('B0-1167 — supporting metrics never change the content fields', () => {
    const rows = byRunId(
      CURRENT.items.map((item) => reportRow({ runId: item.test_run_id!, testId: item.test_id })),
    );
    const supporting: ThursdayScorecardSupporting = {
      speedScore: 87,
      speedRating: 'Good',
      avgTtftSeconds: 1.23,
      avgTotalSeconds: 8.1,
      similarityAvg: 0.82,
      evalConfidenceAvg: 91,
      passRate: 80,
      passMark: 75,
    };
    const base = {
      sweep: CURRENT,
      previousSweep: PREVIOUS,
      reportRowsByRunId: rows,
      previousReportRowsByRunId: byRunId(
        PREVIOUS.items.map((item) =>
          reportRow({ runId: `p-${item.test_id}`, testId: item.test_id, score: 85 }),
        ),
      ),
      intendedAgentByTestId: registryLabels,
    };
    const without = buildThursdayScorecardSnapshot(base);
    const withSupporting = buildThursdayScorecardSnapshot({
      ...base,
      supportingByRunId: new Map(
        CURRENT.items.map((item) => [item.test_run_id!, supporting] as const),
      ),
    });

    expect(without.agents.every((row) => row.supporting === null)).toBe(true);
    expect(withSupporting.agents.every((row) => row.supporting === supporting)).toBe(true);

    const strip = (row: (typeof without.agents)[number]) => {
      const { supporting, ...content } = row;
      void supporting;
      return content;
    };
    expect(withSupporting.agents.map(strip)).toEqual(without.agents.map(strip));
    expect(withSupporting.sweep).toEqual(without.sweep);
    expect(withSupporting.previousSweep).toEqual(without.previousSweep);
  });
});
