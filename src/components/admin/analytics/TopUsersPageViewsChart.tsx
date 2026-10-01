'use client';

/** B0-761 — c360's "Top users — page views by day", one line per user. */

import type { EventAnalyticsSummary } from '~/lib/event-logging/analytics-repository';

import { UserDaySeriesChart } from './UserDaySeriesChart';

export function TopUsersPageViewsChart({
  data,
  days,
}: {
  data: EventAnalyticsSummary;
  days: number;
}) {
  return (
    <UserDaySeriesChart
      days={days}
      description={`Page-view events over the same ${days}-day window as the range picker. Top 10 users by total views; each line is that user's daily count.`}
      emptyMessage="No page views with user metadata in this range yet."
      rows={data.pageViewsByUserDay}
      title="Top users — page views by day"
    />
  );
}
