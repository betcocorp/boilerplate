/**
 * B0-761 — `/admin/analytics`, the Bex port of c360's event-analytics dashboard.
 *
 * Thin by convention, in the shape of `/admin`: `searchParams` fully determine the view
 * (`?days=`, `?groups=`) so the page is linkable and bookmarkable, and every piece of feature UI
 * lives under `~/components/admin/analytics/*`. `clampDays` / `parseGroupFilter` are the single
 * readers of those params — the dashboard's filter bar writes them back through the router, and the
 * two must agree, so neither side re-parses them locally.
 */

import { connection } from 'next/server';

import { EventAnalyticsDashboard } from '~/components/admin/analytics/EventAnalyticsDashboard';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import {
  clampDays,
  getEventAnalytics,
  parseGroupFilter,
} from '~/lib/event-logging/analytics-repository';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';

export const metadata = {
  title: 'Analytics | Betco BEX',
  description: 'Event volumes, sign-ins, page views, and recent activity from the event log.',
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminAnalyticsPage({ searchParams }: PageProps) {
  await requirePagePermission(PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS, 'GET /admin/analytics');
  await connection();
  const params = await searchParams;
  const rawDays = params.days;
  const days = clampDays(Array.isArray(rawDays) ? rawDays[0] : rawDays);
  const groups = parseGroupFilter(params.groups);

  const data = await getEventAnalytics(days, groups);

  return (
    <main className="min-w-0 space-y-6 p-4 sm:p-6">
      <div>
        <p className="text-sm text-muted-foreground">Product</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What people are doing in Bex — event volumes, sign-ins, page views, and the busiest hours
          over the last {days} days.
        </p>
      </div>

      {data ? (
        <EventAnalyticsDashboard data={data} days={days} />
      ) : (
        // `getEventAnalytics` returns null when the event log cannot be read at all (the table is
        // not there yet, or the query failed). That is a different story from "no events", so it
        // gets its own message rather than an empty dashboard implying zero activity.
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Analytics are unavailable</CardTitle>
            <CardDescription>
              The event log could not be read just now, so no numbers are shown — an empty dashboard
              here would wrongly read as zero activity. Reload in a moment; if it persists, check the
              event-log table and the server logs.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Nothing was lost — events keep being recorded while this page is down.
          </CardContent>
        </Card>
      )}
    </main>
  );
}
