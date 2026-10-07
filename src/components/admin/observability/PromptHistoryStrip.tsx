/**
 * B0-421 — the prompt's recent outcomes, on the trace page.
 *
 * A trace is one cell in a grid: the run is the row, the prompt is the column. This strip is the
 * cheapest useful slice of the column — last N executions as pass/fail dots, oldest → newest, this
 * run ringed, plus the prompt's overall pass rate and a way through to the full item history.
 *
 * Deliberately **not** a second history page. No similarity trend, no elapsed trend, no aggregate
 * charts: those live on `/admin/tests/<testId>/items/<itemId>`, which is the axis that aggregates
 * them and can afford to. Every dot links to that execution's trace, so the strip doubles as lateral
 * navigation along the column.
 *
 * Rendered only when the harness lookup resolves *and* the history read returned at least one
 * outcome. Live Bex chat runs belong to no grid and get no strip at all.
 *
 * Two live-data shapes drive the styling:
 *  - an execution can have no `workflow_run_id` (search-eval rows, error rows, deleted runs). Those
 *    dots render **hollow and unclickable** — the outcome is real, there is just no trace to open.
 *  - a prompt can have exactly one execution (this one). That case shows a single dot and says so in
 *    words, and suppresses the pass rate, because "100.0% pass rate" off one sample reads as a trend
 *    that does not exist.
 */

import Link from 'next/link';

import { formatPercent } from '~/lib/tests/format';
import { formatShortDate } from '~/lib/utils/time';

import type { PromptHistory } from '~/lib/observability/prompt-history';

type PromptHistoryStripProps = {
  /** `tests.id` — for the link through to the full item history. */
  testId: string;
  /** `test_items.id` — the prompt (the column) this history belongs to. */
  testItemId: string;
  /** `test_items.row_index`, for the "Row N" wording shared with the verdict band. */
  rowIndex: number;
  /** `test_result_items.id` of the execution being viewed, so its dot can be marked. */
  currentResultItemId: string;
  history: PromptHistory;
};

/** Filled = the trace exists and the dot links to it; hollow = no `workflow_run_id` to link to. */
function dotClassName(passed: boolean, linked: boolean): string {
  if (passed) {
    return linked
      ? 'border-emerald-700/50 bg-emerald-500'
      : 'border-emerald-600/60 bg-emerald-500/15';
  }
  return linked
    ? 'border-red-700/50 bg-red-500'
    : 'border-red-600/60 bg-red-500/15';
}

export function PromptHistoryStrip({
  testId,
  testItemId,
  rowIndex,
  currentResultItemId,
  history,
}: PromptHistoryStripProps) {
  const { outcomes, passedExecutions, passRate, totalExecutions } = history;

  if (outcomes.length === 0) {
    return null;
  }

  const itemHistoryHref = `/admin/tests/${testId}/items/${testItemId}`;
  const unlinkedCount = outcomes.filter(
    (outcome) => outcome.workflowRunId === null,
  ).length;
  // One execution is not a trend, so it gets prose instead of a percentage.
  const isFirstExecution = outcomes.length === 1 && totalExecutions !== null && totalExecutions <= 1;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-6 py-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
            Prompt history
          </p>
          <ol className="flex flex-wrap items-center gap-1">
            {outcomes.map((outcome) => {
              const isCurrent = outcome.resultItemId === currentResultItemId;
              const verdict = outcome.passed ? 'Passed' : 'Failed';
              const when = formatShortDate(outcome.createdAt);
              const dot = (
                <span
                  aria-hidden="true"
                  className={`rounded-full border ${isCurrent ? 'h-4 w-4' : 'h-3.5 w-3.5'} ${dotClassName(outcome.passed, outcome.workflowRunId !== null)}`}
                />
              );
              const frameClassName = `inline-flex h-6 w-6 items-center justify-center rounded-full ${
                isCurrent ? 'ring-2 ring-sky-500' : ''
              }`;

              return (
                <li key={outcome.resultItemId}>
                  {outcome.workflowRunId ? (
                    <Link
                      aria-current={isCurrent ? 'page' : undefined}
                      className={`${frameClassName} transition-colors hover:bg-slate-100`}
                      href={`/admin/observability/${outcome.workflowRunId}`}
                      title={`${verdict} · ${when}${isCurrent ? ' · this run' : ' — open this trace'}`}
                    >
                      <span className="sr-only">
                        {verdict} on {when}
                        {isCurrent ? ' (this run)' : ''}
                      </span>
                      {dot}
                    </Link>
                  ) : (
                    <span
                      className={frameClassName}
                      title={`${verdict} · ${when} — no trace was recorded for this execution`}
                    >
                      <span className="sr-only">
                        {verdict} on {when} (no trace recorded)
                      </span>
                      {dot}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {isFirstExecution ? (
            <span className="text-sm text-slate-500">First execution</span>
          ) : (
            <span className="text-sm text-slate-700">
              <span className="font-semibold tabular-nums text-slate-900">
                {passRate !== null ? formatPercent(passRate * 100) : '—'}
              </span>{' '}
              pass rate
              {totalExecutions !== null && passedExecutions !== null ? (
                <span className="text-slate-500">
                  {' '}
                  · {passedExecutions} of {totalExecutions} executions
                </span>
              ) : null}
            </span>
          )}
          <Link
            className="text-sm font-medium text-sky-700 underline-offset-4 hover:underline"
            href={itemHistoryHref}
            title="Every recorded outcome for this prompt, with similarity and timing trends"
          >
            Full history for row {rowIndex} →
          </Link>
        </div>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        {isFirstExecution
          ? 'This is the only recorded execution of this prompt, so there is no history to compare it against yet.'
          : `Last ${outcomes.length} execution${outcomes.length === 1 ? '' : 's'}, oldest → newest. The ringed dot is this run.`}
        {unlinkedCount > 0
          ? ` ${unlinkedCount === 1 ? 'One hollow dot' : `${unlinkedCount} hollow dots`} recorded no trace to open.`
          : ''}
      </p>
    </section>
  );
}
