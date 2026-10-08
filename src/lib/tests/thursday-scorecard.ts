import { V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import { listRecentScheduledTestRuns } from '~/lib/observability/scheduled-test-repository';
import {
  CRON_SWEEP_NAME,
  getRunDisplayCounts,
  getRunDisplayStatus,
  type ScheduledTestRunWithItems,
} from '~/lib/observability/scheduled-test-types';
import { loadReportData } from '~/lib/tests/report/assemble';
import { calculateConceptPercentage } from '~/lib/tests/report-row-format';
import { roundToTenth } from '~/lib/tests/report-trend';
import {
  listReportRunRowsByIds,
  listTestAgentsByIds,
  type ReportRunRow,
} from '~/lib/tests/repository';
import {
  thursdayScorecardPageDataSchema,
  type ThursdayScorecardAgentRow,
  type ThursdayScorecardChange,
  type ThursdayScorecardPageData,
  type ThursdayScorecardSnapshot,
  type ThursdayScorecardSupporting,
  type ThursdayScorecardSweep,
  type ThursdayScorecardSweepOption,
} from '~/lib/tests/thursday-scorecard-schemas';
import { easternDateKey, easternWeekday } from '~/lib/utils/time';

/**
 * B0-1166 (epic B0-1165) — the Thursday-night scorecard: which cron sweep ran Thursday night,
 * what each golden agent scored in it, and how that compares with the Thursday before.
 *
 * Same split as `~/lib/tests/golden-report-score-trend.ts`: the selection rule and the fold are
 * pure (unit-tested without a database); I/O happens only at the edge in `loadThursdayScorecard`.
 *
 * Sources, and what is deliberately NOT a source:
 * - Which sweeps ran: the ledger (`scheduled_test_runs` + children) via
 *   `listRecentScheduledTestRuns`, scoped to the cron's `sweep_name` and `run_mode = 'full'`.
 * - Score / grade / fails / model / version / timings: `test_results` through
 *   `listReportRunRowsByIds` — the SAME mapping the "Reports" table uses, so a scorecard row and
 *   the matching "Reports" row can never disagree. `scheduled_test_items.grade` / `.confidence`
 *   are NULL on every live row (B0-1169) and are never read.
 * - Agent label: `tests.intended_agent` → `V1_AGENT_REGISTRY` label; a retired id (the archived
 *   sets still carry `floor`, split in B0-746) or a null falls back to the ledger's `test_name`.
 */

const THURSDAY = 4;

/**
 * ONE-PER-THURSDAY RULE. A sweep counts as "the Thursday-night sweep" when ALL of these hold:
 * 1. `sweep_name === CRON_SWEEP_NAME` and `run_mode === 'full'` — the nightly cron, not a manual
 *    "Run Golden" sweep and not a partial re-run.
 * 2. Its `sweep_triggered_at` is a Thursday in America/New_York (`easternWeekday`). The cron is
 *    `0 0 * * *` UTC, i.e. Thursday 8:00 PM EDT / 7:00 PM EST, which is a FRIDAY UTC date — so the
 *    weekday must be asked in Eastern, never from the UTC date.
 * 3. Its UTC hour is 0 — the cron's nominal 00:00–00:59 UTC firing window. 00:xx UTC is Thursday
 *    evening in Eastern under both EST and EDT, so this is DST-proof, and it excludes the daytime
 *    re-triggers that reuse the cron's sweep name (four of them on Thu 2026-10-01 alone).
 * 4. When more than one sweep falls inside that window on the same Eastern date (the cron has
 *    double-fired: 2026-10-01 00:00:34 and 00:00:45 UTC), the EARLIEST wins — that is the
 *    scheduled firing; anything later is a retry.
 * Result is newest first, one entry per Thursday.
 */
export function selectThursdayNightSweeps(
  runs: readonly ScheduledTestRunWithItems[],
): ScheduledTestRunWithItems[] {
  const earliestByEasternDate = new Map<string, ScheduledTestRunWithItems>();
  for (const run of runs) {
    if (run.sweep_name !== CRON_SWEEP_NAME || run.run_mode !== 'full') continue;
    const triggeredAt = Date.parse(run.sweep_triggered_at);
    if (!Number.isFinite(triggeredAt)) continue;
    if (easternWeekday(triggeredAt) !== THURSDAY) continue;
    if (new Date(triggeredAt).getUTCHours() !== 0) continue;

    const key = easternDateKey(triggeredAt);
    const existing = earliestByEasternDate.get(key);
    if (!existing || triggeredAt < Date.parse(existing.sweep_triggered_at)) {
      earliestByEasternDate.set(key, run);
    }
  }
  return [...earliestByEasternDate.values()].sort(
    (a, b) => Date.parse(b.sweep_triggered_at) - Date.parse(a.sweep_triggered_at),
  );
}

/** Registry label for a known agent id; otherwise the dataset name the ledger recorded. Never blank. */
function resolveAgentLabel(intendedAgent: string | null, testName: string): string {
  const entry = V1_AGENT_REGISTRY.find((agent) => agent.id === intendedAgent);
  return entry?.label ?? testName;
}

/**
 * The sweep summary uses the display derivations from `/admin/scheduled` (B0-1107): the stored
 * parent status and counts are written at dispatch and only closed out by the hourly reconciler,
 * so the children are the truer picture.
 */
function toScorecardSweep(run: ScheduledTestRunWithItems): ThursdayScorecardSweep {
  const counts = getRunDisplayCounts(run);
  return {
    id: run.id,
    sweepTriggeredAt: run.sweep_triggered_at,
    status: getRunDisplayStatus(run),
    totalTests: run.items.length > 0 ? run.items.length : run.total_tests,
    successfulTests: counts.successful,
    failedTests: counts.failed,
    timedOutTests: counts.timedOut,
  };
}

function toSweepOption(run: ScheduledTestRunWithItems): ThursdayScorecardSweepOption {
  return {
    sweepId: run.id,
    sweepTriggeredAt: run.sweep_triggered_at,
    status: getRunDisplayStatus(run),
  };
}

export type BuildThursdayScorecardSnapshotInput = {
  sweep: ScheduledTestRunWithItems;
  /** The next older Thursday-night sweep in the selected list, whatever its date; `null` if none. */
  previousSweep: ScheduledTestRunWithItems | null;
  /** `ReportRunRow` keyed by `runId` for the selected sweep's children. */
  reportRowsByRunId: Map<string, ReportRunRow>;
  /** `ReportRunRow` keyed by `runId` for the previous sweep's children (may be the same map). */
  previousReportRowsByRunId: Map<string, ReportRunRow>;
  /** `tests.intended_agent` keyed by `test_id`; a missing key reads as `null`. */
  intendedAgentByTestId: Map<string, string | null>;
  /** B0-1167 — supporting metrics keyed by `runId`; absent → every row's `supporting` is `null`. */
  supportingByRunId?: Map<string, ThursdayScorecardSupporting | null>;
};

/**
 * Pure fold: one row per child of `sweep`, in the ledger's child order (dispatch order). A child
 * that failed / timed out / was skipped, has no `test_run_id`, or has no report row still yields a
 * row — with `score: null` and whatever status was found — never dropped, never 0.
 *
 * Change = this row's score − the SAME `test_id`'s score in `previousSweep` (both non-null),
 * rounded to one decimal like `buildReportScoreTrend`; `changePercent` is `null` when the previous
 * score is 0. A dataset re-seeded between the two Thursdays has a different `test_id` on each
 * side and therefore no change — that is "no comparison", not "no change".
 */
export function buildThursdayScorecardSnapshot(
  input: BuildThursdayScorecardSnapshotInput,
): ThursdayScorecardSnapshot {
  const {
    sweep,
    previousSweep,
    reportRowsByRunId,
    previousReportRowsByRunId,
    intendedAgentByTestId,
    supportingByRunId,
  } = input;

  const previousScoreByTestId = new Map<string, { runId: string; score: number }>();
  if (previousSweep) {
    for (const item of previousSweep.items) {
      if (!item.test_run_id) continue;
      const row = previousReportRowsByRunId.get(item.test_run_id);
      if (row && row.score !== null && !previousScoreByTestId.has(item.test_id)) {
        previousScoreByTestId.set(item.test_id, { runId: row.runId, score: row.score });
      }
    }
  }

  // Ledger order (created_at ascending) with `id` as the tiebreak: a sweep bulk-inserts its
  // children with one timestamp, so without it the row order would be whatever the heap returned.
  const items = [...sweep.items].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );

  const agents: ThursdayScorecardAgentRow[] = items.map((item) => {
    const row = item.test_run_id ? (reportRowsByRunId.get(item.test_run_id) ?? null) : null;
    const intendedAgent = intendedAgentByTestId.get(item.test_id) ?? null;
    const score = row?.score ?? null;

    let change: ThursdayScorecardChange | null = null;
    const previous = previousScoreByTestId.get(item.test_id);
    if (row && score !== null && previous) {
      change = {
        runId: row.runId,
        previousRunId: previous.runId,
        previousScore: previous.score,
        deltaPoints: roundToTenth(score - previous.score),
        changePercent:
          previous.score === 0
            ? null
            : roundToTenth(((score - previous.score) / previous.score) * 100),
      };
    }

    return {
      testId: item.test_id,
      testName: item.test_name,
      intendedAgent,
      agentLabel: resolveAgentLabel(intendedAgent, item.test_name),
      runId: item.test_run_id,
      ledgerStatus: item.status,
      reportStatus: row?.reportStatus ?? null,
      score,
      grade: row?.grade ?? null,
      failCount: row?.failCount ?? null,
      change,
      modelTag: row?.modelTag ?? null,
      appVersion: row?.appVersion ?? null,
      averageTtftMs: row?.averageTtftMs ?? null,
      averageElapsedMs: row?.averageElapsedMs ?? null,
      conceptPercent: row?.reportState ? calculateConceptPercentage(row.reportState) : null,
      supporting: (row && supportingByRunId?.get(row.runId)) ?? null,
    };
  });

  return {
    sweep: toScorecardSweep(sweep),
    previousSweep: previousSweep
      ? { id: previousSweep.id, sweepTriggeredAt: previousSweep.sweep_triggered_at }
      : null,
    agents,
  };
}

/**
 * B0-1167 — speed / judged roll-ups for the rows whose report completed, read through
 * `loadReportData` (the assembled report, exactly what `/admin/tests/[testId]/runs/[runId]/exec`
 * renders) and never `computeReportMetrics` directly, so the scorecard cannot disagree with the
 * exec summary. Values are copied field for field with no re-rounding.
 *
 * Cost: one full report assembly per completed row — five reads per page load with today's
 * roster, in parallel, uncached. `includeSupporting: false` is the seam to pull if the roster
 * grows or the page gets slow; the export route can then read them on demand instead.
 */
async function loadSupportingByRunId(
  runIds: string[],
): Promise<Map<string, ThursdayScorecardSupporting | null>> {
  const entries = await Promise.all(
    runIds.map(async (runId): Promise<[string, ThursdayScorecardSupporting | null]> => {
      // One unreadable report must not take the whole scorecard down; that row simply shows "—".
      const data = await loadReportData(runId).catch(() => null);
      if (!data || data.status !== 'ready') {
        return [runId, null];
      }
      const { metrics } = data;
      return [
        runId,
        {
          speedScore: metrics.speed?.avgScore ?? null,
          speedRating: metrics.speed?.rating ?? null,
          avgTtftSeconds: metrics.speed?.metrics.ttft?.avgSeconds ?? null,
          avgTotalSeconds: metrics.speed?.metrics.total?.avgSeconds ?? null,
          similarityAvg: metrics.judged?.similarity?.avg ?? null,
          evalConfidenceAvg: metrics.judged?.evalConfidence?.avg ?? null,
          // `reportRateBlockSchema` names the 0–100 pass rate `passPct`.
          passRate: metrics.overall.passPct,
          passMark: metrics.passMark,
        },
      ];
    }),
  );
  return new Map(entries);
}

/**
 * Ledger rows to scan. The cron sweep name is reused by daytime re-triggers (~9 cron-named full
 * sweeps a week today), so 120 rows reach back roughly 12 Thursdays — enough for the picker and
 * for every selectable sweep to have its predecessor in the same list.
 */
const LEDGER_SCAN_LIMIT = 120;

/**
 * B0-1166 — Thursday-night scorecard loader: the requested sweep (or the newest Thursday-night
 * sweep when `sweepId` is absent or unknown) folded against its predecessor, plus the picker's
 * options. Everything crossing from the ledger is validated with the Zod contract on the way out.
 * `snapshot: null` and `sweeps: []` only when no Thursday-night sweep has ever been recorded.
 */
export async function loadThursdayScorecard(input: {
  /** `scheduled_test_runs.id` to render; unknown / absent → the most recent Thursday-night sweep. */
  sweepId?: string | null;
  /** B0-1167 — read each complete report's speed/judged metrics (one `loadReportData` per row). */
  includeSupporting?: boolean;
}): Promise<ThursdayScorecardPageData> {
  const runs = await listRecentScheduledTestRuns({
    sweepName: CRON_SWEEP_NAME,
    runMode: 'full',
    limit: LEDGER_SCAN_LIMIT,
  });
  const thursdays = selectThursdayNightSweeps(runs);
  if (thursdays.length === 0) {
    return thursdayScorecardPageDataSchema.parse({ snapshot: null, sweeps: [] });
  }

  const requestedIndex = input.sweepId
    ? thursdays.findIndex((run) => run.id === input.sweepId)
    : -1;
  const selectedIndex = requestedIndex >= 0 ? requestedIndex : 0;
  const sweep = thursdays[selectedIndex];
  const previousSweep = thursdays[selectedIndex + 1] ?? null;

  const runIds = [...sweep.items, ...(previousSweep?.items ?? [])]
    .map((item) => item.test_run_id)
    .filter((runId): runId is string => runId !== null);
  const testIds = [...new Set(sweep.items.map((item) => item.test_id))];

  const [reportRows, testAgents] = await Promise.all([
    listReportRunRowsByIds(runIds),
    listTestAgentsByIds(testIds),
  ]);
  // Keyed by run id, so one map serves both sides of the comparison.
  const reportRowsByRunId = new Map(reportRows.map((row) => [row.runId, row]));
  const intendedAgentByTestId = new Map(
    testAgents.map((test) => [test.id, test.intended_agent]),
  );

  // Supporting metrics only for the SELECTED sweep's completed reports — the previous sweep
  // contributes nothing but its scores.
  const supportingByRunId = input.includeSupporting
    ? await loadSupportingByRunId(
        sweep.items
          .map((item) => item.test_run_id)
          .filter(
            (runId): runId is string =>
              runId !== null && reportRowsByRunId.get(runId)?.reportStatus === 'completed',
          ),
      )
    : undefined;

  const snapshot = buildThursdayScorecardSnapshot({
    sweep,
    previousSweep,
    reportRowsByRunId,
    previousReportRowsByRunId: reportRowsByRunId,
    intendedAgentByTestId,
    supportingByRunId,
  });

  return thursdayScorecardPageDataSchema.parse({
    snapshot,
    sweeps: thursdays.map(toSweepOption),
  });
}
