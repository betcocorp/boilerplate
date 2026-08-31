'use client';

/**
 * B0-761 — composition root for `/admin/analytics`, the Bex port of c360's event-analytics
 * dashboard. c360's original is one 983-line client file; here the filter bar and every panel is
 * its own sibling component and this file only arranges them.
 *
 * Client, not server, for one reason: the filters write `?days=` / `?groups=` through the router, so
 * the whole view is reproducible from its URL. Everything below the filters is pure presentation
 * over the server-resolved `EventAnalyticsSummary`.
 *
 * Empty-data behaviour: `public.event_logging` is brand new, so an empty page is the expected FIRST
 * view, not an edge case. Each panel guards itself (so a partial corpus — events but no logins, say
 * — still renders every card sensibly), and when the whole window is empty the charts are replaced
 * by a single explanatory card rather than eight empty frames.
 */

import type { EventAnalyticsSummary } from '~/lib/event-logging/analytics-repository';

import { AnalyticsFilters } from './AnalyticsFilters';
import { AnalyticsKpiTiles } from './AnalyticsKpiTiles';
import { EventsPerDayChart } from './EventsPerDayChart';
import { LoginAttemptsChart } from './LoginAttemptsChart';
import { AnalyticsPanel } from './panel';
import { RecentActivityTable } from './RecentActivityTable';
import { TopEventsTable } from './TopEventsTable';
import { TopPageMixChart } from './TopPageMixChart';
import { TopUsersLoginChart } from './TopUsersLoginChart';
import { TopUsersPageViewsChart } from './TopUsersPageViewsChart';
import { TrafficByHourChart } from './TrafficByHourChart';

export function EventAnalyticsDashboard({
  data,
  days,
}: {
  data: EventAnalyticsSummary;
  days: number;
}) {
  const selectedGroups = [...data.selectedGroups].sort((a, b) => a.localeCompare(b));

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">Event volumes</p>
        <AnalyticsFilters
          availableGroups={data.availableGroups}
          days={days}
          selectedGroups={selectedGroups}
        />
      </div>

      <AnalyticsKpiTiles data={data} />

      {data.totalInRange === 0 ? (
        <AnalyticsPanel
          description="Nothing has been logged in this window yet."
          emptyMessage="No events recorded yet. Once the app starts logging events they will appear here — try widening the range, or clearing the group filter."
          emptyMinHeightClassName="min-h-[140px]"
          isEmpty
          title="No data yet"
        >
          {null}
        </AnalyticsPanel>
      ) : (
        <>
          <TrafficByHourChart data={data} />
          <LoginAttemptsChart data={data} days={days} />
          <TopUsersLoginChart data={data} days={days} />
          <TopUsersPageViewsChart data={data} days={days} />

          <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-5">
            <EventsPerDayChart data={data} days={days} />
            <TopPageMixChart data={data} />
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
            <TopEventsTable data={data} />
            <RecentActivityTable data={data} />
          </div>
        </>
      )}
    </div>
  );
}
