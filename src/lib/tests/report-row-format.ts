import type { ReportState, ReportStatus } from '~/lib/tests/report/schemas';
import type { ThursdayScorecardAgentRow } from '~/lib/tests/thursday-scorecard-schemas';

/** Caps a label at `maxLength` characters, appending a single ellipsis when it overflows. */
export function truncateLabel(value: string, maxLength = 15): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/**
 * Calculate percentage of mandatory concepts satisfied across all evaluated cases.
 * Looks at all mandatory concepts in the report and calculates what percentage are satisfied.
 */
export function calculateConceptPercentage(reportState: ReportState | null): number | null {
  if (!reportState?.caseScores || Object.keys(reportState.caseScores).length === 0) {
    return null;
  }

  let totalRequired = 0;
  let totalSatisfied = 0;

  for (const caseScore of Object.values(reportState.caseScores)) {
    if (caseScore.concepts?.mandatory) {
      const required = caseScore.concepts.mandatory.required || [];
      const satisfied = caseScore.concepts.mandatory.satisfied || [];
      totalRequired += required.length;
      totalSatisfied += satisfied.length;
    }
  }

  if (totalRequired === 0) {
    return null;
  }

  return Math.round((totalSatisfied / totalRequired) * 100);
}

/**
 * B0-1165 — the one source of the Score cell's TEXT, shared by the "Reports" table, the Thursday
 * scorecard table and the scorecard's Markdown export, so a state word can never read differently
 * in two places.
 */

/**
 * Score cell text for a reported run. A report that hasn't finished scoring has no score to show,
 * so it shows its state instead of an em-dash that would read as "scored zero" or "never
 * reported". `score` is rendered exactly as persisted (never re-rounded) so it can't disagree with
 * the stored grade, which was derived from the unrounded value.
 */
export function describeReportScore(row: {
  score: number | null;
  grade: string | null;
  reportStatus: ReportStatus | null;
}): string {
  if (row.score !== null) {
    return `${row.score} (${row.grade})`;
  }
  switch (row.reportStatus) {
    case 'scoring':
      return 'Scoring…';
    case 'synthesizing':
      return 'Synthesizing…';
    case 'failed':
      return 'Failed';
    case 'idle':
      return 'Not started';
    default:
      return '—';
  }
}

/** Ledger child states, worded for a person. Matches the badge vocabulary on `/admin/scheduled`. */
const LEDGER_STATUS_WORDS: Record<ThursdayScorecardAgentRow['ledgerStatus'], string> = {
  queued: 'Queued',
  claimed: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  timed_out: 'Timed out',
  skipped: 'Skipped',
};

/**
 * Score cell text for a scorecard row. Precedence: a persisted score wins; then a child that never
 * produced a run to grade (`failed` / `timed_out` / `skipped`) shows the ledger state; then the
 * report's own state (`Not started` / `Scoring…` / `Synthesizing…` / `Failed`); then a child still
 * in flight; and only a completed child with no report state at all is "—". Never 0, never blank.
 */
export function describeThursdayScorecardScore(
  row: Pick<ThursdayScorecardAgentRow, 'score' | 'grade' | 'reportStatus' | 'ledgerStatus'>,
): string {
  if (row.score !== null) {
    return `${row.score} (${row.grade})`;
  }
  if (
    row.ledgerStatus === 'failed' ||
    row.ledgerStatus === 'timed_out' ||
    row.ledgerStatus === 'skipped'
  ) {
    return LEDGER_STATUS_WORDS[row.ledgerStatus];
  }
  if (row.reportStatus !== null) {
    return describeReportScore(row);
  }
  if (row.ledgerStatus !== 'completed') {
    return LEDGER_STATUS_WORDS[row.ledgerStatus];
  }
  return '—';
}
