/**
 * B0-581 — "Live traffic" card for the Bex Health dashboard: a six-tile grid
 * (Runs · Failed · Avg confidence · TTFT/elapsed · Tokens per run · Orphaned)
 * plus the confidence spread bar.
 *
 * Async server component; presentation only. All figures come from ONE window
 * scan (`getAggregateDashboardData`), shaped by `~/lib/observability/live-traffic.ts`.
 */

import { getAggregateDashboardData } from '~/lib/observability/aggregates';
import {
  buildConfidenceSpread,
  buildLiveTrafficTiles,
  type ConfidenceSpreadSegment,
  type LiveTrafficTile,
} from '~/lib/observability/live-traffic';

import type { HealthPanelProps } from '~/lib/bex-health/search-params';

import { ProvenanceFooter } from './ProvenanceFooter';

/** B0-584 — verified against `getAggregateDashboardData` / `scanWorkflowRuns`; keep in sync with them. */
const LIVE_TRAFFIC_SOURCES = [
  'workflow_runs — status, confidence, final_output.timingBreakdown and final_output.usage, filtered to the selected window/version',
  'TTFT falls back to the harness’s test_result_items.ttft_ms when a run recorded no timingBreakdown; Orphaned = runs still “running” past the staleness threshold',
];

const SPREAD_COLORS: Record<ConfidenceSpreadSegment['bucket'], string> = {
  // Same palette as the aggregate dashboard's confidence-health chart.
  high: 'bg-green-600',
  mid: 'bg-amber-500',
  low: 'bg-red-600',
  none: 'bg-slate-400',
};

function Tile({ tile }: { tile: LiveTrafficTile }) {
  const warn = tile.tone === 'warning';
  return (
    <div
      className={
        warn
          ? 'min-w-0 rounded-2xl border border-amber-300 bg-amber-50 p-5'
          : 'min-w-0 rounded-2xl border border-slate-200 p-5'
      }
    >
      <p
        className={
          warn
            ? 'text-xs font-medium uppercase tracking-wide text-amber-700'
            : 'text-xs font-medium uppercase tracking-wide text-slate-500'
        }
      >
        {tile.label}
      </p>
      <p
        className={[
          'mt-2 whitespace-nowrap text-xl font-semibold tabular-nums',
          warn ? 'text-amber-900' : 'text-slate-950',
        ].join(' ')}
      >
        {tile.value}
      </p>
      {tile.hint ? (
        <p className={warn ? 'mt-1 text-xs text-amber-700' : 'mt-1 text-xs text-slate-500'}>
          {tile.hint}
        </p>
      ) : null}
    </div>
  );
}

export async function LiveTrafficCard({ window, version }: HealthPanelProps) {
  const data = await getAggregateDashboardData(
    { from: window.from.toISOString(), to: window.to.toISOString() },
    { version },
  );

  const tiles = buildLiveTrafficTiles(data);
  const spread = buildConfidenceSpread(data.confidenceBuckets);
  const spreadTotal = spread.reduce((sum, segment) => sum + segment.count, 0);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900">Live traffic</h2>
        <p className="text-xs tabular-nums text-slate-500">
          {data.windowFrom.slice(0, 10)} → {data.windowTo.slice(0, 10)}
        </p>
      </div>

      {/* The six tiles — one equal-width row at lg. */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((tile) => (
          <Tile key={tile.key} tile={tile} />
        ))}
      </div>

      {/* Confidence spread — High / Mid / Low / None over every run in the window. */}
      <div className="mt-6">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Confidence spread
        </p>
        {spreadTotal === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No runs in this window.</p>
        ) : (
          <>
            <div
              aria-hidden
              className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-slate-100"
            >
              {spread
                .filter((segment) => segment.count > 0)
                .map((segment) => (
                  <div
                    className={SPREAD_COLORS[segment.bucket]}
                    key={segment.bucket}
                    style={{ width: `${segment.percent}%` }}
                    title={`${segment.label}: ${segment.count}`}
                  />
                ))}
            </div>
            <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
              {spread.map((segment) => (
                <div className="flex items-center gap-1.5" key={segment.bucket}>
                  <span
                    className={`inline-block size-2 shrink-0 rounded-full ${SPREAD_COLORS[segment.bucket]}`}
                  />
                  <dt className="text-slate-600">{segment.label}</dt>
                  <dd className="tabular-nums text-slate-500">
                    {segment.count.toLocaleString('en-US')}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>

      <ProvenanceFooter sources={LIVE_TRAFFIC_SOURCES} />
    </section>
  );
}
