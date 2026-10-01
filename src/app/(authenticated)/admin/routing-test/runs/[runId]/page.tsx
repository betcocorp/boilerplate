import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { z } from 'zod';

import { RoutingTestResultDetail } from '~/components/admin/routing-test/RoutingTestResultDetail';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { routingTestAgentLabel } from '~/lib/routing-test/agent-options';
import { ROUTING_TEST_ROUTER_LABELS } from '~/lib/routing-test/constants';
import { getRoutingTestRunWithItems } from '~/lib/routing-test/repository';
import { formatRoutingTestRunScore } from '~/lib/routing-test/scoring';
import type { RoutingTestItemResult } from '~/lib/routing-test/types';
import { formatDate, formatDurationSeconds } from '~/lib/utils/time';

export const metadata = {
  title: 'Routing Test Run | Betco BEX',
  description: 'Per-item drill-down for one persisted routing test run.',
};

type PageProps = {
  params: Promise<{ runId: string }>;
};

/** Next's dynamic segment is an untrusted string until validated — same convention as `./schemas.ts`. */
const runIdParamSchema = z.string().uuid();

/**
 * B0-667 — read-only drill-down for one persisted `routing_test_runs` row. Reconstructs a
 * `RoutingTestItemResult`-shaped object from each `routing_test_run_items` row so it can reuse
 * `RoutingTestResultDetail` unchanged — the same component the live, ephemeral workbench run uses
 * to render the `RoutingTestItemDetail` union (`~/components/admin/routing-test/RoutingTestResultDetail.tsx`).
 */
export default async function AdminRoutingTestRunDetailsPage({
  params,
}: PageProps) {
  await connection();
  const { runId } = await params;

  const parsedRunId = runIdParamSchema.safeParse(runId);
  if (!parsedRunId.success) {
    notFound();
  }

  const runWithItems = await getRoutingTestRunWithItems(parsedRunId.data);
  if (!runWithItems) {
    notFound();
  }

  const { run, items } = runWithItems;

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold tracking-[0.2em] text-sky-700 uppercase">
                Routing test run
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                {ROUTING_TEST_ROUTER_LABELS[run.router_type]} router ·{' '}
                {formatDate(run.ran_at)}
              </h1>
              <p className="mt-3 font-mono text-xs text-slate-600">
                Run id: {run.id}
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/routing-test">Back to routing test</Link>
            </Button>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                Score
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-900">
                {formatRoutingTestRunScore(run.passed_items, run.total_items)}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                Degraded
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-900">
                {run.degraded_items}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                Duration
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-900">
                {formatDurationSeconds(run.duration_ms)}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                Avg item
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-900">
                {run.avg_item_duration_ms !== null
                  ? `${Math.round(run.avg_item_duration_ms)}ms`
                  : '—'}
              </p>
            </div>
          </div>

          {run.warning ? (
            <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
              {run.warning}
            </p>
          ) : null}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-slate-900">
              Item-level results
            </h2>
            <p className="text-sm text-slate-600">
              {items.length} {items.length === 1 ? 'item' : 'items'}
            </p>
          </div>

          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-12 text-center">
              <p className="text-sm text-slate-600">
                No items were recorded for this run.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[35%]">Prompt</TableHead>
                    <TableHead>Expected agent</TableHead>
                    <TableHead>Predicted</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead className="w-[30%]">Router detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((row) => {
                    const itemResult: RoutingTestItemResult = {
                      itemId: row.item_id ?? row.id,
                      prompt: row.prompt,
                      expectedAgent: row.expected_agent,
                      predicted: row.predicted_agent,
                      passed: row.passed,
                      error: row.error,
                      detail: row.detail,
                      elapsedMs: row.elapsed_ms,
                    };

                    return (
                      <TableRow key={row.id}>
                        <TableCell className="max-w-md align-top text-sm whitespace-pre-wrap text-slate-800">
                          {row.prompt}
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex flex-col gap-0.5">
                            <span className="text-sm font-medium text-slate-900">
                              {routingTestAgentLabel(row.expected_agent)}
                            </span>
                            <span className="text-xs text-slate-500">
                              {row.expected_agent}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="align-top text-sm text-slate-800">
                          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">
                            {row.predicted_agent}
                          </code>
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge variant={row.passed ? 'default' : 'destructive'}>
                            {row.passed ? 'Pass' : 'Fail'}
                          </Badge>
                        </TableCell>
                        <TableCell className="align-top">
                          <RoutingTestResultDetail result={itemResult} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
