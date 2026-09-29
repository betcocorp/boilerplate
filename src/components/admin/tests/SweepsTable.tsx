'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MouseEvent } from 'react';

import { getStatusBadgeColor } from '~/components/admin/tests/sweep-status';
import { Badge } from '~/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import {
  formatRate,
  getRunDisplayCounts,
  getRunDisplayStatus,
  getSweepSourceLabel,
  type ScheduledTestRunWithItems,
} from '~/lib/observability/scheduled-test-types';
import { formatDurationMs, formatEasternTimestamp } from '~/lib/utils/time';

/**
 * B0-1107 — one sweep per row, read straight from the sweep ledger (`scheduled_test_runs` +
 * `scheduled_test_items`), never from a golden-metric aggregate. Rendered twice on /admin/tests:
 * once for full sweeps and once for partial (threshold-filtered) sweeps, which must never share a
 * list because partial runs never enter golden-set history.
 *
 * Status and C/E/TO come from the shared child-wins helpers: the parent row's stored columns lag
 * its children until the hourly reconciler runs.
 */
type SweepsTableProps = {
  runs: ScheduledTestRunWithItems[];
  title: string;
  emptyMessage: string;
  loadError: string | null;
  /** Adds the Threshold column — only meaningful for partial sweeps. */
  showThreshold?: boolean;
};

function sweepHref(sweepId: string) {
  return `/admin/tests/sweeps/${sweepId}`;
}

function SweepRow({
  run,
  showThreshold,
}: {
  run: ScheduledTestRunWithItems;
  showThreshold: boolean;
}) {
  const router = useRouter();
  const displayStatus = getRunDisplayStatus(run);
  const counts = getRunDisplayCounts(run);
  const href = sweepHref(run.id);

  // The whole row is a click target for the mouse; keyboard users reach the same page through the
  // real <Link> in the first cell, so the row itself is not made focusable.
  const handleRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if ((event.target as HTMLElement).closest('a')) {
      return;
    }
    router.push(href);
  };

  return (
    <TableRow className="cursor-pointer" onClick={handleRowClick}>
      <TableCell className="whitespace-nowrap font-medium">
        <Link
          className="text-sky-700 underline-offset-2 hover:underline"
          href={href}
        >
          {formatEasternTimestamp(run.sweep_triggered_at)}
        </Link>
      </TableCell>
      <TableCell className="text-sm text-slate-600">
        {getSweepSourceLabel(run.sweep_name)}
      </TableCell>
      <TableCell>
        <Badge className={`border ${getStatusBadgeColor(displayStatus)}`}>
          {displayStatus}
        </Badge>
      </TableCell>
      {showThreshold ? (
        <TableCell className="text-center tabular-nums text-sm text-slate-600">
          {run.partial_score_threshold === null
            ? '—'
            : `< ${run.partial_score_threshold}`}
        </TableCell>
      ) : null}
      <TableCell className="text-center text-sm text-slate-600">
        {run.total_tests}
      </TableCell>
      <TableCell className="text-center text-sm text-slate-600">
        <span className="font-medium text-green-700">{counts.successful}</span>/
        <span className="font-medium text-red-700">{counts.failed}</span>/
        <span className="font-medium text-orange-700">{counts.timedOut}</span>
      </TableCell>
      <TableCell className="text-center text-sm text-slate-600">
        {formatRate(counts.successRate)}
      </TableCell>
      <TableCell className="text-sm text-slate-600">
        {run.elapsed_ms ? formatDurationMs(run.elapsed_ms) : '—'}
      </TableCell>
    </TableRow>
  );
}

export function SweepsTable({
  runs,
  title,
  emptyMessage,
  loadError,
  showThreshold = false,
}: SweepsTableProps) {
  const columnCount = showThreshold ? 8 : 7;

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <span className="text-sm text-slate-600">
          {runs.length} {runs.length === 1 ? 'sweep' : 'sweeps'}
        </span>
      </div>
      {loadError ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {loadError}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Triggered</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              {showThreshold ? (
                <TableHead
                  className="text-center"
                  title="Only items whose latest score was below this bar were re-run"
                >
                  Threshold
                </TableHead>
              ) : null}
              <TableHead className="text-center">Total sets</TableHead>
              <TableHead
                className="text-center"
                title="Completed / Error / Timeout"
              >
                <span className="text-emerald-600">C</span>
                <span className="text-slate-400">/</span>
                <span className="text-red-600">E</span>
                <span className="text-slate-400">/</span>
                <span className="text-slate-400">TO</span>
              </TableHead>
              <TableHead className="text-center">Success rate</TableHead>
              <TableHead>Elapsed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.length === 0 ? (
              <TableRow>
                <TableCell className="text-slate-500" colSpan={columnCount}>
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              runs.map((run) => (
                <SweepRow
                  key={run.id}
                  run={run}
                  showThreshold={showThreshold}
                />
              ))
            )}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
