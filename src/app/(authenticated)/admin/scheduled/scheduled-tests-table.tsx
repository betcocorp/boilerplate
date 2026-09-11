'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
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
import { formatDurationMs, formatEasternTime } from '~/lib/utils/time';

type ScheduledTestItem = {
  id: string;
  scheduled_run_id: string;
  test_id: string;
  test_name: string;
  test_run_id: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  elapsed_ms: number | null;
  items_total: number | null;
  items_passed: number | null;
  items_failed: number | null;
  pass_rate: number | null;
  grade: string | null;
  confidence: number | null;
  error_code: string | null;
  error_message: string | null;
  error_details: Record<string, unknown> | null;
  retry_count: number;
  last_retry_at: string | null;
  claimed_by: string | null;
  created_at: string;
  updated_at: string;
};

type ScheduledTestRun = {
  id: string;
  sweep_name: string;
  sweep_triggered_at: string;
  status: string;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  elapsed_ms: number | null;
  total_tests: number;
  successful_tests: number;
  failed_tests: number;
  timed_out_tests: number;
  success_rate: number | null;
  avg_elapsed_ms: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type ScheduledTestRunWithItems = ScheduledTestRun & {
  items: ScheduledTestItem[];
};

function getStatusBadgeColor(status: string): string {
  switch (status) {
    case 'queued':
      return 'border-slate-400 bg-slate-100 text-slate-900';
    case 'in_progress':
      return 'border-blue-400 bg-blue-100 text-blue-900';
    case 'completed':
      return 'border-green-400 bg-green-100 text-green-900';
    case 'failed':
      return 'border-red-400 bg-red-100 text-red-900';
    default:
      return 'border-slate-300 bg-slate-50 text-slate-600';
  }
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
  const successRate = run.success_rate ?? 0;
  const successRatePercent = Math.round(successRate * 100);

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
          {formatEasternTime(run.sweep_triggered_at)}
        </TableCell>
        <TableCell>
          <Badge className={`border ${getStatusBadgeColor(run.status)}`}>
            {run.status}
          </Badge>
        </TableCell>
        <TableCell className="text-center text-sm text-slate-600">
          {run.total_tests ?? 0}
        </TableCell>
        <TableCell className="text-center text-sm text-slate-600">
          <span className="font-medium text-green-700">
            {run.successful_tests ?? 0}
          </span>
          /
          <span className="font-medium text-red-700">
            {run.failed_tests ?? 0}
          </span>
          /
          <span className="font-medium text-orange-700">
            {run.timed_out_tests ?? 0}
          </span>
        </TableCell>
        <TableCell className="text-center text-sm text-slate-600">
          {successRatePercent}%
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
                    const itemPassRate =
                      item.items_total && item.items_total > 0
                        ? Math.round(
                            ((item.items_passed ?? 0) / item.items_total) * 100,
                          )
                        : 0;

                    return (
                      <TableRow
                        key={item.id}
                        className="border-b border-slate-100 hover:bg-slate-100"
                      >
                        <TableCell className="py-2 text-slate-900">
                          {item.test_name}
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
                          <span className="font-medium text-green-700">
                            {item.items_passed ?? 0}
                          </span>
                          /
                          <span className="font-medium text-red-700">
                            {item.items_failed ?? 0}
                          </span>
                          /
                          <span className="text-slate-700">
                            {item.items_total ?? 0}
                          </span>
                        </TableCell>
                        <TableCell className="py-2 text-center text-slate-600">
                          {itemPassRate}%
                        </TableCell>
                        <TableCell className="py-2 text-slate-600">
                          {item.error_code ? (
                            <code className="rounded bg-red-50 px-2 py-1 text-xs font-mono text-red-900">
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
