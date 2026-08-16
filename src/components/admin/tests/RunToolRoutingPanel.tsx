import Link from 'next/link';

import { Badge } from '~/components/ui/badge';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import type { ToolRoutingReport } from '~/lib/tests/tool-routing';

type RunToolRoutingPanelProps = {
  testId: string;
  report: ToolRoutingReport;
};

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * B0-383 — per-run tool-call frequency + routing-accuracy panel.
 *
 * `report.scoredItemCount` is the number of questions in this run whose `test_items.metadata`
 * carries an `expected_tool` (set via the `expected_tool` CSV column, see `~/lib/tests/template.ts`);
 * everything else is call-frequency only, since there is no expectation to score against.
 */
export function RunToolRoutingPanel({ testId, report }: RunToolRoutingPanelProps) {
  const { frequency, scoredItemCount, matchedItemCount, routingAccuracy, mismatches, unknownExpectedTools } =
    report;
  const totalCalls = frequency.reduce((sum, datum) => sum + datum.callCount, 0);
  const maxCallCount = frequency.reduce((max, datum) => Math.max(max, datum.callCount), 0);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Tool routing</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Which of the 14 product-support tools this run actually called, and — for questions
            tagged with an <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">expected_tool</code>{' '}
            — whether the model routed to the right one.
          </p>
        </div>
        {routingAccuracy !== null ? (
          <Badge
            className={
              routingAccuracy >= 0.8
                ? 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900'
                : routingAccuracy >= 0.5
                  ? 'border-amber-500/45 bg-amber-500/12 text-amber-900'
                  : 'border-red-600/45 bg-red-600/12 text-red-900'
            }
            variant="outline"
          >
            {formatPercent(routingAccuracy)} routing accuracy ({matchedItemCount}/{scoredItemCount} scored)
          </Badge>
        ) : (
          <Badge variant="secondary">
            No {'"expected_tool"'} set on this test&apos;s items — nothing to score
          </Badge>
        )}
      </div>

      {unknownExpectedTools.length > 0 ? (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          {unknownExpectedTools.length === 1 ? 'This expected_tool value' : 'These expected_tool values'}{' '}
          {unknownExpectedTools.map((name) => (
            <code key={name} className="mx-0.5 rounded bg-white px-1 py-0.5">
              {name}
            </code>
          ))}
          {unknownExpectedTools.length === 1 ? "isn't" : "aren't"} one of the 14 live tool names —
          check for a typo.
        </p>
      ) : null}

      {frequency.length === 0 ? (
        <p className="text-sm text-slate-500">
          No tool calls were recorded for this run (every item either early-declined or predates
          tool-trace capture).
        </p>
      ) : (
        <div className="mb-8 space-y-2">
          {frequency.map((datum) => (
            <div key={datum.toolName} className="flex items-center gap-3">
              <span className="w-56 shrink-0 truncate font-mono text-xs text-slate-700" title={datum.toolName}>
                {datum.toolName}
                {!datum.known ? (
                  <Badge className="ml-1.5 align-middle" title="Not one of the 14 live tool names" variant="destructive">
                    unknown
                  </Badge>
                ) : null}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-sky-600"
                  style={{
                    width: `${maxCallCount > 0 ? Math.max(4, (datum.callCount / maxCallCount) * 100) : 0}%`,
                  }}
                />
              </div>
              <span className="w-32 shrink-0 whitespace-nowrap text-right text-xs text-slate-600">
                {datum.callCount} call{datum.callCount === 1 ? '' : 's'} · {datum.itemCount} item
                {datum.itemCount === 1 ? '' : 's'}
              </span>
            </div>
          ))}
          <p className="pt-1 text-xs text-slate-400">{totalCalls} total tool calls across this run.</p>
        </div>
      )}

      {mismatches.length > 0 ? (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-slate-800">
            Misrouted questions ({mismatches.length})
          </h3>
          <div className="max-h-[min(60vh,32rem)] overflow-auto overscroll-contain rounded-xl border border-slate-100">
            <table className="w-full caption-bottom text-sm">
              <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226,232,240)] [&_tr]:border-b-0">
                <TableRow>
                  <TableHead>Row</TableHead>
                  <TableHead>Prompt</TableHead>
                  <TableHead>Expected tool</TableHead>
                  <TableHead>Offending tool call</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mismatches.map((mismatch) => (
                  <TableRow key={mismatch.resultItemId}>
                    <TableCell className="align-top">{mismatch.rowIndex}</TableCell>
                    <TableCell className="max-w-md align-top text-xs text-slate-700">
                      <span className="line-clamp-3">{mismatch.prompt}</span>
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge variant="outline">
                        <code>{mismatch.expectedTool}</code>
                      </Badge>
                    </TableCell>
                    <TableCell className="align-top">
                      {mismatch.calledTools.length === 0 ? (
                        <Badge variant="destructive">no tool called</Badge>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {mismatch.calledTools.map((toolName, index) => (
                            <Badge key={`${toolName}-${index}`} variant="destructive">
                              <code>{toolName}</code>
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right align-top">
                      <Link
                        className="text-xs text-sky-700 underline-offset-2 hover:underline"
                        href={`/admin/tests/${testId}/items/${mismatch.testItemId}`}
                      >
                        Item history
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </table>
          </div>
        </div>
      ) : scoredItemCount > 0 ? (
        <p className="text-sm text-emerald-700">
          All {scoredItemCount} scored question{scoredItemCount === 1 ? '' : 's'} routed to the
          expected tool.
        </p>
      ) : null}
    </section>
  );
}
