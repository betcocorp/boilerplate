/**
 * B0-579 — blocked/clear verdict strip for the Bex Health dashboard (epic B0-569).
 *
 * Async server component; presentation only. The verdict itself is derived by the pure
 * `deriveHealthVerdict` (`~/lib/bex-health/verdict.ts`) from the two canonical readers —
 * `getGoldenSetTierRollup` (scoped to the page's version + window selection) and
 * `getTierTargets` — so NO target literal appears here, and the three states
 * (BLOCKED / CLEAR / UNKNOWN) are unit-tested without a database.
 *
 * "Re-run sweep" deliberately builds no new harness plumbing: golden-set sweeps are started
 * per test from /admin/tests (`runTestAction`), so the action here is a link there with a
 * title explaining exactly that.
 */

import Link from 'next/link';

import {
  describeVersionSelection,
  toGoldenSetVersionQuery,
  utcDay,
  type HealthPanelProps,
} from '~/lib/bex-health/search-params';
import {
  deriveHealthVerdict,
  formatPassRatePercent,
  type HealthVerdictState,
} from '~/lib/bex-health/verdict';
import { getGoldenSetTierRollup } from '~/lib/tests/golden-set';
import { getTierTargets } from '~/lib/tests/tier-targets';
import { PROMPT_BUNDLE_VERSION_SHORT } from '~/lib/workflows/product-support/prompt-version';

import { Badge } from '~/components/ui/badge';
import { ProvenanceFooter } from './ProvenanceFooter';

/** B0-584 — verified against `getGoldenSetTierRollup` / `getTierTargets`; keep in sync with them. */
const VERDICT_SOURCES = [
  'Pass/fail: test_result_items.passed × test_items.priority, scoped to golden-set membership (tests.is_golden), from each golden test’s latest completed full-mode run (test_results) in the selected window/version',
  'Targets & gate flags: tier_targets (edited on /admin/tests, audited)',
];

const FAILURE_QUEUE_HREF = '/admin/tests/failure-queue';

const CHIP_STYLES: Record<HealthVerdictState, string> = {
  blocked: 'border-red-400/40 bg-red-500/15 text-red-300',
  clear: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300',
  unknown: 'border-amber-400/40 bg-amber-500/15 text-amber-300',
};

const CHIP_LABELS: Record<HealthVerdictState, string> = {
  blocked: 'Blocked',
  clear: 'Clear',
  unknown: 'Unknown',
};

const sweepFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

export async function VerdictStrip({ window, version }: HealthPanelProps) {
  const [rollup, targets] = await Promise.all([
    getGoldenSetTierRollup({
      ...toGoldenSetVersionQuery(version),
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
    }),
    getTierTargets(),
  ]);

  const verdict = deriveHealthVerdict(rollup, targets);

  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900 p-8 text-slate-100 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex min-w-0 items-start gap-5">
          <span
            className={[
              'inline-flex shrink-0 items-center rounded-full border px-4 py-1.5 text-sm font-semibold uppercase tracking-[0.15em]',
              CHIP_STYLES[verdict.state],
            ].join(' ')}
          >
            {CHIP_LABELS[verdict.state]}
          </span>

          <div className="min-w-0">
            {/* The verdict in words — colour is never the only signal. */}
            {verdict.state === 'blocked' ? (
              <p className="text-lg font-medium leading-7 text-slate-100">
                {verdict.failures.map((failure, index) => (
                  <span key={failure.tier}>
                    {index > 0 ? '; ' : null}
                    Tier {failure.tier} gate at{' '}
                    {formatPassRatePercent(failure.passRate)} of the{' '}
                    {formatPassRatePercent(failure.targetPassRate)} required ·{' '}
                    <Link
                      className="underline decoration-red-400/60 underline-offset-4 hover:text-red-300"
                      href={FAILURE_QUEUE_HREF}
                    >
                      {failure.failingCount} failing prompt
                      {failure.failingCount === 1 ? '' : 's'}
                    </Link>
                  </span>
                ))}
              </p>
            ) : (
              <p className="text-lg font-medium leading-7 text-slate-100">
                {verdict.sentence}
              </p>
            )}

            <p className="mt-2 text-xs text-slate-400">
              Bundle{' '}
              <code className="rounded bg-slate-800 px-1.5 py-0.5">
                {PROMPT_BUNDLE_VERSION_SHORT}
              </code>{' '}
              · Last sweep{' '}
              <span className="tabular-nums">
                {verdict.lastSweepAt
                  ? `${sweepFormatter.format(new Date(verdict.lastSweepAt))} UTC`
                  : 'none in this selection'}
              </span>{' '}
              · {utcDay(window.from)} → {utcDay(window.to)} (UTC) ·{' '}
              {describeVersionSelection(version)}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-4">
          {verdict.totalFailingCount > 0 && (
            <Badge variant="destructive">
              {verdict.totalFailingCount}&nbsp; failing prompt
              {verdict.totalFailingCount === 1 ? '' : 's'}
            </Badge>
          )}
          <Link
            className="inline-flex items-center rounded-full border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
            href="/admin/tests"
            title="Golden-set sweeps run from the tests admin — open a golden test there and start a full run."
          >
            Re-run sweep
          </Link>
        </div>
      </div>

      <ProvenanceFooter sources={VERDICT_SOURCES} tone="dark" />
    </section>
  );
}
