import Link from 'next/link';

import { RunConfigBadges } from '~/components/admin/tests/RuntimeConfigBadge';
import { SweepRunProgress } from '~/components/admin/tests/SweepRunProgress';
import { getStatusBadgeColor } from '~/components/admin/tests/sweep-status';
import { Badge } from '~/components/ui/badge';
import type { ScheduledTestItem } from '~/lib/observability/scheduled-test-types';
import { parseReportState } from '~/lib/tests/report/schemas';
import { extractProgress } from '~/lib/tests/response-payload';
import { parseTestRunConfig } from '~/lib/tests/run-config';
import type { TestResultRecord } from '~/lib/tests/types';
import { formatDate, formatDurationSeconds } from '~/lib/utils/time';

const EM_DASH = '—';

type SweepTestSetCardProps = {
  /** The ledger child for this golden set. */
  item: ScheduledTestItem;
  /** The `test_results` row `item.test_run_id` points at; null when no run was ever created. */
  result: TestResultRecord | null;
  /** `tests.row_count` for the set — loaded for partial sweeps only, to size the scope line. */
  testRowCount: number | null;
  /** The parent sweep's mode and bar, for the partial scope line. */
  runMode: 'full' | 'partial';
  partialScoreThreshold: number | null;
};

function Stat({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div title={title}>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm tabular-nums text-slate-900">{children}</dd>
    </div>
  );
}

/**
 * B0-1108 — one card per sweep child. Reads the ledger row plus the one `test_results` row it
 * points at; never a golden-metric aggregate. Layout follows `GoldenSetMetricsCards`; the stats
 * mirror the "Recent runs" table on /admin/tests/[testId].
 */
export function SweepTestSetCard({
  item,
  result,
  testRowCount,
  runMode,
  partialScoreThreshold,
}: SweepTestSetCardProps) {
  const testHref = `/admin/tests/${item.test_id}`;

  if (!result) {
    // B0-963 — `test_run_id` is null when the dispatch create call itself failed, so there is no
    // run to open; the card stays plain and carries the dispatch error instead.
    return (
      <article className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <Link
            className="min-w-0 truncate text-sm font-semibold text-sky-700 underline-offset-2 hover:underline"
            href={testHref}
            title={item.test_name}
          >
            {item.test_name}
          </Link>
          <Badge
            className={`border ${getStatusBadgeColor(item.status)}`}
            title="Sweep ledger status (scheduled_test_items.status)"
          >
            {item.status}
          </Badge>
        </div>
        <p className="text-sm text-slate-600">
          No run was created for this test set.
        </p>
        {item.error_code ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-900">
            <code className="font-mono font-semibold">{item.error_code}</code>
            {item.error_message ? (
              <p className="mt-1 leading-snug">{item.error_message}</p>
            ) : null}
          </div>
        ) : null}
      </article>
    );
  }

  const runHref = `/admin/tests/${item.test_id}/runs/${result.id}`;
  const reportState = parseReportState(result.report_state);
  const overall =
    reportState?.status === 'completed' ? reportState.overall : null;
  const scoreLabel =
    overall && typeof overall.avg === 'number'
      ? `${overall.avg}/100 (${overall.grade})`
      : EM_DASH;

  // Pass/fail: the ledger child's counts once the hourly reconciler has folded the run back in,
  // otherwise the run row's own counters. The tooltip says which one the card is reading.
  const reconciled = typeof item.items_total === 'number';
  const passedItems = reconciled
    ? (item.items_passed ?? 0)
    : result.passed_items;
  const failedItems = reconciled
    ? (item.items_failed ?? 0)
    : result.failed_items;
  const passRate = reconciled
    ? (item.pass_rate ??
      (item.items_total && item.items_total > 0
        ? passedItems / item.items_total
        : null))
    : passedItems + failedItems > 0
      ? passedItems / (passedItems + failedItems)
      : null;
  const passSourceTitle = reconciled
    ? 'From the sweep ledger (scheduled_test_items, reconciled hourly)'
    : 'From the run row (test_results) — the sweep ledger has not been reconciled yet';

  const progress = extractProgress(result.summary, result.total_items);
  const initialTotalItems = Math.max(progress.totalItems, result.total_items);
  const initialCompletedItemsRaw = Math.max(
    progress.completedItems,
    result.passed_items + result.failed_items,
  );
  const initialCompletedItems =
    initialTotalItems > 0
      ? Math.min(initialTotalItems, initialCompletedItemsRaw)
      : initialCompletedItemsRaw;

  const scopeLabel =
    runMode === 'partial'
      ? `${result.total_items} of ${testRowCount ?? '?'} items (below threshold ${
          partialScoreThreshold ?? '?'
        })`
      : null;

  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <Link
        className="min-w-0 truncate text-sm font-semibold text-sky-700 underline-offset-2 hover:underline"
        href={testHref}
        title={item.test_name}
      >
        {item.test_name}
      </Link>

      <SweepRunProgress
        initialCompletedItems={initialCompletedItems}
        initialElapsedMs={result.elapsed_ms ?? 0}
        initialStatus={result.status}
        initialTotalItems={initialTotalItems}
        runId={result.id}
      />

      {scopeLabel ? (
        <p
          className="text-xs text-slate-600"
          title="Partial sweep: only items whose latest score was below the threshold were re-run"
        >
          {scopeLabel}
        </p>
      ) : null}

      {/* The card body is the run's click target; the header link above opens the test set. */}
      <Link
        className="-mx-2 rounded-xl px-2 py-2 transition-colors hover:bg-slate-50"
        href={runHref}
        title="Open this run"
      >
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Stat
            label="Score"
            title="Overall score/grade from the auto-generated eval report"
          >
            {scoreLabel}
          </Stat>
          <Stat label="Pass / fail" title={passSourceTitle}>
            <span className="font-medium text-green-700">{passedItems}</span>/
            <span className="font-medium text-red-700">{failedItems}</span>
          </Stat>
          <Stat label="Pass %" title={passSourceTitle}>
            {passRate === null ? EM_DASH : `${(passRate * 100).toFixed(1)}%`}
          </Stat>
          <Stat
            label="Elapsed"
            title="Total answer time: sum of each prompt's elapsed time for this run"
          >
            {formatDurationSeconds(result.elapsed_ms)}
          </Stat>
          <Stat label="Started">{formatDate(result.started_at)}</Stat>
          <Stat label="Completed">
            {result.completed_at ? formatDate(result.completed_at) : EM_DASH}
          </Stat>
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-1">
          <RunConfigBadges runConfig={parseTestRunConfig(result.run_options)} />
        </div>
        <p className="mt-3 text-xs font-medium text-sky-700">Open run →</p>
      </Link>
    </article>
  );
}
