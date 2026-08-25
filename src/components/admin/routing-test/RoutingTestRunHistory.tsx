import Link from 'next/link';

import { Button } from '~/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { ROUTING_TEST_ROUTER_LABELS } from '~/lib/routing-test/constants';
import { formatRoutingTestRunScore } from '~/lib/routing-test/scoring';
import type { RoutingTestRunRecord } from '~/lib/routing-test/types';
import { formatDate, formatDurationSeconds } from '~/lib/utils/time';

type RoutingTestRunHistoryProps = {
  runs: RoutingTestRunRecord[];
};

/**
 * B0-667 — persisted run history, newest first. Every "Run" click on `RoutingTestWorkbench` writes
 * one `routing_test_runs` row here as a side effect of `runRoutingTestAction`; this table is a
 * plain server-rendered list with no client state of its own — each row links to the per-item
 * drill-down at `/admin/routing-test/runs/[runId]`.
 */
export function RoutingTestRunHistory({ runs }: RoutingTestRunHistoryProps) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-slate-900">Run history</h2>
        <p className="text-sm text-slate-600">
          {runs.length} {runs.length === 1 ? 'run' : 'runs'} recorded
        </p>
      </div>

      {runs.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-12 text-center">
          <p className="text-sm font-medium text-slate-900">No runs yet</p>
          <p className="max-w-md text-sm text-slate-600">
            Every Run above is saved here automatically — hit Run on the
            workbench to start your first history entry.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ran at</TableHead>
                <TableHead>Router</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Avg item</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="text-sm text-slate-800">
                    <Link
                      className="text-sky-700 underline-offset-2 hover:underline"
                      href={`/admin/routing-test/runs/${run.id}`}
                    >
                      {formatDate(run.ran_at)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-slate-800">
                    {ROUTING_TEST_ROUTER_LABELS[run.router_type]}
                  </TableCell>
                  <TableCell className="text-sm font-medium text-slate-900">
                    {formatRoutingTestRunScore(run.passed_items, run.total_items)}
                  </TableCell>
                  <TableCell className="text-sm text-slate-700">
                    {formatDurationSeconds(run.duration_ms)}
                  </TableCell>
                  <TableCell className="text-sm text-slate-700">
                    {run.avg_item_duration_ms !== null
                      ? `${Math.round(run.avg_item_duration_ms)}ms`
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/admin/routing-test/runs/${run.id}`}>
                        View
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
