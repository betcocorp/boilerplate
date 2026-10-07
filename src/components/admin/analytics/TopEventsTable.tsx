/**
 * B0-761 — c360's "Top events" table: the most frequent event names in range, with unique users.
 *
 * The event column can hold long dotted names, so the table scrolls inside its own container rather
 * than widening the page.
 */

import { formatInt } from '~/components/admin/analytics/format';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import type { EventAnalyticsSummary } from '~/lib/event-logging/analytics-repository';

import { AnalyticsPanel } from './panel';

export function TopEventsTable({ data }: { data: EventAnalyticsSummary }) {
  return (
    <AnalyticsPanel
      description="Most frequent event names in range (max 10)."
      emptyMessage="No events recorded yet."
      emptyMinHeightClassName="min-h-[160px]"
      isEmpty={data.topEvents.length === 0}
      title="Top events"
    >
      <div className="max-h-72 overflow-x-auto overflow-y-auto rounded-2xl border border-border/60">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="border-border/60 hover:bg-transparent">
              <TableHead className="w-10 bg-card">#</TableHead>
              <TableHead className="bg-card">Event</TableHead>
              <TableHead className="bg-card text-right">Count</TableHead>
              <TableHead className="bg-card text-right">Users</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.topEvents.map((row, index) => (
              <TableRow className="border-border/60" key={`${row.event}-${index}`}>
                <TableCell className="tabular-nums text-muted-foreground">{index + 1}</TableCell>
                <TableCell>
                  <span className="font-mono text-xs wrap-break-word">{row.event}</span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(row.count)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatInt(row.userCount)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </AnalyticsPanel>
  );
}
