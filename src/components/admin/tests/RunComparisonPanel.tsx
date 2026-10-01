/**
 * B0-315 — renders the B0-311/312/313/314 post-mortem comparison on the run detail page. Same
 * prop-hydration idiom as `RunInsightsPanel` (server-fetched data passed in as props, rendered as
 * soon as the page loads) but a plain server component rather than `'use client'`: there is no
 * user-initiated action here — the analysis runs automatically via `after()` on run completion — so
 * there is no client interactivity to justify client state. Reloading the page always reflects the
 * latest persisted `status`.
 */
import { AlertTriangle, ArrowRight, Loader2, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '~/components/ui/badge';
import type {
  RunComparisonFix,
  RunComparisonNewFailure,
  RunComparisonStatus,
  RunComparisonVerdict,
} from '~/lib/tests/types';

export type RunComparisonPanelData = {
  status: RunComparisonStatus;
  verdict: RunComparisonVerdict | null;
  verdictSummary: string | null;
  currentPassRate: number | null;
  previousPassRate: number | null;
  scoreDelta: number | null;
  newFailures: RunComparisonNewFailure[];
  fixes: RunComparisonFix[];
  errorMessage: string | null;
};

type Props = {
  comparison: RunComparisonPanelData | null;
};

const VERDICT_STYLES: Record<RunComparisonVerdict, string> = {
  improved: 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900',
  regressed: 'border-red-600/45 bg-red-600/12 text-red-900',
  flat: 'border-slate-300 bg-slate-100 text-slate-700',
};

const VERDICT_ICON: Record<RunComparisonVerdict, typeof TrendingUp> = {
  improved: TrendingUp,
  regressed: TrendingDown,
  flat: Minus,
};

function formatPct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatDelta(value: number | null): string {
  if (value === null) return 'n/a';
  const pts = (value * 100).toFixed(1);
  return value > 0 ? `+${pts} pts` : `${pts} pts`;
}

function itemHref(resultItemId: string): string {
  // Both `newFailures` and `fixes` reference result items from THIS run, and the item-level results
  // table further down this same page renders every row with `id="run-item-result-<id>"` — so this
  // is a same-page anchor, not a navigation.
  return `#run-item-result-${resultItemId}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
        AI analysis
      </p>
      <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">{title}</h2>
      {children}
    </section>
  );
}

export function RunComparisonPanel({ comparison }: Props) {
  // Nothing to show: the run hasn't reached completion yet, or (pre-feature legacy run) no
  // comparison job was ever started for it. Not one of the 4 persisted states, so no panel at all
  // rather than inventing a 5th "unknown" state.
  if (!comparison) {
    return null;
  }

  if (comparison.status === 'generating') {
    return (
      <Section title="Run comparison">
        <div aria-live="polite" className="mt-4 flex items-center gap-2 text-sm text-slate-500" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          Comparing against the previous run…
        </div>
      </Section>
    );
  }

  if (comparison.status === 'no_baseline') {
    // B0-1110 — a partial run's row carries the reason it was skipped in `errorMessage`.
    return (
      <Section title="Run comparison">
        <p className="mt-4 text-sm text-slate-500">
          {comparison.errorMessage ??
            'No earlier completed run on this dataset to compare against — nothing to diff yet.'}
        </p>
      </Section>
    );
  }

  if (comparison.status === 'failed') {
    return (
      <Section title="Run comparison">
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{comparison.errorMessage ?? 'Comparison analysis failed.'}</span>
        </div>
      </Section>
    );
  }

  // status === 'ready'
  const verdict = comparison.verdict ?? 'flat';
  const VerdictIcon = VERDICT_ICON[verdict];

  return (
    <Section title="Run comparison">
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium capitalize ${VERDICT_STYLES[verdict]}`}
        >
          <VerdictIcon className="h-4 w-4" />
          {verdict}
        </span>
        <span className="font-mono text-sm text-slate-600">
          {formatPct(comparison.previousPassRate)}
          <ArrowRight className="mx-1.5 inline h-3.5 w-3.5 text-slate-400" />
          {formatPct(comparison.currentPassRate)}
        </span>
        <Badge variant="outline">{formatDelta(comparison.scoreDelta)}</Badge>
      </div>
      {comparison.verdictSummary ? (
        <p className="mt-2 text-sm text-slate-600">{comparison.verdictSummary}</p>
      ) : null}

      {comparison.newFailures.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-slate-900">
            New failures ({comparison.newFailures.length})
          </h3>
          <ol className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {comparison.newFailures.map((failure) => (
              <li
                className="rounded-2xl border border-red-100 bg-red-50/40 p-4 text-sm"
                key={failure.resultItemId}
              >
                <a
                  className="font-medium text-slate-900 underline-offset-2 hover:underline"
                  href={itemHref(failure.resultItemId)}
                >
                  {failure.prompt || `Row ${failure.rowIndex}`}
                </a>
                {failure.cause ? (
                  <p className="mt-1.5 text-slate-600">
                    <span className="font-semibold text-slate-700">Cause: </span>
                    {failure.cause}
                  </p>
                ) : null}
                {failure.fix ? (
                  <p className="mt-1 text-slate-600">
                    <span className="font-semibold text-slate-700">Suggested fix: </span>
                    {failure.fix}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {comparison.fixes.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-slate-900">
            Fixed / recovered ({comparison.fixes.length})
          </h3>
          <ul className="mt-3 flex flex-col gap-1.5">
            {comparison.fixes.map((fix) => (
              <li className="text-sm" key={fix.resultItemId}>
                <a
                  className="text-emerald-800 underline-offset-2 hover:underline"
                  href={itemHref(fix.resultItemId)}
                >
                  {fix.prompt || `Row ${fix.rowIndex}`}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {comparison.newFailures.length === 0 && comparison.fixes.length === 0 ? (
        <p className="mt-6 text-sm text-slate-500">No pass/fail changes versus the previous run.</p>
      ) : null}
    </Section>
  );
}
