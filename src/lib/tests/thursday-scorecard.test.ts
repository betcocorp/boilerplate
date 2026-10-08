import { describe, expect, it } from 'vitest';

import {
  CRON_SWEEP_NAME,
  MANUAL_SWEEP_NAME,
  type ScheduledTestItem,
  type ScheduledTestRunWithItems,
} from '~/lib/observability/scheduled-test-types';
import type { ReportRunRow } from '~/lib/tests/repository';
import {
  buildThursdayScorecardHighlights,
  buildThursdayScorecardHistory,
  buildThursdayScorecardNotes,
  buildThursdayScorecardSnapshot,
  deriveThursdayScorecardFlags,
  selectThursdayNightSweeps,
} from '~/lib/tests/thursday-scorecard';
import {
  thursdayScorecardHistorySchema,
  thursdayScorecardSnapshotSchema,
  type ThursdayScorecardAgentRow,
  type ThursdayScorecardSupporting,
} from '~/lib/tests/thursday-scorecard-schemas';
import { formatEasternSweepLabel } from '~/lib/utils/time';

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

    // B0-1170: `flags` and `previous.speedScore` legitimately read `supporting`; the content cells do not.
    const strip = (row: (typeof without.agents)[number]) => {
      const { supporting, flags, previous, ...content } = row;
      void supporting;
      void flags;
      void previous;
      return content;
    };
    expect(withSupporting.agents.map(strip)).toEqual(without.agents.map(strip));
    expect(withSupporting.sweep).toEqual(without.sweep);
    expect(withSupporting.previousSweep).toEqual(without.previousSweep);
  });
});

/* -------------------------------------------------------------------------- *
 * B0-1170 — previous, flags, highlights, notes
 * -------------------------------------------------------------------------- */

/** The previous Thursday with the SAME test ids as CURRENT but its own run ids (`prev-<agent>`). */
const PREV = sweep({
  id: 'thu-0917',
  sweep_triggered_at: '2026-09-18T00:00:44Z',
  items: AGENTS.map((agent, index) =>
    child({
      id: `prev-item-${index}`,
      test_id: `cur-${agent}`,
      test_name: `${agent} golden set`,
      test_run_id: `prev-${agent}`,
    }),
  ),
});
const PREV_LABEL = formatEasternSweepLabel(PREV.sweep_triggered_at);

const supportingOf = (
  overrides: Partial<ThursdayScorecardSupporting> = {},
): ThursdayScorecardSupporting => ({
  speedScore: 80.3,
  speedRating: 'Good',
  avgTtftSeconds: 1.2,
  avgTotalSeconds: 8,
  similarityAvg: 0.8,
  evalConfidenceAvg: 90,
  passRate: 85,
  passMark: 75,
  ...overrides,
});

/** A hand-built agent row for the pure highlight / note / flag helpers; `flags` derived unless given. */
const agentRow = (
  overrides: Partial<ThursdayScorecardAgentRow> & Pick<ThursdayScorecardAgentRow, 'agentLabel'>,
): ThursdayScorecardAgentRow => {
  const row: ThursdayScorecardAgentRow = {
    testId: `t-${overrides.agentLabel}`,
    testName: overrides.agentLabel,
    intendedAgent: null,
    runId: `r-${overrides.agentLabel}`,
    ledgerStatus: 'completed',
    reportStatus: 'completed',
    score: 90,
    grade: 'A',
    failCount: 2,
    change: null,
    modelTag: null,
    appVersion: null,
    averageTtftMs: null,
    averageElapsedMs: null,
    conceptPercent: null,
    supporting: supportingOf(),
    previous: null,
    flags: [],
    ...overrides,
  };
  return overrides.flags ? row : { ...row, flags: deriveThursdayScorecardFlags(row) };
};

/** A scored row with a scored previous: `previousScore → score`, previous grade/fails as given. */
const comparedRow = (
  agentLabel: string,
  current: { score: number; grade: ThursdayScorecardAgentRow['grade']; failCount?: number | null },
  previous: {
    score: number;
    grade: ThursdayScorecardAgentRow['grade'];
    failCount?: number | null;
    speedScore?: number | null;
  },
  extra: Partial<ThursdayScorecardAgentRow> = {},
): ThursdayScorecardAgentRow => {
  return agentRow({
    agentLabel,
    score: current.score,
    grade: current.grade,
    failCount: current.failCount === undefined ? 2 : current.failCount,
    change: {
      runId: `r-${agentLabel}`,
      previousRunId: `p-${agentLabel}`,
      previousScore: previous.score,
      deltaPoints: Math.round((current.score - previous.score) * 10) / 10,
      changePercent: null,
    },
    previous: {
      runId: `p-${agentLabel}`,
      score: previous.score,
      grade: previous.grade,
      failCount: previous.failCount === undefined ? 2 : previous.failCount,
      speedScore: previous.speedScore ?? null,
      passRate: null,
    },
    ...extra,
  });
};

describe('B0-1170 — previous', () => {
  const currentRows = byRunId(
    CURRENT.items.map((item) =>
      reportRow({ runId: item.test_run_id!, testId: item.test_id, score: 92.7, grade: 'A' }),
    ),
  );
  const previousRows = byRunId(
    PREV.items.map((item) =>
      reportRow({
        runId: item.test_run_id!,
        testId: item.test_id,
        score: 85,
        grade: 'B',
        failCount: 4,
      }),
    ),
  );

  it('is the same test_id\'s persisted values from the previous sweep, with its speed score and pass rate from the supporting map', () => {
    const supportingByRunId = new Map<string, ThursdayScorecardSupporting | null>([
      ...CURRENT.items.map((item) => [item.test_run_id!, supportingOf()] as const),
      ...PREV.items.map(
        (item) => [item.test_run_id!, supportingOf({ speedScore: 76, passRate: 70 })] as const,
      ),
    ]);
    const snapshot = buildThursdayScorecardSnapshot({
      sweep: CURRENT,
      previousSweep: PREV,
      reportRowsByRunId: currentRows,
      previousReportRowsByRunId: previousRows,
      intendedAgentByTestId: registryLabels,
      supportingByRunId,
    });
    expect(snapshot.agents[0].previous).toEqual({
      runId: 'prev-dilution',
      score: 85,
      grade: 'B',
      failCount: 4,
      speedScore: 76,
      passRate: 70,
    });
    expect(snapshot.agents[0].change).toMatchObject({ previousRunId: 'prev-dilution', deltaPoints: 7.7 });
    expect(thursdayScorecardSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('has null speedScore / passRate when the supporting map was not read', () => {
    const snapshot = buildThursdayScorecardSnapshot({
      sweep: CURRENT,
      previousSweep: PREV,
      reportRowsByRunId: currentRows,
      previousReportRowsByRunId: previousRows,
      intendedAgentByTestId: registryLabels,
    });
    expect(snapshot.agents.every((row) => row.previous?.score === 85)).toBe(true);
    expect(snapshot.agents.every((row) => row.previous?.speedScore === null)).toBe(true);
    expect(snapshot.agents.every((row) => row.previous?.passRate === null)).toBe(true);
  });

  it('is null when there is no previous sweep, and when the dataset was re-seeded (different test_id)', () => {
    const none = buildThursdayScorecardSnapshot({
      sweep: CURRENT,
      previousSweep: null,
      reportRowsByRunId: currentRows,
      previousReportRowsByRunId: new Map(),
      intendedAgentByTestId: registryLabels,
    });
    expect(none.agents.every((row) => row.previous === null)).toBe(true);

    const reseeded = sweep({
      id: 'thu-0917',
      sweep_triggered_at: '2026-09-18T00:00:44Z',
      items: fiveChildren('old'),
    });
    const different = buildThursdayScorecardSnapshot({
      sweep: CURRENT,
      previousSweep: reseeded,
      reportRowsByRunId: currentRows,
      previousReportRowsByRunId: byRunId(
        reseeded.items.map((item) => reportRow({ runId: item.test_run_id!, testId: item.test_id })),
      ),
      intendedAgentByTestId: registryLabels,
    });
    expect(different.agents.every((row) => row.previous === null)).toBe(true);
  });

  it('is present but unscored when last week\'s run exists without a score (report failed) or never got a run', () => {
    const previousSweep = sweep({
      id: 'thu-0917',
      sweep_triggered_at: '2026-09-18T00:00:44Z',
      items: [
        child({ id: 'p-0', test_id: 'cur-dilution', test_name: 'dilution', test_run_id: 'prev-dilution' }),
        child({ id: 'p-1', test_id: 'cur-product', test_name: 'product', test_run_id: null, status: 'failed' }),
      ],
    });
    const snapshot = buildThursdayScorecardSnapshot({
      sweep: CURRENT,
      previousSweep,
      reportRowsByRunId: currentRows,
      previousReportRowsByRunId: byRunId([
        reportRow({
          runId: 'prev-dilution',
          testId: 'cur-dilution',
          reportStatus: 'failed',
          score: null,
          grade: null,
          failCount: 3,
        }),
      ]),
      intendedAgentByTestId: registryLabels,
    });
    const byTest = new Map(snapshot.agents.map((row) => [row.testId, row]));
    expect(byTest.get('cur-dilution')?.previous).toEqual({
      runId: 'prev-dilution',
      score: null,
      grade: null,
      failCount: 3,
      speedScore: null,
      passRate: null,
    });
    expect(byTest.get('cur-dilution')?.change).toBeNull();
    expect(byTest.get('cur-product')?.previous).toEqual({
      runId: null,
      score: null,
      grade: null,
      failCount: null,
      speedScore: null,
      passRate: null,
    });
    expect(byTest.get('cur-bathroom')?.previous).toBeNull();
  });
});

describe('B0-1170 — flags', () => {
  const downChange = { runId: 'r', previousRunId: 'p', previousScore: 90, deltaPoints: -2.5, changePercent: -2.8 };
  const upChange = { ...downChange, deltaPoints: 1, changePercent: 1.1 };
  const prev = (speedScore: number | null) => ({
    runId: 'p',
    score: 90,
    grade: 'A' as const,
    failCount: 2,
    speedScore,
    passRate: null,
  });

  it('not_scored fires exactly when score is null', () => {
    expect(deriveThursdayScorecardFlags(agentRow({ agentLabel: 'a', score: null, grade: null }))).toEqual([
      'not_scored',
    ]);
    expect(deriveThursdayScorecardFlags(agentRow({ agentLabel: 'a', score: 0, grade: 'F' }))).not.toContain(
      'not_scored',
    );
  });

  it('now_failing fires for D and F only', () => {
    for (const grade of ['D', 'F'] as const) {
      expect(deriveThursdayScorecardFlags(agentRow({ agentLabel: 'a', score: 60, grade }))).toContain(
        'now_failing',
      );
    }
    for (const grade of ['A', 'B', 'C', '-', null] as const) {
      expect(deriveThursdayScorecardFlags(agentRow({ agentLabel: 'a', score: 60, grade }))).not.toContain(
        'now_failing',
      );
    }
  });

  it('content_down_speed_up needs a negative change AND both speed scores AND a higher current speed', () => {
    const fires = agentRow({
      agentLabel: 'a',
      score: 87.5,
      change: downChange,
      supporting: supportingOf({ speedScore: 80.3 }),
      previous: prev(76),
    });
    expect(deriveThursdayScorecardFlags(fires)).toEqual(['content_down_speed_up']);

    expect(deriveThursdayScorecardFlags({ ...fires, change: upChange })).toEqual([]);
    expect(deriveThursdayScorecardFlags({ ...fires, change: null })).toEqual([]);
    // A sub-point dip is grading noise, not "answering less well"; a full point is the floor.
    expect(
      deriveThursdayScorecardFlags({ ...fires, change: { ...downChange, deltaPoints: -0.9 } }),
    ).toEqual([]);
    expect(
      deriveThursdayScorecardFlags({ ...fires, change: { ...downChange, deltaPoints: -1 } }),
    ).toEqual(['content_down_speed_up']);
    expect(deriveThursdayScorecardFlags({ ...fires, previous: prev(80.3) })).toEqual([]);
    expect(deriveThursdayScorecardFlags({ ...fires, previous: prev(81) })).toEqual([]);
    expect(deriveThursdayScorecardFlags({ ...fires, previous: prev(null) })).toEqual([]);
    expect(deriveThursdayScorecardFlags({ ...fires, previous: null })).toEqual([]);
    expect(
      deriveThursdayScorecardFlags({ ...fires, supporting: supportingOf({ speedScore: null }) }),
    ).toEqual([]);
  });

  it('metrics_unreported fires for a scored row with no supporting block or an all-null one, never for an unscored row', () => {
    expect(deriveThursdayScorecardFlags(agentRow({ agentLabel: 'a', supporting: null }))).toEqual([
      'metrics_unreported',
    ]);
    expect(
      deriveThursdayScorecardFlags(
        agentRow({
          agentLabel: 'a',
          supporting: supportingOf({
            speedScore: null,
            avgTtftSeconds: null,
            similarityAvg: null,
            evalConfidenceAvg: null,
          }),
        }),
      ),
    ).toEqual(['metrics_unreported']);
    expect(
      deriveThursdayScorecardFlags(
        agentRow({
          agentLabel: 'a',
          supporting: supportingOf({ speedScore: null, avgTtftSeconds: null, similarityAvg: null }),
        }),
      ),
    ).toEqual([]);
    expect(
      deriveThursdayScorecardFlags(agentRow({ agentLabel: 'a', score: null, grade: null, supporting: null })),
    ).toEqual(['not_scored']);
  });

  it('keeps the fixed order not_scored, now_failing, content_down_speed_up, metrics_unreported', () => {
    expect(
      deriveThursdayScorecardFlags(
        agentRow({
          agentLabel: 'a',
          score: 58,
          grade: 'F',
          change: downChange,
          supporting: supportingOf({ speedScore: 80.3 }),
          previous: prev(76),
        }),
      ),
    ).toEqual(['now_failing', 'content_down_speed_up']);
    expect(
      deriveThursdayScorecardFlags(agentRow({ agentLabel: 'a', score: 58, grade: 'D', supporting: null })),
    ).toEqual(['now_failing', 'metrics_unreported']);
  });

  it('the builder stamps flags on every row', () => {
    const snapshot = buildThursdayScorecardSnapshot({
      sweep: CURRENT,
      previousSweep: null,
      reportRowsByRunId: byRunId([
        reportRow({ runId: 'run-cur-dilution', testId: 'cur-dilution', score: 55, grade: 'F' }),
        reportRow({ runId: 'run-cur-product', testId: 'cur-product', reportStatus: 'failed', score: null, grade: null }),
      ]),
      previousReportRowsByRunId: new Map(),
      intendedAgentByTestId: registryLabels,
    });
    expect(snapshot.agents.map((row) => row.flags)).toEqual([
      ['now_failing', 'metrics_unreported'],
      ['not_scored'],
      ['not_scored'],
      ['not_scored'],
      ['not_scored'],
    ]);
  });
});

describe('B0-1170 — highlights', () => {
  it('(a) a failing agent with a previous score: dropped from …, failures rising / falling / unchanged', () => {
    const rising = comparedRow('Product', { score: 58.2, grade: 'F', failCount: 11 }, { score: 72.5, grade: 'C', failCount: 7 });
    const falling = comparedRow('Dilution', { score: 61, grade: 'D', failCount: 7 }, { score: 70, grade: 'C', failCount: 11 });
    const unchanged = comparedRow('Bathroom', { score: 60, grade: 'D', failCount: 7 }, { score: 70, grade: 'C', failCount: 7 });
    const best = agentRow({ agentLabel: 'Floor', score: 95, grade: 'A', failCount: null });
    const highlights = buildThursdayScorecardHighlights([rising, falling, unchanged, best]);
    expect(highlights.slice(0, 3)).toEqual([
      'Product dropped from C/72.5 to F/58.2 with failures rising 7 → 11.',
      'Dilution dropped from C/70 to D/61 with failures falling 11 → 7.',
      'Bathroom dropped from C/70 to D/60 with failures unchanged at 7.',
    ]);
  });

  it('(a) omits the failures clause when either count is null, and says "still failing" when the score did not fall', () => {
    const noFails = comparedRow('Product', { score: 58.2, grade: 'F', failCount: null }, { score: 72.5, grade: 'C', failCount: 7 });
    const other = agentRow({ agentLabel: 'Floor', score: 95, grade: 'A' });
    expect(buildThursdayScorecardHighlights([noFails, other])[0]).toBe(
      'Product dropped from C/72.5 to F/58.2 — the only agent now failing.',
    );
    const stillFailing = comparedRow('Product', { score: 62, grade: 'D', failCount: 9 }, { score: 60, grade: 'D', failCount: 9 });
    expect(buildThursdayScorecardHighlights([stillFailing, other])[0]).toBe(
      'Product is still failing, D/60 → D/62 with failures unchanged at 9 — the only agent now failing.',
    );
  });

  it('(a) a failing agent without a previous score, singular / plural, and the "only agent now failing" suffix', () => {
    const one = agentRow({ agentLabel: 'Product', score: 64, grade: 'D', failCount: 1 });
    const other = agentRow({ agentLabel: 'Floor', score: 95, grade: 'A' });
    expect(buildThursdayScorecardHighlights([one, other])[0]).toBe(
      'Product is failing at D/64 with 1 failed question — the only agent now failing.',
    );
    const two = agentRow({ agentLabel: 'Dilution', score: 50.5, grade: 'F', failCount: 5 });
    expect(buildThursdayScorecardHighlights([one, two, other]).slice(0, 2)).toEqual([
      'Product is failing at D/64 with 1 failed question.',
      'Dilution is failing at F/50.5 with 5 failed questions.',
    ]);
    const noFails = agentRow({ agentLabel: 'Product', score: 64, grade: 'D', failCount: null });
    expect(buildThursdayScorecardHighlights([noFails, other])[0]).toBe(
      'Product is failing at D/64 — the only agent now failing.',
    );
  });

  it('(b) the largest gain, grade change or unchanged, ties to the first row', () => {
    const small = comparedRow('Bathroom', { score: 89.1, grade: 'B' }, { score: 88, grade: 'B' });
    const big = comparedRow('Dilution', { score: 92.7, grade: 'A' }, { score: 90.1, grade: 'B' });
    const tie = comparedRow('Product', { score: 80.6, grade: 'B' }, { score: 78, grade: 'C' });
    expect(buildThursdayScorecardHighlights([small, big, tie])[0]).toBe(
      'Dilution improved 90.1 → 92.7 (B → A), the largest gain this week.',
    );
    const same = comparedRow('Dilution', { score: 92.7, grade: 'A' }, { score: 90.1, grade: 'A' });
    expect(buildThursdayScorecardHighlights([small, same])[0]).toBe(
      'Dilution improved 90.1 → 92.7 (A, unchanged), the largest gain this week.',
    );
  });

  it('(c) the largest drop, skipping an agent already reported as failing', () => {
    const failing = comparedRow('Product', { score: 58.2, grade: 'F', failCount: 11 }, { score: 72.5, grade: 'C', failCount: 7 });
    const slip = comparedRow('Bathroom', { score: 88.1, grade: 'B' }, { score: 89.3, grade: 'B' });
    const slipMore = comparedRow('Dilution', { score: 84, grade: 'B' }, { score: 90.1, grade: 'A' });
    const highlights = buildThursdayScorecardHighlights([failing, slip, slipMore]);
    expect(highlights[1]).toBe('Dilution slipped 90.1 → 84 (A → B).');
    expect(highlights.filter((h) => h.includes('slipped'))).toHaveLength(1);
    expect(buildThursdayScorecardHighlights([slip])[0]).toBe('Bathroom slipped 89.3 → 88.1 (B, unchanged).');
  });

  it('(d) "faster, not better" for every content_down_speed_up agent', () => {
    const diverging = comparedRow(
      'Bathroom',
      { score: 88.1, grade: 'B' },
      { score: 89.3, grade: 'B', speedScore: 76 },
      { supporting: supportingOf({ speedScore: 80.3 }) },
    );
    expect(diverging.flags).toContain('content_down_speed_up');
    const highlights = buildThursdayScorecardHighlights([diverging]);
    expect(highlights).toContain(
      "Bathroom's content score slipped 89.3 → 88.1 while its speed score improved 76 → 80.3 — faster, not better.",
    );
  });

  it('(e) the best performer, with or without a fail count, ties to the first row', () => {
    const a = agentRow({ agentLabel: 'Dilution', score: 92.7, grade: 'A', failCount: 2 });
    const b = agentRow({ agentLabel: 'Product', score: 92.7, grade: 'A', failCount: 1 });
    const c = agentRow({ agentLabel: 'Bathroom', score: 80, grade: 'B', failCount: 1 });
    expect(buildThursdayScorecardHighlights([c, a, b])).toEqual([
      'Dilution is the best performer at A/92.7 with 2 failed questions.',
    ]);
    expect(buildThursdayScorecardHighlights([agentRow({ agentLabel: 'Product', score: 70, grade: 'C', failCount: 1 })])).toEqual([
      'Product is the best performer at C/70 with 1 failed question.',
    ]);
    expect(buildThursdayScorecardHighlights([agentRow({ agentLabel: 'Product', score: 70, grade: 'C', failCount: null })])).toEqual([
      'Product is the best performer at C/70.',
    ]);
  });

  it('(f) not-scored agents are listed with their Score-cell state, lowercased', () => {
    const scored = agentRow({ agentLabel: 'Dilution', score: 92.7, grade: 'A', failCount: 2 });
    const failed = agentRow({ agentLabel: 'Bathroom', score: null, grade: null, ledgerStatus: 'failed', runId: null, reportStatus: null, flags: ['not_scored'] });
    const timedOut = agentRow({ agentLabel: 'Floor', score: null, grade: null, ledgerStatus: 'timed_out', reportStatus: null, flags: ['not_scored'] });
    const scoring = agentRow({ agentLabel: 'Product', score: null, grade: null, reportStatus: 'scoring', flags: ['not_scored'] });
    const idle = agentRow({ agentLabel: 'Wood', score: null, grade: null, reportStatus: 'idle', flags: ['not_scored'] });
    expect(buildThursdayScorecardHighlights([scored, failed, timedOut, scoring, idle])).toEqual([
      'Dilution is the best performer at A/92.7 with 2 failed questions.',
      'Not scored this sweep: Bathroom (failed), Floor (timed out), Product (scoring…), Wood (not started).',
    ]);
  });

  it('when no agent has a score, the only highlight names them all with their state', () => {
    const snapshot = buildThursdayScorecardSnapshot({
      sweep: sweep({
        id: 'thu-1001',
        sweep_triggered_at: '2026-10-02T00:00:46Z',
        items: fiveChildren('new', 'failed'),
      }),
      previousSweep: null,
      reportRowsByRunId: new Map(),
      previousReportRowsByRunId: new Map(),
      intendedAgentByTestId: new Map(),
    });
    expect(snapshot.highlights).toEqual([
      'No agent produced a score in this sweep: dilution golden set (failed), product golden set (failed), ' +
        'bathroom golden set (failed), floor_vct golden set (failed), floor_wood_sport golden set (failed).',
    ]);
  });

  it('keeps the priority order and caps at six', () => {
    const rows = [
      comparedRow('F1', { score: 58, grade: 'F', failCount: 11 }, { score: 72, grade: 'C', failCount: 7 }),
      comparedRow('F2', { score: 60, grade: 'D', failCount: 3 }, { score: 72, grade: 'C', failCount: 3 }),
      comparedRow('Gain', { score: 92.7, grade: 'A' }, { score: 90.1, grade: 'B' }),
      comparedRow('Slip', { score: 84, grade: 'B' }, { score: 90.1, grade: 'A', speedScore: 70 }, { supporting: supportingOf({ speedScore: 75 }) }),
      agentRow({ agentLabel: 'None', score: null, grade: null, ledgerStatus: 'failed', runId: null, reportStatus: null, flags: ['not_scored'] }),
    ];
    const highlights = buildThursdayScorecardHighlights(rows);
    expect(highlights).toHaveLength(6);
    expect(highlights).toEqual([
      'F1 dropped from C/72 to F/58 with failures rising 7 → 11.',
      'F2 dropped from C/72 to D/60 with failures unchanged at 3.',
      'Gain improved 90.1 → 92.7 (B → A), the largest gain this week.',
      'Slip slipped 90.1 → 84 (A → B).',
      "Slip's content score slipped 90.1 → 84 while its speed score improved 70 → 75 — faster, not better.",
      'Gain is the best performer at A/92.7 with 2 failed questions.',
    ]);
  });
});

describe('B0-1170 — notes', () => {
  const scored = agentRow({ agentLabel: 'Dilution', score: 92.7, grade: 'A' });
  const previousSweep = { id: PREV.id, sweepTriggeredAt: PREV.sweep_triggered_at };

  it('states the baseline: none, or the previous sweep\'s Eastern label', () => {
    expect(buildThursdayScorecardNotes({ previousSweep: null, agents: [scored] })).toEqual([
      'No earlier Thursday-night sweep, so Change and trend indicators are not available.',
    ]);
    const compared = comparedRow('Dilution', { score: 92.7, grade: 'A' }, { score: 90, grade: 'A' });
    expect(buildThursdayScorecardNotes({ previousSweep, agents: [compared] })).toEqual([
      `Change and trend indicators compare against the previous Thursday-night sweep, ${PREV_LABEL}.`,
    ]);
  });

  it('lists first appearances only when a previous sweep exists', () => {
    const second = agentRow({ agentLabel: 'Product', score: 80, grade: 'B' });
    const unscored = agentRow({ agentLabel: 'Floor', score: null, grade: null, reportStatus: 'failed', flags: ['not_scored'] });
    expect(buildThursdayScorecardNotes({ previousSweep, agents: [scored, second, unscored] })[1]).toBe(
      'First appearance in a Thursday-night sweep (no prior run of the same dataset): Dilution, Product.',
    );
    expect(buildThursdayScorecardNotes({ previousSweep: null, agents: [scored, second] })).toHaveLength(1);
  });

  it('lists not-scored agents with their state, unreported metrics, and unscored previous runs', () => {
    const failed = agentRow({ agentLabel: 'Bathroom', score: null, grade: null, ledgerStatus: 'failed', runId: null, reportStatus: null, flags: ['not_scored'] });
    const scoring = agentRow({ agentLabel: 'Floor', score: null, grade: null, reportStatus: 'scoring', flags: ['not_scored'] });
    const unreported = agentRow({ agentLabel: 'Product', supporting: null, flags: ['metrics_unreported'] });
    const prevUnscored = agentRow({
      agentLabel: 'Wood',
      previous: { runId: 'p', score: null, grade: null, failCount: null, speedScore: null, passRate: null },
    });
    const notes = buildThursdayScorecardNotes({
      previousSweep: null,
      agents: [failed, scoring, unreported, prevUnscored],
    });
    expect(notes).toEqual([
      'No earlier Thursday-night sweep, so Change and trend indicators are not available.',
      'Not scored in this sweep, shown as their state rather than zero: Bathroom (failed), Floor (scoring…).',
      'Supporting metrics not reported in the source evaluation, shown as —: Product (speed score, avg TTFT, similarity, evaluator confidence).',
      'Trend not available because the previous Thursday-night run was not scored: Wood.',
    ]);
  });

  it('the builder produces identical highlights and notes on two calls (deterministic)', () => {
    const input = {
      sweep: CURRENT,
      previousSweep: PREV,
      reportRowsByRunId: byRunId([
        reportRow({ runId: 'run-cur-dilution', testId: 'cur-dilution', score: 92.7, grade: 'A', failCount: 2 }),
        reportRow({ runId: 'run-cur-product', testId: 'cur-product', score: 58.2, grade: 'F', failCount: 11 }),
        reportRow({ runId: 'run-cur-bathroom', testId: 'cur-bathroom', score: 88.1, grade: 'B', failCount: 5 }),
        reportRow({ runId: 'run-cur-floor_vct', testId: 'cur-floor_vct', reportStatus: 'failed', score: null, grade: null }),
      ]),
      previousReportRowsByRunId: byRunId([
        reportRow({ runId: 'prev-dilution', testId: 'cur-dilution', score: 90.1, grade: 'B', failCount: 4 }),
        reportRow({ runId: 'prev-product', testId: 'cur-product', score: 72.5, grade: 'C', failCount: 7 }),
        reportRow({ runId: 'prev-bathroom', testId: 'cur-bathroom', score: 89.3, grade: 'B', failCount: 5 }),
        reportRow({ runId: 'prev-floor_vct', testId: 'cur-floor_vct', reportStatus: 'failed', score: null, grade: null }),
      ]),
      intendedAgentByTestId: registryLabels,
      supportingByRunId: new Map<string, ThursdayScorecardSupporting | null>([
        ['run-cur-dilution', supportingOf()],
        ['run-cur-product', supportingOf({ speedScore: 70 })],
        ['run-cur-bathroom', supportingOf({ speedScore: 80.3 })],
        ['prev-dilution', supportingOf({ speedScore: 78 })],
        ['prev-product', supportingOf({ speedScore: 71 })],
        ['prev-bathroom', supportingOf({ speedScore: 76 })],
      ]),
    };
    const first = buildThursdayScorecardSnapshot(input);
    const second = buildThursdayScorecardSnapshot(input);
    expect(second.highlights).toEqual(first.highlights);
    expect(second.notes).toEqual(first.notes);
    expect(first.highlights).toEqual([
      'Betco Product Specialist dropped from C/72.5 to F/58.2 with failures rising 7 → 11 — the only agent now failing.',
      'Dilution Control Specialist improved 90.1 → 92.7 (B → A), the largest gain this week.',
      'Bathroom specialist slipped 89.3 → 88.1 (B, unchanged).',
      "Bathroom specialist's content score slipped 89.3 → 88.1 while its speed score improved 76 → 80.3 — faster, not better.",
      'Dilution Control Specialist is the best performer at A/92.7 with 2 failed questions.',
      'Not scored this sweep: VCT & Resilient Tile Floor Care Specialist (failed), Wood/Sport Floor Care Specialist (—).',
    ]);
    expect(first.notes).toEqual([
      `Change and trend indicators compare against the previous Thursday-night sweep, ${PREV_LABEL}.`,
      'Not scored in this sweep, shown as their state rather than zero: VCT & Resilient Tile Floor Care Specialist (failed), Wood/Sport Floor Care Specialist (—).',
      'Trend not available because the previous Thursday-night run was not scored: VCT & Resilient Tile Floor Care Specialist, Wood/Sport Floor Care Specialist.',
    ]);
    expect(thursdayScorecardSnapshotSchema.safeParse(first).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * B0-1170 — buildThursdayScorecardHistory
 * -------------------------------------------------------------------------- */

describe('buildThursdayScorecardHistory', () => {
  const newest = sweep({
    id: 'thu-1001',
    sweep_triggered_at: '2026-10-02T00:00:46Z',
    items: [
      child({ id: 'n-0', test_id: 'cur-product', test_name: 'Product golden set', test_run_id: 'n-product' }),
      child({ id: 'n-1', test_id: 'cur-dilution', test_name: 'Dilution golden set', test_run_id: 'n-dilution' }),
      child({ id: 'n-2', test_id: 't-floor-vct', test_name: 'Floor (VCT) golden set', test_run_id: 'n-vct' }),
    ],
  });
  const middle = sweep({
    id: 'thu-0924',
    sweep_triggered_at: '2026-09-25T00:00:50Z',
    items: [
      child({ id: 'm-0', test_id: 'cur-product', test_name: 'Product golden set', test_run_id: 'm-product' }),
      child({ id: 'm-1', test_id: 'cur-dilution', test_name: 'Dilution golden set', test_run_id: null, status: 'failed' }),
      child({ id: 'm-2', test_id: 't-floor-vct', test_name: 'Floor (VCT) golden set', test_run_id: 'm-vct' }),
    ],
  });
  const oldest = sweep({
    id: 'thu-0917',
    sweep_triggered_at: '2026-09-18T00:00:44Z',
    items: [
      child({ id: 'o-0', test_id: 'old-product', test_name: 'Product golden set', test_run_id: 'o-product' }),
      child({ id: 'o-1', test_id: 't-floor-vct', test_name: 'Floor (VCT) golden set', test_run_id: 'o-vct' }),
      child({ id: 'o-2', test_id: 't-floor-wood', test_name: 'Floor (Wood) golden set', test_run_id: 'o-wood' }),
    ],
  });
  const reportRowsByRunId = byRunId([
    reportRow({ runId: 'n-product', testId: 'cur-product', score: 80, grade: 'B', failCount: 4 }),
    reportRow({ runId: 'n-dilution', testId: 'cur-dilution', score: 92.7, grade: 'A' }),
    reportRow({ runId: 'n-vct', testId: 't-floor-vct', score: 70, grade: 'C' }),
    reportRow({ runId: 'm-product', testId: 'cur-product', score: 78, grade: 'C' }),
    reportRow({ runId: 'm-vct', testId: 't-floor-vct', score: 75, grade: 'C' }),
    reportRow({ runId: 'o-product', testId: 'old-product', score: 60, grade: 'D' }),
    reportRow({ runId: 'o-vct', testId: 't-floor-vct', score: 72, grade: 'C' }),
    reportRow({ runId: 'o-wood', testId: 't-floor-wood', score: 88, grade: 'B' }),
  ]);
  const intendedAgentByTestId = new Map<string, string | null>([
    ['cur-product', 'product'],
    ['cur-dilution', 'dilution'],
    ['old-product', 'product'],
    ['t-floor-vct', 'floor'],
    ['t-floor-wood', 'floor'],
  ]);
  const history = buildThursdayScorecardHistory({
    sweeps: [newest, middle, oldest],
    reportRowsByRunId,
    intendedAgentByTestId,
  });

  it('parses with the schema and has one row per sweep, newest first, each naming the next older sweep', () => {
    expect(thursdayScorecardHistorySchema.safeParse(history).success).toBe(true);
    expect(history.rows.map((row) => row.sweep.id)).toEqual(['thu-1001', 'thu-0924', 'thu-0917']);
    expect(history.rows.map((row) => row.previousSweep?.id ?? null)).toEqual(['thu-0924', 'thu-0917', null]);
    expect(history.rows.map((row) => row.scoredCount)).toEqual([3, 2, 3]);
  });

  it('chains change per test_id down the sweeps with the snapshot arithmetic; a re-seeded id or unscored previous → null', () => {
    const [n, m, o] = history.rows;
    expect(n.cells.map((cell) => cell.testId)).toEqual(['cur-product', 'cur-dilution', 't-floor-vct']);
    expect(n.cells[0].change).toEqual({
      runId: 'n-product',
      previousRunId: 'm-product',
      previousScore: 78,
      deltaPoints: 2,
      changePercent: 2.6,
    });
    expect(n.cells[1].change).toBeNull(); // previous run never happened (child failed)
    expect(n.cells[2].change).toMatchObject({ previousRunId: 'm-vct', deltaPoints: -5 });
    expect(m.cells[0].change).toBeNull(); // oldest has a different test_id for Product
    expect(m.cells[1]).toMatchObject({ runId: null, ledgerStatus: 'failed', score: null, grade: null });
    expect(m.cells[2].change).toMatchObject({ previousRunId: 'o-vct', deltaPoints: 3 });
    expect(o.cells.every((cell) => cell.change === null)).toBe(true);
    expect(n.cells[0]).toMatchObject({ score: 80, grade: 'B', failCount: 4, reportStatus: 'completed' });
  });

  it('keys columns by registry id, falls back to testName for the retired "floor" id, in first-seen order from the newest', () => {
    expect(history.rows[0].cells.map((cell) => cell.agentKey)).toEqual([
      'product',
      'dilution',
      'Floor (VCT) golden set',
    ]);
    expect(history.rows[2].cells.map((cell) => cell.agentKey)).toEqual([
      'product',
      'Floor (VCT) golden set',
      'Floor (Wood) golden set',
    ]);
    expect(history.agentColumns).toEqual([
      { key: 'product', label: 'Betco Product Specialist' },
      { key: 'dilution', label: 'Dilution Control Specialist' },
      { key: 'Floor (VCT) golden set', label: 'Floor (VCT) golden set' },
      { key: 'Floor (Wood) golden set', label: 'Floor (Wood) golden set' },
    ]);
  });

  it('keeps only active golden sets when given, dropping a Thursday that ran none of them', () => {
    const active = buildThursdayScorecardHistory({
      sweeps: [newest, middle, oldest],
      reportRowsByRunId,
      intendedAgentByTestId,
      activeGoldenTestIds: new Set(['cur-product', 'cur-dilution']),
    });
    expect(thursdayScorecardHistorySchema.safeParse(active).success).toBe(true);
    expect(active.rows.map((row) => row.sweep.id)).toEqual(['thu-1001', 'thu-0924']);
    expect(active.rows[0].cells.map((cell) => cell.testId)).toEqual(['cur-product', 'cur-dilution']);
    expect(active.rows.map((row) => row.scoredCount)).toEqual([2, 1]);
    expect(active.agentColumns.map((column) => column.key)).toEqual(['product', 'dilution']);
  });

  it('is empty, and still valid, with no sweeps', () => {
    const empty = buildThursdayScorecardHistory({
      sweeps: [],
      reportRowsByRunId: new Map(),
      intendedAgentByTestId: new Map(),
    });
    expect(empty).toEqual({ rows: [], agentColumns: [] });
  });
});
