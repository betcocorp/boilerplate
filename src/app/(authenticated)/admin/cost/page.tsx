/**
 * B0-567 — cost monitoring dashboard (epic B0-562). Server component: the default 1-day view is
 * fetched directly via `getCostMetrics` (same function `GET /api/bex/cost/metrics` calls), so the
 * first paint needs no client round trip. Range/YoY changes re-fetch through that API route.
 */

import { CostDashboard } from '~/components/admin/cost/CostDashboard';
import { getCostMetrics } from '~/lib/observability/cost-metrics';

export const metadata = {
  title: 'Cost monitoring | Betco BEX',
  description: 'OpenAI spend by model, daily/monthly, with year-over-year comparison.',
};

export default async function CostMonitoringPage() {
  const initial = await getCostMetrics({
    timeRange: '1d',
    groupBy: 'day',
    compareYoY: false,
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Cost monitoring</h1>
        <p className="text-sm text-muted-foreground">
          Estimated OpenAI spend across Bex workflow steps, by model.
        </p>
      </div>
      <CostDashboard initial={initial} />
    </div>
  );
}
