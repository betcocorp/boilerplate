'use client';

/**
 * B0-761 — c360's "Recent activity" table: the newest rows in range (max 25).
 *
 * Client-side on purpose — `formatEventTimestamp` renders in the VIEWER's EST timezone, and doing that
 * on the server would stamp the deploy region's clock onto everyone's screen.
 */

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import type { EventAnalyticsSummary } from '~/lib/event-logging/analytics-repository';

import { formatEventTimestamp } from './format';
import { AnalyticsPanel } from './panel';

/** c360 caps this list at 25; the repository may hand back more, so cap here too. */
const MAX_ROWS = 25;

export function RecentActivityTable({ data }: { data: EventAnalyticsSummary }) {
  const rows = data.recent.slice(0, MAX_ROWS);

  return (
    <AnalyticsPanel
      description={`Newest rows in range (max ${MAX_ROWS}).`}
      emptyMessage="No events recorded yet."
      emptyMinHeightClassName="min-h-[160px]"
      isEmpty={rows.length === 0}
      title="Recent activity"
    >
      <div className="max-h-72 overflow-x-auto overflow-y-auto rounded-2xl border border-border/60">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="border-border/60 hover:bg-transparent">
              <TableHead className="bg-card">When</TableHead>
              <TableHead className="bg-card">Event</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow className="border-border/60" key={row.id}>
                {/* Rendered in the viewer's EST timezone, so the SSR pass and the client can legitimately differ. */}
                <TableCell
                  className="text-xs whitespace-nowrap tabular-nums text-muted-foreground"
                  suppressHydrationWarning
                >
                  {formatEventTimestamp(row.created_at)}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs wrap-break-word">{row.event}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </AnalyticsPanel>
  );
}
