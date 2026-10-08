import { V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import { listRecentScheduledTestRuns } from '~/lib/observability/scheduled-test-repository';
import {
  CRON_SWEEP_NAME,
  getRunDisplayCounts,
  getRunDisplayStatus,
  type ScheduledTestItem,
  type ScheduledTestRunWithItems,
} from '~/lib/observability/scheduled-test-types';
import { listGoldenTests } from '~/lib/tests/golden-set';
import { loadReportData } from '~/lib/tests/report/assemble';
import {
  calculateConceptPercentage,
  describeThursdayScorecardScore,
} from '~/lib/tests/report-row-format';
import { roundToTenth } from '~/lib/tests/report-trend';
import {
  listReportRunRowsByIds,
  listTestAgentsByIds,
  type ReportRunRow,
} from '~/lib/tests/repository';
import {
  thursdayScorecardHistorySchema,
  thursdayScorecardPageDataSchema,
  type ThursdayScorecardAgentRow,
  type ThursdayScorecardChange,
  type ThursdayScorecardFlag,
  type ThursdayScorecardHistory,
  type ThursdayScorecardHistoryCell,
  type ThursdayScorecardHistoryRow,
  type ThursdayScorecardPageData,
  type ThursdayScorecardPrevious,
  type ThursdayScorecardSnapshot,
  type ThursdayScorecardSupporting,
  type ThursdayScorecardSweep,
  type ThursdayScorecardSweepOption,
} from '~/lib/tests/thursday-scorecard-schemas';
import { easternDateKey, easternWeekday, formatEasternSweepLabel } from '~/lib/utils/time';

/**
 * B0-1166 (epic B0-1165) — the Thursday-night scorecard: which cron sweep ran Thursday night,
 * what each golden agent scored in it, and how that compares with the Thursday before.
 *
 * Same split as `~/lib/tests/golden-report-score-trend.ts`: the selection rule and the fold are
 * pure (unit-tested without a database); I/O happens only at the edge in `loadThursdayScorecard`
 * and `loadThursdayScorecardHistory`.
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
 * - B0-1170: `previous`, `flags`, `highlights` and `notes` are all DERIVED from the rows above —
 *   templated sentences over persisted numbers, never authored. Same input → same text.
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

function isRegistryAgentId(intendedAgent: string | null): intendedAgent is string {
  return V1_AGENT_REGISTRY.some((agent) => agent.id === intendedAgent);
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

function toPreviousSweepRef(
  run: ScheduledTestRunWithItems | null,
): ThursdayScorecardSnapshot['previousSweep'] {
  return run ? { id: run.id, sweepTriggeredAt: run.sweep_triggered_at } : null;
}

/* -------------------------------------------------------------------------- *
 * Shared fold — one sweep's children against the previous sweep (snapshot + history)
 * -------------------------------------------------------------------------- */

/**
 * Ledger order (created_at ascending) with `id` as the tiebreak: a sweep bulk-inserts its
 * children with one timestamp, so without it the row order would be whatever the heap returned.
 */
function sortLedgerChildren(items: readonly ScheduledTestItem[]): ScheduledTestItem[] {
  return [...items].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
}

type PreviousEntry = { runId: string | null; row: ReportRunRow | null };

/**
 * The previous sweep's child per `test_id`. A child is "present last week" even when it was never
 * scored (failed child, failed report), so the entry exists with a `null` row. Should a sweep carry
 * the same `test_id` twice, the scored one wins; otherwise the first in ledger order.
 */
function indexPreviousSweep(
  previousSweep: ScheduledTestRunWithItems | null,
  previousReportRowsByRunId: Map<string, ReportRunRow>,
): Map<string, PreviousEntry> {
  const byTestId = new Map<string, PreviousEntry>();
  if (!previousSweep) return byTestId;
  for (const item of sortLedgerChildren(previousSweep.items)) {
    const row = item.test_run_id ? (previousReportRowsByRunId.get(item.test_run_id) ?? null) : null;
    const existing = byTestId.get(item.test_id);
    const existingScored = (existing?.row?.score ?? null) !== null;
    if (!existing || (!existingScored && (row?.score ?? null) !== null)) {
      byTestId.set(item.test_id, { runId: item.test_run_id, row });
    }
  }
  return byTestId;
}

/**
 * Change = this score − the previous score, rounded to one decimal like `buildReportScoreTrend`;
 * `changePercent` is `null` when the previous score is 0 (undefined, not infinite).
 */
function buildScoreChange(
  runId: string,
  score: number,
  previousRunId: string,
  previousScore: number,
): ThursdayScorecardChange {
  return {
    runId,
    previousRunId,
    previousScore,
    deltaPoints: roundToTenth(score - previousScore),
    changePercent:
      previousScore === 0 ? null : roundToTenth(((score - previousScore) / previousScore) * 100),
  };
}

type FoldedChild = {
  item: ScheduledTestItem;
  row: ReportRunRow | null;
  intendedAgent: string | null;
  agentLabel: string;
  score: number | null;
  grade: ThursdayScorecardAgentRow['grade'];
  failCount: number | null;
  change: ThursdayScorecardChange | null;
  /** `undefined` when the agent had no row in the previous sweep (or there is no previous sweep). */
  previous: PreviousEntry | undefined;
};

/** The content fold both the snapshot and the history grid are built from — one entry per child. */
function foldSweepChildren(input: {
  sweep: ScheduledTestRunWithItems;
  previousSweep: ScheduledTestRunWithItems | null;
  reportRowsByRunId: Map<string, ReportRunRow>;
  previousReportRowsByRunId: Map<string, ReportRunRow>;
  intendedAgentByTestId: Map<string, string | null>;
}): FoldedChild[] {
  const previousByTestId = indexPreviousSweep(input.previousSweep, input.previousReportRowsByRunId);
  return sortLedgerChildren(input.sweep.items).map((item) => {
    const row = item.test_run_id ? (input.reportRowsByRunId.get(item.test_run_id) ?? null) : null;
    const intendedAgent = input.intendedAgentByTestId.get(item.test_id) ?? null;
    const score = row?.score ?? null;
    const previous = previousByTestId.get(item.test_id);
    const previousRow = previous?.row ?? null;
    const change =
      row && score !== null && previousRow && previousRow.score !== null
        ? buildScoreChange(row.runId, score, previousRow.runId, previousRow.score)
        : null;
    return {
      item,
      row,
      intendedAgent,
      agentLabel: resolveAgentLabel(intendedAgent, item.test_name),
      score,
      grade: row?.grade ?? null,
      failCount: row?.failCount ?? null,
      change,
      previous,
    };
  });
}

/* -------------------------------------------------------------------------- *
 * B0-1170 — flags, highlights, notes (pure, deterministic)
 * -------------------------------------------------------------------------- */

const NOT_RECORDED = '—';
const ARROW = '→';

const gradeText = (grade: ThursdayScorecardAgentRow['grade']) => grade ?? NOT_RECORDED;
const numberText = (value: number | null) => (value === null ? NOT_RECORDED : String(value));

/** The Score cell's state word (`Failed`, `Timed out`, `Scoring…`, `Not started`…) lowercased. */
function describeState(row: ThursdayScorecardAgentRow): string {
  return describeThursdayScorecardScore(row).toLowerCase();
}

/** `with 3 failed questions` / `with 1 failed question`; empty when the count was never recorded. */
function failedQuestionsClause(failCount: number | null): string {
  if (failCount === null) return '';
  return ` with ${failCount} failed question${failCount === 1 ? '' : 's'}`;
}

/**
 * B0-1170 — a content decline smaller than this (in score points) does not raise the
 * "faster, not better" flag. Scores carry one decimal, so a 0.1-point dip is grading noise, and
 * flagging it as "answering less well" would be a false alarm for the reader.
 */
export const CONTENT_DOWN_MIN_DELTA_POINTS = 1;

/**
 * Review flags in a fixed order. `metrics_unreported` requires a score: an unscored row has no
 * report to carry metrics, and `not_scored` already says so.
 */
export function deriveThursdayScorecardFlags(
  row: Pick<ThursdayScorecardAgentRow, 'score' | 'grade' | 'change' | 'supporting' | 'previous'>,
): ThursdayScorecardFlag[] {
  const flags: ThursdayScorecardFlag[] = [];
  if (row.score === null) flags.push('not_scored');
  if (row.grade === 'D' || row.grade === 'F') flags.push('now_failing');
  if (
    row.change !== null &&
    row.change.deltaPoints <= -CONTENT_DOWN_MIN_DELTA_POINTS &&
    typeof row.supporting?.speedScore === 'number' &&
    typeof row.previous?.speedScore === 'number' &&
    row.supporting.speedScore > row.previous.speedScore
  ) {
    flags.push('content_down_speed_up');
  }
  if (row.score !== null) {
    const s = row.supporting;
    const unreported =
      s === null ||
      (s.speedScore === null &&
        s.avgTtftSeconds === null &&
        s.similarityAvg === null &&
        s.evalConfidenceAvg === null);
    if (unreported) flags.push('metrics_unreported');
  }
  return flags;
}

const MAX_HIGHLIGHTS = 6;

/**
 * "Executive highlights" — templated sentences in a fixed priority order (failing agents, largest
 * gain, largest drop, "faster, not better", best performer, not scored), capped at six. Every
 * number is a persisted value quoted via `String(n)`; nothing is authored or recomputed.
 */
export function buildThursdayScorecardHighlights(
  agents: readonly ThursdayScorecardAgentRow[],
): string[] {
  const scored = agents.filter((row) => row.score !== null);
  const notScored = agents.filter((row) => row.flags.includes('not_scored'));
  const listNotScored = () =>
    notScored.map((row) => `${row.agentLabel} (${describeState(row)})`).join(', ');

  if (scored.length === 0) {
    return [
      notScored.length === 0
        ? 'No agent produced a score in this sweep.'
        : `No agent produced a score in this sweep: ${listNotScored()}.`,
    ];
  }

  const highlights: string[] = [];

  // (a) Agents now failing.
  const failing = agents.filter((row) => row.flags.includes('now_failing'));
  for (const row of failing) {
    const p = row.previous;
    let sentence: string;
    if (p && p.score !== null) {
      const current = `${gradeText(row.grade)}/${numberText(row.score)}`;
      const before = `${gradeText(p.grade)}/${numberText(p.score)}`;
      let failures = '';
      if (p.failCount !== null && row.failCount !== null) {
        failures =
          row.failCount > p.failCount
            ? ` with failures rising ${p.failCount} ${ARROW} ${row.failCount}`
            : row.failCount < p.failCount
              ? ` with failures falling ${p.failCount} ${ARROW} ${row.failCount}`
              : ` with failures unchanged at ${row.failCount}`;
      }
      // "dropped" only when the score did fall; a D that edged up is still failing, not a drop.
      const verb =
        row.score !== null && row.score < p.score
          ? `dropped from ${before} to ${current}`
          : `is still failing, ${before} ${ARROW} ${current}`;
      sentence = `${row.agentLabel} ${verb}${failures}.`;
    } else {
      sentence = `${row.agentLabel} is failing at ${gradeText(row.grade)}/${numberText(row.score)}${failedQuestionsClause(row.failCount)}.`;
    }
    if (failing.length === 1) {
      sentence = `${sentence.slice(0, -1)} — the only agent now failing.`;
    }
    highlights.push(sentence);
  }

  const gradeTransition = (row: ThursdayScorecardAgentRow) => {
    const before = row.previous?.grade ?? null;
    return before === row.grade
      ? `(${gradeText(row.grade)}, unchanged)`
      : `(${gradeText(before)} ${ARROW} ${gradeText(row.grade)})`;
  };
  const scoreTransition = (row: ThursdayScorecardAgentRow) =>
    `${numberText(row.change?.previousScore ?? null)} ${ARROW} ${numberText(row.score)}`;

  // (b) Largest gain — first in row order wins a tie.
  let gain: ThursdayScorecardAgentRow | null = null;
  for (const row of agents) {
    if (row.change && row.change.deltaPoints > 0) {
      if (!gain || row.change.deltaPoints > gain.change!.deltaPoints) gain = row;
    }
  }
  if (gain) {
    highlights.push(
      `${gain.agentLabel} improved ${scoreTransition(gain)} ${gradeTransition(gain)}, the largest gain this week.`,
    );
  }

  // (c) Largest drop not already reported as failing.
  let drop: ThursdayScorecardAgentRow | null = null;
  for (const row of agents) {
    if (row.change && row.change.deltaPoints < 0 && !row.flags.includes('now_failing')) {
      if (!drop || row.change.deltaPoints < drop.change!.deltaPoints) drop = row;
    }
  }
  if (drop) {
    highlights.push(`${drop.agentLabel} slipped ${scoreTransition(drop)} ${gradeTransition(drop)}.`);
  }

  // (d) Faster, not better.
  for (const row of agents) {
    if (!row.flags.includes('content_down_speed_up')) continue;
    highlights.push(
      `${row.agentLabel}'s content score slipped ${scoreTransition(row)} while its speed score improved ` +
        `${numberText(row.previous?.speedScore ?? null)} ${ARROW} ${numberText(row.supporting?.speedScore ?? null)} — faster, not better.`,
    );
  }

  // (e) Best performer — first in row order wins a tie.
  let best: ThursdayScorecardAgentRow = scored[0];
  for (const row of scored) {
    if (row.score! > best.score!) best = row;
  }
  highlights.push(
    `${best.agentLabel} is the best performer at ${gradeText(best.grade)}/${numberText(best.score)}${failedQuestionsClause(best.failCount)}.`,
  );

  // (f) Not scored.
  if (notScored.length > 0) {
    highlights.push(`Not scored this sweep: ${listNotScored()}.`);
  }

  return highlights.slice(0, MAX_HIGHLIGHTS);
}

/**
 * "Data notes & review flags" — what the trend indicators compare against and every row whose
 * cells need reading with care (not scored, first appearance, unreported metrics, unscored
 * baseline). Never empty: the baseline note is always present.
 */
export function buildThursdayScorecardNotes(input: {
  previousSweep: ThursdayScorecardSnapshot['previousSweep'];
  agents: readonly ThursdayScorecardAgentRow[];
}): string[] {
  const { previousSweep, agents } = input;
  const notes: string[] = [
    previousSweep
      ? `Change and trend indicators compare against the previous Thursday-night sweep, ${formatEasternSweepLabel(previousSweep.sweepTriggeredAt)}.`
      : 'No earlier Thursday-night sweep, so Change and trend indicators are not available.',
  ];
  const labels = (rows: ThursdayScorecardAgentRow[]) => rows.map((row) => row.agentLabel).join(', ');

  if (previousSweep) {
    const firstAppearance = agents.filter((row) => row.score !== null && row.previous === null);
    if (firstAppearance.length > 0) {
      notes.push(
        `First appearance in a Thursday-night sweep (no prior run of the same dataset): ${labels(firstAppearance)}.`,
      );
    }
  }

  const notScored = agents.filter((row) => row.flags.includes('not_scored'));
  if (notScored.length > 0) {
    notes.push(
      `Not scored in this sweep, shown as their state rather than zero: ${notScored
        .map((row) => `${row.agentLabel} (${describeState(row)})`)
        .join(', ')}.`,
    );
  }

  const unreported = agents.filter((row) => row.flags.includes('metrics_unreported'));
  if (unreported.length > 0) {
    notes.push(
      `Supporting metrics not reported in the source evaluation, shown as ${NOT_RECORDED}: ${labels(unreported)} ` +
        '(speed score, avg TTFT, similarity, evaluator confidence).',
    );
  }

  const previousUnscored = agents.filter(
    (row) => row.previous !== null && row.previous.score === null,
  );
  if (previousUnscored.length > 0) {
    notes.push(
      `Trend not available because the previous Thursday-night run was not scored: ${labels(previousUnscored)}.`,
    );
  }

  return notes;
}

/* -------------------------------------------------------------------------- *
 * Snapshot
 * -------------------------------------------------------------------------- */

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
  /**
   * B0-1167 — supporting metrics keyed by `runId`, for BOTH sweeps' runs (B0-1170 reads the
   * previous run's `speedScore` / `passRate` from it); absent → every `supporting` is `null`.
   */
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
  const { sweep, previousSweep, supportingByRunId } = input;

  const agents: ThursdayScorecardAgentRow[] = foldSweepChildren(input).map((folded) => {
    const { item, row } = folded;
    const supporting = (row && supportingByRunId?.get(row.runId)) ?? null;

    let previous: ThursdayScorecardPrevious | null = null;
    if (folded.previous) {
      const previousRow = folded.previous.row;
      const previousSupporting = previousRow
        ? (supportingByRunId?.get(previousRow.runId) ?? null)
        : null;
      previous = {
        runId: folded.previous.runId,
        score: previousRow?.score ?? null,
        grade: previousRow?.grade ?? null,
        failCount: previousRow?.failCount ?? null,
        speedScore: previousSupporting?.speedScore ?? null,
        passRate: previousSupporting?.passRate ?? null,
      };
    }

    const content = {
      score: folded.score,
      grade: folded.grade,
      change: folded.change,
      supporting,
      previous,
    };

    return {
      testId: item.test_id,
      testName: item.test_name,
      intendedAgent: folded.intendedAgent,
      agentLabel: folded.agentLabel,
      runId: item.test_run_id,
      ledgerStatus: item.status,
      reportStatus: row?.reportStatus ?? null,
      ...content,
      failCount: folded.failCount,
      modelTag: row?.modelTag ?? null,
      appVersion: row?.appVersion ?? null,
      averageTtftMs: row?.averageTtftMs ?? null,
      averageElapsedMs: row?.averageElapsedMs ?? null,
      conceptPercent: row?.reportState ? calculateConceptPercentage(row.reportState) : null,
      flags: deriveThursdayScorecardFlags(content),
    };
  });

  const previousSweepRef = toPreviousSweepRef(previousSweep);
  return {
    sweep: toScorecardSweep(sweep),
    previousSweep: previousSweepRef,
    agents,
    highlights: buildThursdayScorecardHighlights(agents),
    notes: buildThursdayScorecardNotes({ previousSweep: previousSweepRef, agents }),
  };
}

/* -------------------------------------------------------------------------- *
 * History
 * -------------------------------------------------------------------------- */

export type BuildThursdayScorecardHistoryInput = {
  /** Thursday-night sweeps, NEWEST FIRST (as `selectThursdayNightSweeps` returns them). */
  sweeps: readonly ScheduledTestRunWithItems[];
  /** `ReportRunRow` keyed by `runId` for every child of every sweep. */
  reportRowsByRunId: Map<string, ReportRunRow>;
  /** `tests.intended_agent` keyed by `test_id`; a missing key reads as `null`. */
  intendedAgentByTestId: Map<string, string | null>;
  /**
   * Golden, non-archived `tests.id`s. When given, only those sets become cells/columns and a
   * Thursday with none of them is dropped — archived pre-reseed sets would otherwise add their own
   * columns (retired `floor` id) or fold into an active set's column under a different dataset.
   */
  activeGoldenTestIds?: ReadonlySet<string>;
};

/**
 * B0-1170 — pure fold of every Thursday-night sweep into the history grid: one row per sweep
 * (newest first), each compared with the next older sweep exactly as the snapshot does, cells in
 * ledger child order. `agentKey` is the registry id when `intended_agent` is one, otherwise the
 * ledger `testName` — the archived sets carry the retired id `floor`, which would otherwise fold
 * two different datasets into one column. Columns are in first-seen order from the newest sweep.
 */
export function buildThursdayScorecardHistory(
  input: BuildThursdayScorecardHistoryInput,
): ThursdayScorecardHistory {
  const { sweeps, reportRowsByRunId, intendedAgentByTestId, activeGoldenTestIds } = input;
  const columns = new Map<string, string>();

  const rows: ThursdayScorecardHistoryRow[] = sweeps.flatMap((sweep, index) => {
    const previousSweep = sweeps[index + 1] ?? null;
    const folds = foldSweepChildren({
      sweep,
      previousSweep,
      reportRowsByRunId,
      previousReportRowsByRunId: reportRowsByRunId,
      intendedAgentByTestId,
    }).filter((folded) => !activeGoldenTestIds || activeGoldenTestIds.has(folded.item.test_id));
    if (activeGoldenTestIds && folds.length === 0) return [];
    const cells: ThursdayScorecardHistoryCell[] = folds.map((folded) => {
      const agentKey = isRegistryAgentId(folded.intendedAgent)
        ? folded.intendedAgent
        : folded.item.test_name;
      if (!columns.has(agentKey)) columns.set(agentKey, folded.agentLabel);
      return {
        testId: folded.item.test_id,
        agentKey,
        agentLabel: folded.agentLabel,
        runId: folded.item.test_run_id,
        ledgerStatus: folded.item.status,
        reportStatus: folded.row?.reportStatus ?? null,
        score: folded.score,
        grade: folded.grade,
        failCount: folded.failCount,
        change: folded.change,
      };
    });
    return [
      {
        sweep: toScorecardSweep(sweep),
        previousSweep: toPreviousSweepRef(previousSweep),
        scoredCount: cells.filter((cell) => cell.score !== null).length,
        cells,
      },
    ];
  });

  return thursdayScorecardHistorySchema.parse({
    rows,
    agentColumns: [...columns].map(([key, label]) => ({ key, label })),
  });
}

/* -------------------------------------------------------------------------- *
 * Loaders (the only I/O)
 * -------------------------------------------------------------------------- */

/**
 * B0-1167 — speed / judged roll-ups for the rows whose report completed, read through
 * `loadReportData` (the assembled report, exactly what `/admin/tests/[testId]/runs/[runId]/exec`
 * renders) and never `computeReportMetrics` directly, so the scorecard cannot disagree with the
 * exec summary. Values are copied field for field with no re-rounding.
 *
 * Cost: one full report assembly per completed row of BOTH the selected and the previous sweep
 * (B0-1170 needs last week's speed score for the Speed trend and the "faster, not better" flag) —
 * about ten reads per page load with today's roster, in parallel, uncached.
 * `includeSupporting: false` is the seam to pull if the roster grows or the page gets slow; the
 * export route can then read them on demand instead.
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

function childRunIds(sweeps: readonly ScheduledTestRunWithItems[]): string[] {
  return sweeps
    .flatMap((sweep) => sweep.items)
    .map((item) => item.test_run_id)
    .filter((runId): runId is string => runId !== null);
}

function childTestIds(sweeps: readonly ScheduledTestRunWithItems[]): string[] {
  return [...new Set(sweeps.flatMap((sweep) => sweep.items.map((item) => item.test_id)))];
}

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
  const bothSweeps = previousSweep ? [sweep, previousSweep] : [sweep];

  const [reportRows, testAgents] = await Promise.all([
    listReportRunRowsByIds(childRunIds(bothSweeps)),
    listTestAgentsByIds(childTestIds([sweep])),
  ]);
  // Keyed by run id, so one map serves both sides of the comparison.
  const reportRowsByRunId = new Map(reportRows.map((row) => [row.runId, row]));
  const intendedAgentByTestId = new Map(
    testAgents.map((test) => [test.id, test.intended_agent]),
  );

  // Supporting metrics for the completed reports of BOTH sweeps: the previous sweep's speed score
  // is the Speed trend's baseline and half of the "faster, not better" flag (B0-1170).
  const supportingByRunId = input.includeSupporting
    ? await loadSupportingByRunId(
        childRunIds(bothSweeps).filter(
          (runId) => reportRowsByRunId.get(runId)?.reportStatus === 'completed',
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

/**
 * B0-1170 — every Thursday-night sweep in the ledger scan, folded into one history grid for
 * `/admin/tests/reports/scorecards`. Three reads total — the ledger scan, ONE `test_results` read
 * over every child run of every selected sweep, ONE `tests` read over every distinct dataset — and
 * no supporting metrics (the history is content results only).
 */
export async function loadThursdayScorecardHistory(): Promise<ThursdayScorecardHistory> {
  const runs = await listRecentScheduledTestRuns({
    sweepName: CRON_SWEEP_NAME,
    runMode: 'full',
    limit: LEDGER_SCAN_LIMIT,
  });
  const sweeps = selectThursdayNightSweeps(runs);

  const [reportRows, testAgents, activeGolden] = await Promise.all([
    listReportRunRowsByIds(childRunIds(sweeps)),
    listTestAgentsByIds(childTestIds(sweeps)),
    listGoldenTests({ includeArchived: false }),
  ]);

  return buildThursdayScorecardHistory({
    sweeps,
    reportRowsByRunId: new Map(reportRows.map((row) => [row.runId, row])),
    intendedAgentByTestId: new Map(testAgents.map((test) => [test.id, test.intended_agent])),
    activeGoldenTestIds: new Set(activeGolden.map((test) => test.id)),
  });
}
