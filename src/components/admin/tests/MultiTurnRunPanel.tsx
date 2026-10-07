import Link from 'next/link';

import { Badge } from '~/components/ui/badge';
import {
  extractMultiTurnResult,
  summarizeMultiTurnRun,
  type MultiTurnResultPayload,
} from '~/lib/tests/multi-turn-result';
import { formatDurationSeconds } from '~/lib/utils/time';

/**
 * B0-537 / B0-538 — the run detail page's multi-turn section: per-turn pass/fail, the cross-turn
 * assertion verdicts, and the run-level "reached the right answer by the final turn" metric.
 *
 * Reads only `test_result_items.response_payload` (see the persistence note in
 * `~/lib/tests/multi-turn-result.ts` — a scenario is ONE result row, turns live on the payload), so
 * nothing here depends on a schema change. Renders nothing when the run has no multi-turn items.
 */

type MultiTurnRunPanelRow = {
  /** `test_result_items.id` — used for the deep-link anchor into the item table. */
  id: string;
  /** `test_result_items.test_item_id` — links to the prompt's item-history page. */
  testItemId: string;
  rowIndex: number;
  prompt: string;
  passed: boolean;
  responsePayload: unknown;
};

type MultiTurnRunPanelProps = {
  rows: readonly MultiTurnRunPanelRow[];
  testId: string;
};

function StatBlock({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4" title={hint}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

function PassBadge({ passed, label }: { passed: boolean; label?: string }) {
  return (
    <Badge
      className={
        passed
          ? 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-50'
          : undefined
      }
      variant={passed ? 'outline' : 'destructive'}
    >
      {label ?? (passed ? 'Pass' : 'Fail')}
    </Badge>
  );
}

function ScenarioCard({
  row,
  result,
  testId,
}: {
  row: MultiTurnRunPanelRow;
  result: MultiTurnResultPayload;
  testId: string;
}) {
  return (
    <li
      className="rounded-2xl border border-slate-200 bg-white p-5"
      id={`multi-turn-result-${row.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <PassBadge passed={result.passed} />
            <Link
              className="text-sm font-semibold text-sky-700 underline-offset-2 hover:underline"
              href={`/admin/tests/${testId}/items/${row.testItemId}`}
            >
              Row {row.rowIndex}
            </Link>
            <span className="text-sm font-medium text-slate-800">
              {result.title || row.prompt}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {result.summary.passedTurnCount}/{result.summary.turnCount} turns passed ·{' '}
            {result.summary.passedAssertionCount}/{result.summary.assertionCount} assertions passed
            {result.summary.firstFailedTurn !== null
              ? ` · first failed at turn ${result.summary.firstFailedTurn}`
              : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PassBadge
            label={
              result.summary.reachedExpectedAnswerByFinalTurn
                ? 'Right answer by final turn'
                : 'Never reached the answer'
            }
            passed={result.summary.reachedExpectedAnswerByFinalTurn}
          />
          {result.historyCapAtRisk ? (
            <Badge
              className="border-amber-600/45 bg-amber-600/12 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-50"
              title="This scenario has more turns than the conversation-history cap (BEX_HISTORY_MAX_MESSAGES) can hold, so the earliest turns were dropped from the model's view. A context failure here may be the cap, not the model."
              variant="outline"
            >
              History cap at risk
            </Badge>
          ) : null}
        </div>
      </div>

      <ol className="mt-4 flex flex-col gap-2">
        {result.turns.map((turn) => (
          <li
            className="rounded-xl border border-slate-200 bg-slate-50/60 p-3"
            key={turn.turnIndex}
          >
            <div className="flex flex-wrap items-center gap-2">
              <PassBadge passed={turn.passed} label={`Turn ${turn.turnIndex}`} />
              {turn.declined ? (
                <Badge className="text-slate-500" variant="secondary">
                  Declined
                </Badge>
              ) : null}
              {turn.elapsedMs !== null ? (
                <Badge className="tabular-nums text-slate-500" variant="secondary">
                  {formatDurationSeconds(turn.elapsedMs)}
                </Badge>
              ) : null}
              {turn.workflowRunId ? (
                <Link
                  className="text-xs text-sky-700 underline-offset-2 hover:underline"
                  href={`/admin/observability/${turn.workflowRunId}`}
                  title="Full trace for this turn"
                >
                  Trace
                </Link>
              ) : null}
            </div>
            <p className="mt-2 text-xs font-medium text-slate-700">{turn.prompt}</p>
            {turn.responseText ? (
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-slate-600">
                {turn.responseText}
              </p>
            ) : null}
            {turn.failureReason ? (
              <p className="mt-1 text-xs text-red-700">{turn.failureReason}</p>
            ) : null}
          </li>
        ))}
      </ol>

      {result.assertions.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-1.5 border-t border-slate-200 pt-3">
          {result.assertions.map((assertion, index) => (
            <li className="text-xs text-slate-700" key={`${assertion.type}-${index}`}>
              <PassBadge passed={assertion.passed} />{' '}
              <Badge className="align-middle font-mono" variant="outline">
                {assertion.type}
              </Badge>{' '}
              <span className="text-slate-500">
                turn{assertion.turns.length === 1 ? '' : 's'} {assertion.turns.join(', ')}
              </span>{' '}
              — {assertion.reason}
              {assertion.caveat ? (
                <span className="text-amber-700"> (caveat: {assertion.caveat})</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function MultiTurnRunPanel({ rows, testId }: MultiTurnRunPanelProps) {
  const multiTurnRows = rows
    .map((row) => ({ row, result: extractMultiTurnResult(row.responsePayload) }))
    .filter(
      (entry): entry is { row: MultiTurnRunPanelRow; result: MultiTurnResultPayload } =>
        entry.result !== null,
    );

  const summary = summarizeMultiTurnRun(rows.map((row) => row.responsePayload));

  if (multiTurnRows.length === 0 || !summary) {
    return null;
  }

  return (
    <section
      className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"
      id="multi-turn-results"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Multi-turn scenarios ({summary.scenarioCount})
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Each scenario is one dataset row replayed as an ordered conversation. Turn-level
            outcomes and cross-turn assertions are graded by the multi-turn evaluator; a scenario
            passes only when every turn and every assertion passes.
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatBlock
          hint="Scenarios where every turn and every cross-turn assertion passed."
          label="Scenarios passed"
          value={`${summary.scenariosPassed}/${summary.scenarioCount}`}
        />
        <StatBlock
          hint="Per-turn pass rate across every scenario in this run."
          label="Turns passed"
          value={`${summary.turnsPassed}/${summary.turnCount}`}
        />
        <StatBlock
          hint="Scenarios whose FINAL turn satisfied its own expectations — the model got there, even if it stumbled on the way."
          label="Right answer by final turn"
          value={`${summary.reachedExpectedAnswerByFinalTurn}/${summary.scenarioCount}`}
        />
        <StatBlock
          hint="Cross-turn assertion pass rate (context_carry, no_reask, consistent_product_anchor, mentions, not_mentions)."
          label="Assertions passed"
          value={`${summary.assertionsPassed}/${summary.assertionCount}`}
        />
      </div>

      {summary.assertionsByType.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {summary.assertionsByType.map((stats) => (
            <Badge
              className="font-mono"
              key={stats.type}
              title={`${stats.passed} of ${stats.total} ${stats.type} assertions passed`}
              variant={stats.passed === stats.total ? 'outline' : 'destructive'}
            >
              {stats.type} {stats.passed}/{stats.total}
            </Badge>
          ))}
        </div>
      ) : null}

      <ol className="mt-6 flex flex-col gap-4">
        {multiTurnRows.map(({ row, result }) => (
          <ScenarioCard key={row.id} result={result} row={row} testId={testId} />
        ))}
      </ol>
    </section>
  );
}
