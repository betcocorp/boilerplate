'use client';

/** B0-761 — c360's "Top users — successful logins by day", one line per user. */

import type { EventAnalyticsSummary } from '~/lib/event-logging/analytics-repository';

import { UserDaySeriesChart } from './UserDaySeriesChart';

export function TopUsersLoginChart({
  data,
  days,
}: {
  data: EventAnalyticsSummary;
  days: number;
}) {
  return (
    <UserDaySeriesChart
      days={days}
      description={`Successful sign-ins only, over the selected ${days}-day window. Top 10 users by total logins; each line is that user's daily count.`}
      emptyMessage="No successful logins with user metadata in this range."
      rows={data.loginTopUsersByDay}
      title="Top users — successful logins by day"
    />
  );
}
