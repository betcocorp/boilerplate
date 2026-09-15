import { OctagonAlert } from 'lucide-react';

import {
  PROVIDER_FAULT_LABEL,
  isProviderFaultKind,
} from '~/lib/tests/provider-fault';
import { formatRunHealthPercent } from '~/lib/tests/run-health';
import {
  PROVIDER_FAULT_INVALID_RATE_THRESHOLD,
  type RunProviderHealth,
} from '~/lib/tests/run-provider-health';

/**
 * B0-1014 — the provider-outage warning, rendered ABOVE the grade on every surface that shows one
 * (the run report, the executive summary) and at the very top of the run detail page.
 *
 * Sibling of `DegradedRunBanner`, deliberately louder: a degraded-routing run at least produced
 * answers worth reading, while a run the provider refused measured nothing at all. On 2026-09-14
 * the Betco OpenAI organization ran out of credits mid-sweep; every subsequent item was recorded as
 * `passed: false`, the 00:00 UTC golden sweep reported 0/106 across five golden sets, and a letter
 * grade was computed from it. Red, not amber, is the point.
 *
 * Presentation only — every number arrives from `computeRunProviderHealth`. Renders nothing when
 * the run is clean, so a normal run is completely unchanged.
 */
export function ProviderFaultBanner({ health }: { health: RunProviderHealth | null }) {
  if (!health || !health.invalid) {
    return null;
  }

  const faultRateText =
    health.faultRate === null ? null : formatRunHealthPercent(health.faultRate);
  const topKind = health.topKind;
  // Recognized kinds get their human label; anything else is shown verbatim — the column is free
  // text and a value we cannot name is still a refusal the reader has to see.
  const topKindLabel =
    topKind && isProviderFaultKind(topKind) ? PROVIDER_FAULT_LABEL[topKind] : topKind;
  const isQuotaOutage = topKind === 'insufficient_quota';

  return (
    <section
      className="rounded-3xl border-2 border-red-300 bg-red-50 p-6 shadow-sm"
      data-report-provider-fault-banner
      role="alert"
    >
      <div className="flex items-start gap-3">
        <OctagonAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-red-700" />
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-red-800">
              Model provider refused this run
            </p>
            <h2 className="mt-1 text-lg font-semibold text-red-950">
              This run&apos;s pass rate is not a quality measurement — the model provider refused
              the requests.
            </h2>
          </div>

          <p className="text-sm text-red-900">
            Items the provider refused never produced an answer, but the harness still records them
            as failures. A run in this state therefore reports a low pass rate and a letter grade
            that measure an outage, not the model, the prompt or the retrieval under test.
          </p>

          <ul className="flex flex-col gap-1.5 text-sm text-red-900">
            <li>
              <span className="font-semibold">{health.faultedItems}</span> of{' '}
              {health.totalItems} item{health.totalItems === 1 ? '' : 's'} in this run hit a
              provider fault
              {faultRateText ? (
                <>
                  {' '}
                  (<span className="font-semibold">{faultRateText}</span>) — threshold is{' '}
                  {formatRunHealthPercent(PROVIDER_FAULT_INVALID_RATE_THRESHOLD)}
                </>
              ) : null}
              .
            </li>
            {topKindLabel ? (
              <li>
                Dominant fault: <span className="font-semibold">{topKindLabel}</span> (
                {health.kinds[0]?.count ?? 0} of {health.faultedItems})
                {health.kinds.length > 1
                  ? ` · ${health.kinds.length} distinct faults in this run`
                  : ''}
                .
              </li>
            ) : null}
          </ul>

          <div className="rounded-2xl border border-red-300 bg-red-100/60 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-red-800">
              What to do
            </p>
            <p className="mt-1 text-xs text-red-900">
              {isQuotaOutage
                ? 'The organization’s API credits for this provider are exhausted and need topping up. '
                : 'The provider has to be working again before this run means anything. '}
              Re-run this test once the provider is healthy, and grade the new run — the numbers
              below should not be reported, compared against another run, or used to open work.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
