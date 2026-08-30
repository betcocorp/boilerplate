/**
 * B0-629 — the Mission Control health bar: one dense dark card carrying the golden-set verdict
 * and the per-tier gate figures that justify it.
 *
 * A compression of the Bex Health dashboard's `VerdictStrip` (B0-579) + `TierCards` (B0-580) into
 * a single row, and deliberately NOT a re-derivation of them: the verdict is still
 * `deriveHealthVerdict` over the two canonical readers (`getGoldenSetTierRollup` scoped to the
 * page's version + window, and `getTierTargets`), and every percentage still goes through
 * `formatPassRatePercent`. No target literal and no threshold appears in this file.
 *
 * Two honesty rules carried over verbatim:
 *  - a selection with no golden-set run renders the explicit empty state, never `0%`;
 *  - the tier boxes' denominator is `gradedCount` (rows graded in the resolved sweep), not tier
 *    membership size — "2 of 24 failing" means 24 prompts were actually graded.
 *
 * "Re-run sweep" is a LINK to /admin/tests, not an action: per B0-579, golden-set sweeps are
 * started per test from that page (`runTestAction`) and no harness plumbing exists to kick one
 * off from a dashboard. It is styled as a button because it navigates somewhere useful.
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
  tierStatusLine,
  type HealthVerdictState,
  type TierStatusTone,
} from '~/lib/bex-health/verdict';
import { GOLDEN_TIERS, getGoldenSetTierRollup } from '~/lib/tests/golden-set';
import { getTierTargets } from '~/lib/tests/tier-targets';
import { PROMPT_BUNDLE_VERSION_SHORT } from '~/lib/workflows/product-support/prompt-version';

import { EM_DASH } from './format';

/**
 * Verified against `getGoldenSetTierRollup` / `getTierTargets`; keep in sync with them.
 * Rendered by the page's consolidated provenance footer, not by this component.
 */
export const HEALTH_BAR_SOURCES = [
  'Pass/fail & failing counts: test_result_items.passed × test_items.priority, scoped to golden-set membership (tests.is_golden), from each golden test’s latest completed full-mode run (test_results) in the selected window/version',
  'Targets, gate flags & tier labels: tier_targets (edited on /admin/tests, audited)',
];

const FAILURE_QUEUE_HREF = '/admin/tests/failure-queue';

/** Same three states, same palette as `VerdictStrip`'s `CHIP_STYLES` — this card is its sibling. */
const PILL_STYLES: Record<HealthVerdictState, string> = {
  blocked: 'border-red-400/40 bg-red-500/15 text-red-300',
  clear: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300',
  unknown: 'border-amber-400/40 bg-amber-500/15 text-amber-300',
};

const PILL_LABELS: Record<HealthVerdictState, string> = {
  blocked: 'Blocked',
  clear: 'Clear',
  unknown: 'Unknown',
};

/** `TierCards`' tone scale, lifted onto the dark surface this card sits on. */
const TIER_TONE_TEXT: Record<TierStatusTone, string> = {
  critical: 'text-red-300',
  warning: 'text-amber-300',
  ok: 'text-emerald-300',
  neutral: 'text-slate-400',
};

const sweepFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

export async function HealthBar({ window, version }: HealthPanelProps) {
  const [rollup, targets] = await Promise.all([
    getGoldenSetTierRollup({
      ...toGoldenSetVersionQuery(version),
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
    }),
    getTierTargets(),
  ]);

  const verdict = deriveHealthVerdict(rollup, targets);

  // Tiers in use come from the data — the union of the constant, the stored targets and the
  // rollup — so a tier 4 appearing in either source gets a box without a code change.
  const tiers = [
    ...new Set<number>([
      ...GOLDEN_TIERS,
      ...targets.map((target) => target.tier),
      ...(rollup.kind === 'rollup' ? rollup.tiers.map((tier) => tier.tier) : []),
    ]),
  ].sort((a, b) => a - b);

  // Same wording as `TierCards`' empty state: an absent sweep is said out loud, never shown as 0%.
  const emptyStateText =
    rollup.kind === 'no_golden_sets'
      ? 'No golden sets configured — mark a test as golden on /admin/tests.'
      : rollup.kind === 'no_golden_run_for_version'
        ? `No golden-set run for this selection (${describeVersionSelection(version)}, ${utcDay(window.from)} → ${utcDay(window.to)}).`
        : null;

  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900 p-6 text-slate-100 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <span
            className={[
              'inline-flex shrink-0 items-center rounded-full border px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.18em]',
              PILL_STYLES[verdict.state],
            ].join(' ')}
          >
            {PILL_LABELS[verdict.state]}
          </span>

          <div className="min-w-0">
            {/* The verdict in words — colour is never the only signal. */}
            {verdict.state === 'blocked' ? (
              <p className="text-base font-medium leading-6 text-slate-100">
                {verdict.failures.map((failure, index) => (
                  <span key={failure.tier}>
                    {index > 0 ? '; ' : null}
                    Tier {failure.tier} gate at {formatPassRatePercent(failure.passRate)} of the{' '}
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
              <p className="text-base font-medium leading-6 text-slate-100">{verdict.sentence}</p>
            )}

            <p className="mt-1.5 font-mono text-[11px] leading-5 text-slate-400">
              Bundle {PROMPT_BUNDLE_VERSION_SHORT} · Last sweep{' '}
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
            <div className="text-right">
              <p className="text-sm font-semibold text-slate-100">{verdict.totalFailingCount}</p>
              <p className="text-xs text-slate-400">failing prompt{verdict.totalFailingCount === 1 ? '' : 's'}</p>
            </div>
          )}
          <div className="flex items-center gap-3">
            <Link
              className="inline-flex items-center rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white"
              href="/admin/tests"
              title="Golden-set sweeps run from the tests admin — open a golden test there and start a full run."
            >
              Re-run sweep
            </Link>
            <Link
              className="inline-flex items-center rounded-full border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
              href={FAILURE_QUEUE_HREF}
            >
              Open failure queue →
            </Link>
          </div>
        </div>
      </div>

      {emptyStateText !== null ? (
        <p className="mt-5 border-t border-slate-800 pt-4 text-sm text-slate-400">
          {emptyStateText}
        </p>
      ) : (
        <div className="mt-5 flex flex-wrap gap-3 border-t border-slate-800 pt-4">
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

            // Denominator is what the sweep GRADED, not how big the tier is.
            const gradedCount = tierRollup?.gradedCount ?? 0;
            const failingCount =
              tierRollup !== undefined ? tierRollup.gradedCount - tierRollup.passedCount : null;

            return (
              <div
                className="min-w-[124px] flex-1 rounded-2xl border border-slate-700 px-3.5 py-3"
                key={tier}
              >
                <p
                  className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400"
                  title={target?.label}
                >
                  Tier {tier}
                </p>
                <p
                  className={[
                    'mt-1 text-xl font-semibold tabular-nums tracking-tight',
                    TIER_TONE_TEXT[status.tone],
                  ].join(' ')}
                >
                  {passRate === null ? EM_DASH : formatPassRatePercent(passRate)}
                </p>
                {/* The tone in words, so the tint is never the only signal. */}
                <p className="mt-0.5 text-[11px] text-slate-400">{status.label}</p>
                <p className="mt-1 text-[11px] tabular-nums text-slate-400">
                  {failingCount !== null && gradedCount > 0 ? (
                    <Link
                      className="underline decoration-slate-600 underline-offset-4 hover:text-slate-200"
                      href={FAILURE_QUEUE_HREF}
                    >
                      {failingCount} of {gradedCount} failing
                    </Link>
                  ) : (
                    'No graded prompts'
                  )}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
