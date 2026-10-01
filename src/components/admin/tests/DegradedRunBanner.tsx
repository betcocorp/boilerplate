import { AlertTriangle } from 'lucide-react';

import {
  DEGRADED_FALLBACK_RATE_THRESHOLD,
  DEGRADED_MEAN_CONFIDENCE_THRESHOLD,
  formatRunHealthPercent,
  type RunRoutingHealth,
} from '~/lib/tests/run-health';

/**
 * B0-911 — the degraded-pipeline warning, rendered ABOVE the grade on every surface that shows one
 * (the run report, the executive summary) and at the top of the run detail page.
 *
 * The whole point is placement: on 2026-09-08 a 106-case run whose LLM router 400'd on every single
 * item completed, produced a letter grade, and was read as a vendor verdict. A grade produced on a
 * degraded run must not be readable without this context, so this is deliberately a full-width
 * amber block above the score rather than a chip beside it.
 *
 * Presentation only — every number arrives from `computeRunRoutingHealth`. Renders nothing when the
 * run is healthy (or had no routing instrumentation to judge), so a normal run is unchanged.
 */
export function DegradedRunBanner({ health }: { health: RunRoutingHealth | null }) {
  if (!health || !health.degraded) {
    return null;
  }

  const fallbackRateText =
    health.fallbackRate === null ? null : formatRunHealthPercent(health.fallbackRate);
  const meanConfidenceText =
    health.meanRoutingConfidence === null ? null : health.meanRoutingConfidence.toFixed(3);

  return (
    <section
      className="rounded-3xl border-2 border-amber-300 bg-amber-50 p-6 shadow-sm"
      data-report-degraded-banner
      role="alert"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-amber-700"
        />
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-800">
              Degraded routing pipeline
            </p>
            <h2 className="mt-1 text-lg font-semibold text-amber-950">
              Read this run&apos;s grade with caution — its routing pipeline was degraded while it
              ran.
            </h2>
          </div>

          <p className="text-sm text-amber-900">
            The LLM router and the signals pass both fall back to the keyword router on any provider
            failure, without failing the run. A run can therefore complete, report a letter grade
            and look healthy while every item was routed by keyword scoring. This one tripped the
            checks below, so its grade measures a degraded pipeline, not the model or the prompt
            under test.
          </p>

          <ul className="flex flex-col gap-1.5 text-sm text-amber-900">
            {health.reasonsForDegradation.includes('fallback_rate') && fallbackRateText ? (
              <li>
                <span className="font-semibold">{fallbackRateText}</span> of measured items fell
                back to the keyword router ({health.fallbackItems} of {health.measuredItems}) —
                threshold is{' '}
                {formatRunHealthPercent(DEGRADED_FALLBACK_RATE_THRESHOLD)}.
              </li>
            ) : null}
            {health.reasonsForDegradation.includes('low_mean_confidence') && meanConfidenceText ? (
              <li>
                Mean routing confidence <span className="font-semibold">{meanConfidenceText}</span>{' '}
                across {health.measuredItems} measured item
                {health.measuredItems === 1 ? '' : 's'} — threshold is{' '}
                {DEGRADED_MEAN_CONFIDENCE_THRESHOLD.toFixed(2)}. The router stamps a fixed 0 / 0.5
                placeholder when it falls back, so a mean this low means it rarely produced a real
                score.
              </li>
            ) : null}
          </ul>

          <div className="rounded-2xl border border-amber-300 bg-amber-100/60 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-800">
              Most common fallback reason
            </p>
            {health.topFallbackReason ? (
              <>
                {/* Recorded verbatim (it is usually a provider error body) — never trimmed or reworded. */}
                <p className="mt-1 break-words font-mono text-xs text-amber-950">
                  {health.topFallbackReason}
                </p>
                <p className="mt-1.5 text-xs text-amber-800">
                  {health.fallbackReasons[0]?.count ?? 0} of {health.fallbackItems} recorded
                  fallback
                  {health.fallbackItems === 1 ? '' : 's'}
                  {health.fallbackReasons.length > 1
                    ? ` · ${health.fallbackReasons.length} distinct reasons in this run`
                    : ''}
                </p>
              </>
            ) : (
              <p className="mt-1 text-xs text-amber-900">
                Not recorded. This run predates <code>routing_fallback_reason</code> (B0-911), so
                only the confidence signal survives — check this run&apos;s Sentry/log window for
                the provider error.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
