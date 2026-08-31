/**
 * B0-761 — the three headline tiles: total events, distinct event names, and the busiest event.
 *
 * Every value is safe at zero: the counts render `0` and the "top event" tile falls back to an em
 * dash plus an explanatory line rather than a blank card.
 */

import { formatInt } from '~/components/admin/projects/format';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import type { EventAnalyticsSummary } from '~/lib/event-logging/analytics-repository';

import { truncateEvent } from './format';

export function AnalyticsKpiTiles({ data }: { data: EventAnalyticsSummary }) {
  const leading = data.topEvents[0];

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <Card className="rounded-3xl border-border/60 shadow-none">
        <CardHeader className="pb-2">
          <CardDescription>Total events</CardDescription>
          <CardTitle className="text-3xl tabular-nums">{formatInt(data.totalInRange)}</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          In the selected {data.days}-day window.
        </CardContent>
      </Card>

      <Card className="rounded-3xl border-border/60 shadow-none">
        <CardHeader className="pb-2">
          <CardDescription>Distinct event names</CardDescription>
          <CardTitle className="text-3xl tabular-nums">
            {formatInt(data.uniqueEventNames)}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          Unique <code className="text-foreground/80">event</code> strings recorded.
        </CardContent>
      </Card>

      <Card className="rounded-3xl border-border/60 shadow-none">
        <CardHeader className="pb-2">
          <CardDescription>Top event</CardDescription>
          <CardTitle className="line-clamp-2 text-base leading-snug font-semibold">
            {leading ? truncateEvent(leading.event, 64) : '—'}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          {leading
            ? `${formatInt(leading.count)} occurrences · ${formatInt(leading.userCount)} unique ${
                leading.userCount === 1 ? 'user' : 'users'
              }`
            : 'No events in this range yet.'}
        </CardContent>
      </Card>
    </div>
  );
}
