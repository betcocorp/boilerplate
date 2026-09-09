/**
 * B0-580 — golden-set tier cards for the Bex Health dashboard (epic B0-569): one card per
 * tier in use, each with the pass-rate headline, a gap-preserving sparkline over the selected
 * window, a status line derived from the STORED target (`tierStatusLine` → `verdictForTier`),
 * the delta vs the preceding equal-length window, and the failing-count link.
 *
 * Async server component; presentation only. Cards are rendered from DATA — the union of
 * `GOLDEN_TIERS`, the `tier_targets` rows, and the rollup's tiers — so a fourth tier appearing
 * in either source gets a card without a code change. A selection with no golden-set run shows
 * the explicit empty state, never 0%.
 */

import { InfoIcon } from 'lucide-react';
import Link from 'next/link';

import {
  describeVersionSelection,
  toGoldenSetVersionQuery,
  utcDay,
  type HealthPanelProps,
} from '~/lib/bex-health/search-params';
import { formatPassRatePercent, tierStatusLine, type TierStatusTone } from '~/lib/bex-health/verdict';
import { GOLDEN_TIERS, getGoldenSetTierRollup } from '~/lib/tests/golden-set';
import { getGoldenSetTrendForWindow, type TierTrendPoint } from '~/lib/tests/golden-set-trend';
import { getTierTargets } from '~/lib/tests/tier-targets';

import { ProvenanceFooter } from './ProvenanceFooter';
import { TierSparkline, type TierSparklinePoint } from './TierSparkline';

/**
 * B0-584 — verified against `getGoldenSetTierRollup`, `getTierTargets` and
 * `getGoldenSetTrendForWindow`; keep in sync with them.
 */
const TIER_CARD_SOURCES = [
  'Pass rates & failing counts: test_result_items.passed × test_items.priority, scoped to golden-set membership (tests.is_golden), from each golden test’s latest completed full-mode run (test_results) in the selected window/version',
  'Targets, gate flags & tier labels: tier_targets',
  'Sparklines & deltas: the same tables, folded per EST day of test_results.created_at; delta is vs the preceding equal-length window',
];

const FAILURE_QUEUE_HREF = '/admin/tests/failure-queue';
const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_TEXT_STYLES: Record<TierStatusTone, string> = {
  critical: 'text-red-700',
  warning: 'text-amber-700',
  ok: 'text-emerald-700',
  neutral: 'text-slate-500',
};

const STATUS_DOT_STYLES: Record<TierStatusTone, string> = {
  critical: 'bg-red-500',
  warning: 'bg-amber-500',
  ok: 'bg-emerald-500',
  neutral: 'bg-slate-400',
};

/** Every EST day from `fromDay` to `toDay` inclusive, as `YYYY-MM-DD`. */
function enumerateDays(fromDay: string, toDay: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${toDay}T00:00:00.000Z`);
  for (let t = Date.parse(`${fromDay}T00:00:00.000Z`); t <= end; t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** Per-day sparkline points for one tier; days without a run stay `null` (gaps, never zeros). */
function sparklineFor(series: TierTrendPoint[], tier: number, days: string[]): TierSparklinePoint[] {
  const rateByDay = new Map<string, number>();
  for (const point of series) {
    if (point.tier !== tier || point.total === 0) continue;
    rateByDay.set(point.day, (point.passed / point.total) * 100);
  }
  return days.map((day) => ({ day, rate: rateByDay.get(day) ?? null }));
}

function formatDelta(delta: number): string {
  const arrow = delta > 0 ? '↗' : delta < 0 ? '↘' : '→';
  return `${arrow} ${Math.abs(delta).toFixed(1)} pts`;
}

export async function TierCards({ window, version }: HealthPanelProps) {
  const windowIso = { from: window.from.toISOString(), to: window.to.toISOString() };
  const versionQuery = toGoldenSetVersionQuery(version);

  const [rollup, targets, trend] = await Promise.all([
    getGoldenSetTierRollup({ ...versionQuery, window: windowIso }),
    getTierTargets(),
    getGoldenSetTrendForWindow({ window: windowIso, version: versionQuery.version }),
  ]);

  // Tiers in use come from the data, not a hardcoded trio.
  const tiers = [
    ...new Set<number>([
      ...GOLDEN_TIERS,
      ...targets.map((target) => target.tier),
      ...(rollup.kind === 'rollup' ? rollup.tiers.map((tier) => tier.tier) : []),
    ]),
  ].sort((a, b) => a - b);

  const days = enumerateDays(utcDay(window.from), utcDay(window.to));
  const deltaByTier = trend.deltaByTier as Record<number, number | null | undefined>;

  const emptyStateText =
    rollup.kind === 'no_golden_sets'
      ? 'No golden sets configured — mark a test as golden on /admin/tests.'
      : rollup.kind === 'no_golden_run_for_version'
        ? `No golden-set run for this selection (${describeVersionSelection(version)}, ${utcDay(window.from)} → ${utcDay(window.to)}).`
        : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {tiers.map((tier) => {
        const target = targets.find((candidate) => candidate.tier === tier);
        const tierRollup =
          rollup.kind === 'rollup'
            ? rollup.tiers.find((candidate) => candidate.tier === tier)
            : undefined;
        const passRate = tierRollup?.passRate ?? null;
        const status = target
          ? tierStatusLine(target, passRate)
          : { label: 'No target configured', tone: 'neutral' as const };

        const sparkline = sparklineFor(trend.series, tier, days);
        const hasSeries = sparkline.some((point) => point.rate !== null);
        const delta = deltaByTier[tier] ?? null;

        const failingCount = tierRollup ? tierRollup.gradedCount - tierRollup.passedCount : null;

        return (
          <section
            className="flex flex-col rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
            key={tier}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                Golden set · Tier {tier}
                {target ? (
                  // Info affordance: the tier's STORED label explains what the tier is.
                  <span className="inline-flex" title={target.label}>
                    <InfoIcon aria-hidden className="size-3.5 shrink-0 text-slate-400" />
                    <span className="sr-only">{target.label}</span>
                  </span>
                ) : null}
              </h2>
              <p
                className={[
                  'flex items-center gap-1.5 text-xs font-medium',
                  STATUS_TEXT_STYLES[status.tone],
                ].join(' ')}
              >
                <span
                  aria-hidden
                  className={`inline-block size-2 rounded-full ${STATUS_DOT_STYLES[status.tone]}`}
                />
                {status.label}
              </p>
            </div>

            {emptyStateText !== null || passRate === null ? (
              <>
                <p className="mt-4 text-3xl font-semibold tabular-nums text-slate-300">—</p>
                <p className="mt-2 text-sm text-slate-500">
                  {emptyStateText ?? 'No graded golden-set rows for this tier in the selection.'}
                </p>
              </>
            ) : (
              <p className="mt-4 text-3xl font-semibold tabular-nums text-slate-950">
                {formatPassRatePercent(passRate)}
              </p>
            )}

            <div className="mt-4">
              {hasSeries ? (
                <TierSparkline data={sparkline} />
              ) : (
                <div className="flex h-14 items-center justify-center rounded-xl bg-slate-50">
                  <p className="text-xs text-slate-400">No golden-set runs in this window</p>
                </div>
              )}
            </div>

            <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3 text-xs">
              {/* Delta vs the preceding equal-length window; absent when no comparison exists. */}
              {delta !== null ? (
                <span
                  className={[
                    'font-medium tabular-nums',
                    delta < 0 ? 'text-red-700' : delta > 0 ? 'text-emerald-700' : 'text-slate-500',
                  ].join(' ')}
                >
                  {formatDelta(delta)}
                </span>
              ) : (
                <span className="text-slate-400">No prior-window data</span>
              )}

              {tierRollup && failingCount !== null && tierRollup.gradedCount > 0 ? (
                <Link
                  className="tabular-nums text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900"
                  href={FAILURE_QUEUE_HREF}
                >
                  {failingCount} of {tierRollup.gradedCount} failing
                </Link>
              ) : (
                <span className="text-slate-400">No graded prompts</span>
              )}
            </div>
          </section>
        );
      })}

      {/* One provenance footer for the whole panel, spanning the card row. */}
      <div className="lg:col-span-3">
        <ProvenanceFooter sources={TIER_CARD_SOURCES} />
      </div>
    </div>
  );
}
