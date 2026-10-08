import Link from 'next/link';

import { ReportChangeCell } from '~/components/admin/tests/ReportChangeCell';
import { getStatusBadgeColor } from '~/components/admin/tests/sweep-status';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { describeThursdayScorecardScore } from '~/lib/tests/report-row-format';
import type {
  ThursdayScorecardHistory,
  ThursdayScorecardHistoryCell,
  ThursdayScorecardHistoryRow,
} from '~/lib/tests/thursday-scorecard-schemas';
import { formatEasternSweepLabel } from '~/lib/utils/time';

/**
 * B0-1170 — every Thursday report card as one row, newest first, one column per agent that
 * appeared in any sweep. Content result only (score / grade / change); supporting metrics live
 * on the individual card. Renders only from the history object — nothing here re-queries.
 * Server-safe.
 */

const SWEEP_STATUS_WORDS: Record<ThursdayScorecardHistoryRow['sweep']['status'], string> = {
  queued: 'Queued',
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
};

/** Grade tint — the text already carries the grade, so colour is never the only signal. */
function gradeTint(grade: ThursdayScorecardHistoryCell['grade']): string {
  switch (grade) {
    case 'A':
    case 'B':
      return 'bg-emerald-50';
    case 'C':
      return 'bg-amber-50';
    case 'D':
    case 'F':
      return 'bg-rose-50';
    default:
      return '';
  }
}

function cardHref(sweepId: string): string {
  return `/admin/tests/reports/scorecards/${sweepId}`;
}

export function ThursdayScorecardHistoryTable({
  history,
}: {
  history: ThursdayScorecardHistory;
}) {
  const fixedColumnCount = 5;
  const columnCount = fixedColumnCount + history.agentColumns.length;

  return (
    <div className="relative max-h-[60vh] overflow-auto overscroll-contain rounded-2xl border border-slate-200">
      <table className="w-full min-w-[900px] caption-bottom text-sm">
        <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226,232,240)] [&_tr]:border-b-0">
          <TableRow>
            <TableHead title="When the Thursday-night sweep was triggered, in Eastern time">
              Thursday
            </TableHead>
            <TableHead title="The sweep ledger's status for that night">Sweep</TableHead>
            <TableHead title="Agents whose run completed, of the agents dispatched">Ran</TableHead>
            <TableHead title="Agents with a persisted score, of the agents in the sweep">
              Scored
            </TableHead>
            {history.agentColumns.map((column) => (
              <TableHead key={column.key} title={column.key}>
                {column.label}
              </TableHead>
            ))}
            <TableHead title="Opens that night's report card">Report card</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {history.rows.length === 0 ? (
            <TableRow>
              <TableCell className="text-slate-500" colSpan={columnCount}>
                No Thursday-night sweep recorded yet.
              </TableCell>
            </TableRow>
          ) : (
            history.rows.map((row) => {
              const label = formatEasternSweepLabel(row.sweep.sweepTriggeredAt);
              const previousLabel = row.previousSweep
                ? formatEasternSweepLabel(row.previousSweep.sweepTriggeredAt)
                : null;
              const cellByAgentKey = new Map(row.cells.map((cell) => [cell.agentKey, cell]));
              return (
                <TableRow key={row.sweep.id}>
                  <TableCell className="whitespace-nowrap font-medium">
                    <Link
                      className="text-sky-700 underline-offset-2 hover:underline"
                      href={cardHref(row.sweep.id)}
                    >
                      {label}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Badge className={`border ${getStatusBadgeColor(row.sweep.status)}`}>
                      {SWEEP_STATUS_WORDS[row.sweep.status]}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className="whitespace-nowrap tabular-nums text-slate-700"
                    title={`${row.sweep.failedTests} failed · ${row.sweep.timedOutTests} timed out`}
                  >
                    {`${row.sweep.successfulTests} of ${row.sweep.totalTests}`}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                    {`${row.scoredCount} of ${row.cells.length}`}
                  </TableCell>
                  {history.agentColumns.map((column) => {
                    const cell = cellByAgentKey.get(column.key);
                    if (!cell) {
                      return (
                        <TableCell
                          className="whitespace-nowrap text-slate-400"
                          key={column.key}
                          title="Not part of this sweep"
                        >
                          —
                        </TableCell>
                      );
                    }
                    return (
                      <TableCell
                        className={`whitespace-nowrap tabular-nums text-slate-700 ${gradeTint(cell.grade)}`}
                        key={column.key}
                        title={cell.agentLabel}
                      >
                        <span className="flex flex-col items-start gap-0.5">
                          <span>{describeThursdayScorecardScore(cell)}</span>
                          {cell.change ? (
                            <ReportChangeCell
                              change={cell.change}
                              previousTitle={
                                previousLabel
                                  ? `Previous Thursday-night sweep (${previousLabel}): ${cell.change.previousScore}/100`
                                  : undefined
                              }
                              score={cell.score}
                            />
                          ) : null}
                        </span>
                      </TableCell>
                    );
                  })}
                  <TableCell>
                    <Button asChild size="sm" variant="outline">
                      <Link href={cardHref(row.sweep.id)}>View card</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </table>
    </div>
  );
}
