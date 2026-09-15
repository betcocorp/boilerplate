'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { Badge } from '~/components/ui/badge';
import {
  computeScheduledRunAggregates,
  isTerminalScheduledItemStatus,
  type ScheduledRunStatus,
  type ScheduledTestRunWithItems,
} from '~/lib/observability/scheduled-test-types';
import { formatDurationMs, formatEasternTimestamp } from '~/lib/utils/time';

function getStatusBadgeColor(status: string): string {
  switch (status) {
    case 'queued':
      return 'border-slate-400 bg-slate-100 text-slate-900';
    case 'in_progress':
    case 'claimed':
    case 'running':
      return 'border-blue-400 bg-blue-100 text-blue-900';
    case 'completed':
      return 'border-green-400 bg-green-100 text-green-900';
    case 'failed':
      return 'border-red-400 bg-red-100 text-red-900';
    case 'timed_out':
      return 'border-orange-400 bg-orange-100 text-orange-900';
    default:
      return 'border-slate-300 bg-slate-50 text-slate-600';
  }
}

/**
 * The parent's stored status lags its children: the sweep writes it at dispatch time and only the
 * hourly reconciler closes it out, so a row can read `completed` while children are still running.
 * Children win unless the sweep itself failed.
 */
function getRunDisplayStatus(run: ScheduledTestRunWithItems): ScheduledRunStatus {
  if (run.status === 'failed') {
    return 'failed';
  }

  const hasOpenItems = run.items.some(
    (item) => !isTerminalScheduledItemStatus(item.status),
  );

  return hasOpenItems ? 'in_progress' : run.status;
}

/**
 * Counts lag for the same reason the status does, so they are derived from the children the page
 * already has rather than read off the parent — otherwise a sweep with a dispatch failure shows
 * 0 failed until the reconciler catches up. The stored columns are the fallback for a sweep whose
 * children were never written.
 */
function getRunDisplayCounts(run: ScheduledTestRunWithItems) {
  if (run.items.length === 0) {
    return {
      successful: run.successful_tests,
      failed: run.failed_tests,
      timedOut: run.timed_out_tests,
      successRate: run.success_rate,
    };
  }

  const derived = computeScheduledRunAggregates(run.items);
  return {
    successful: derived.successful_tests,
    failed: derived.failed_tests,
    timedOut: derived.timed_out_tests,
    successRate: derived.success_rate,
  };
}

function formatRate(rate: number | null): string {
  // Null is "nothing terminal to measure yet" — never the same claim as 0%.
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

type ScheduledTestRunRowProps = {
  run: ScheduledTestRunWithItems;
  isExpanded: boolean;
  onExpandChange: (expanded: boolean) => void;
};

function ScheduledTestRunRow({
  run,
  isExpanded,
  onExpandChange,
}: ScheduledTestRunRowProps) {
  const displayStatus = getRunDisplayStatus(run);
  const counts = getRunDisplayCounts(run);

  return (
    <>
      <TableRow className="hover:bg-slate-50">
        <TableCell className="w-8">
          <button
            onClick={() => onExpandChange(!isExpanded)}
            className="inline-flex items-center justify-center rounded p-0.5 hover:bg-slate-200"
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </TableCell>
        <TableCell className="font-medium text-slate-900">
          {/* B0-964 — the date matters: this table lists recent sweeps, not today's, so a bare
              clock time cannot distinguish an hour ago from last week. */}
          {formatEasternTimestamp(run.sweep_triggered_at)}
        </TableCell>
        <TableCell>
          <Badge className={`border ${getStatusBadgeColor(displayStatus)}`}>
            {displayStatus}
          </Badge>
        </TableCell>
        <TableCell className="text-center text-sm text-slate-600">
          {run.total_tests}
        </TableCell>
        <TableCell className="text-center text-sm text-slate-600">
          <span className="font-medium text-green-700">
            {counts.successful}
          </span>
          /
          <span className="font-medium text-red-700">{counts.failed}</span>/
          <span className="font-medium text-orange-700">
            {counts.timedOut}
          </span>
        </TableCell>
        <TableCell className="text-center text-sm text-slate-600">
          {formatRate(counts.successRate)}
        </TableCell>
        <TableCell className="text-sm text-slate-600">
          {run.elapsed_ms ? formatDurationMs(run.elapsed_ms) : '—'}
        </TableCell>
      </TableRow>

      {isExpanded && run.items.length > 0 && (
        <TableRow className="bg-slate-50">
          <TableCell colSpan={7} className="p-0">
            <div className="border-t border-slate-200 px-6 py-4">
              <div className="text-sm font-semibold text-slate-900 mb-4">
                Test items ({run.items.length})
              </div>
              <Table className="text-sm">
                <TableHeader>
                  <TableRow className="border-b border-slate-200">
                    <TableHead className="h-8 text-xs font-semibold text-slate-700">
                      Test name
                    </TableHead>
                    <TableHead className="h-8 text-xs font-semibold text-slate-700">
                      Status
                    </TableHead>
                    <TableHead className="h-8 text-center text-xs font-semibold text-slate-700">
                      Passed / Failed / Total
                    </TableHead>
                    <TableHead className="h-8 text-center text-xs font-semibold text-slate-700">
                      Pass rate
                    </TableHead>
                    <TableHead className="h-8 text-xs font-semibold text-slate-700">
                      Error code
                    </TableHead>
                    <TableHead className="h-8 text-xs font-semibold text-slate-700">
                      Elapsed time
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {run.items.map((item) => {
                    // Counts stay null until the reconciler folds the run's grades back in;
                    // an unscored item must read "—", not "0 / 0 / 0" at "0%".
                    const hasCounts = typeof item.items_total === 'number';
                    const itemPassRate =
                      item.pass_rate ??
                      (item.items_total && item.items_total > 0
                        ? (item.items_passed ?? 0) / item.items_total
                        : null);

                    return (
                      <TableRow
                        key={item.id}
                        className="border-b border-slate-100 hover:bg-slate-100"
                      >
                        <TableCell className="py-2 text-slate-900">
                          {/* B0-963 — `test_run_id` is null when the dispatch create call itself
                              failed, so there is no run to open; those rows stay plain text and
                              explain themselves in the Error code column. */}
                          {item.test_run_id ? (
                            <Link
                              href={`/admin/tests/${item.test_id}/runs/${item.test_run_id}/report`}
                              className="text-sky-700 underline underline-offset-4 hover:text-sky-900"
                            >
                              {item.test_name}
                            </Link>
                          ) : (
                            item.test_name
                          )}
                        </TableCell>
                        <TableCell className="py-2">
                          <Badge
                            variant="outline"
                            className={`border ${getStatusBadgeColor(item.status)}`}
                          >
                            {item.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="py-2 text-center text-slate-600">
                          {hasCounts ? (
                            <>
                              <span className="font-medium text-green-700">
                                {item.items_passed ?? 0}
                              </span>
                              /
                              <span className="font-medium text-red-700">
                                {item.items_failed ?? 0}
                              </span>
                              /
                              <span className="text-slate-700">
                                {item.items_total}
                              </span>
                            </>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell className="py-2 text-center text-slate-600">
                          {formatRate(itemPassRate)}
                        </TableCell>
                        <TableCell className="py-2 text-slate-600">
                          {item.error_code ? (
                            // B0-1014 — the reconciler writes an actionable sentence alongside the
                            // code (e.g. which provider fault, and how many items got no answer).
                            // Surfaced on hover so the column stays narrow but the reason is not
                            // write-only.
                            <code
                              className="rounded bg-red-50 px-2 py-1 text-xs font-mono text-red-900"
                              title={item.error_message ?? undefined}
                            >
                              {item.error_code}
                            </code>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell className="py-2 text-slate-600">
                          {item.elapsed_ms
                            ? formatDurationMs(item.elapsed_ms)
                            : '—'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </TableCell>
        </TableRow>
      )}

      {isExpanded && run.items.length === 0 && (
        <TableRow className="bg-slate-50">
          <TableCell colSpan={7} className="py-4 text-center text-sm text-slate-500">
            No test items for this sweep
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function ScheduledTestsTable({
  runs,
}: {
  runs: ScheduledTestRunWithItems[];
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    const newExpanded = new Set(expandedIds);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedIds(newExpanded);
  };

  return (
    <section className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="bg-slate-50 hover:bg-slate-50">
            <TableHead className="w-8 h-10" />
            <TableHead className="h-10 font-semibold text-slate-900">
              Triggered
            </TableHead>
            <TableHead className="h-10 font-semibold text-slate-900">
              Status
            </TableHead>
            <TableHead className="h-10 text-center font-semibold text-slate-900">
              Total tests
            </TableHead>
            <TableHead className="h-10 text-center font-semibold text-slate-900">
              Passed / Failed / Timed out
            </TableHead>
            <TableHead className="h-10 text-center font-semibold text-slate-900">
              Success rate
            </TableHead>
            <TableHead className="h-10 font-semibold text-slate-900">
              Elapsed time
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <ScheduledTestRunRow
              key={run.id}
              run={run}
              isExpanded={expandedIds.has(run.id)}
              onExpandChange={() => toggleExpanded(run.id)}
            />
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
