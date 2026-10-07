import Link from 'next/link';

import { Badge } from '~/components/ui/badge';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import type { SignalAccuracyMetric, SignalAccuracyReport } from '~/lib/tests/signal-accuracy';

type SignalAccuracyPanelProps = {
  testId: string;
  report: SignalAccuracyReport;
};

type SignalRowConfig = {
  key: keyof SignalAccuracyReport['signals'];
  label: string;
  groundTruthHint: string;
};

const SIGNAL_ROWS: SignalRowConfig[] = [
  {
    key: 'productMention',
    label: 'Product mention',
    groundTruthHint: 'input_payload.product_mention',
  },
  {
    key: 'surfaceType',
    label: 'Surface type',
    groundTruthHint: 'expected_surface_type',
  },
  {
    key: 'brandFamily',
    label: 'Brand family',
    groundTruthHint: 'expected_brand_family',
  },
  {
    key: 'setting',
    label: 'Setting',
    groundTruthHint: 'expected_setting',
  },
];

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function scoreBadgeClassName(value: number | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  if (value >= 0.8) {
    return 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900';
  }
  if (value >= 0.5) {
    return 'border-amber-500/45 bg-amber-500/12 text-amber-900';
  }
  return 'border-red-600/45 bg-red-600/12 text-red-900';
}

function SignalMetricRow({
  testId,
  label,
  groundTruthHint,
  metric,
}: {
  testId: string;
  label: string;
  groundTruthHint: string;
  metric: SignalAccuracyMetric;
}) {
  const { scoredItemCount, matchedItemCount, precision, recall, mismatches } = metric;

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">{label}</p>
          <p className="mt-0.5 font-mono text-xs text-slate-500">{groundTruthHint}</p>
        </div>
        {scoredItemCount > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={scoreBadgeClassName(precision)} variant="outline">
              {formatPercent(precision)} precision
            </Badge>
            <Badge className={scoreBadgeClassName(recall)} variant="outline">
              {formatPercent(recall)} recall
            </Badge>
            <span className="text-xs text-slate-500">
              {matchedItemCount}/{scoredItemCount} scored items matched
            </span>
          </div>
        ) : (
          <Badge variant="secondary">No scoreable items for this signal</Badge>
        )}
      </div>

      {mismatches.length > 0 ? (
        <details className="group mt-3">
          <summary className="inline-flex cursor-pointer items-center rounded-3xl px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
            {mismatches.length} mismatch{mismatches.length === 1 ? '' : 'es'}
          </summary>
          <div className="mt-2 max-h-[min(50vh,24rem)] overflow-auto overscroll-contain rounded-xl border border-slate-100 bg-white">
            <table className="w-full caption-bottom text-sm">
              <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226,232,240)] [&_tr]:border-b-0">
                <TableRow>
                  <TableHead>Row</TableHead>
                  <TableHead>Prompt</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead>Actual</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mismatches.map((mismatch) => (
                  <TableRow key={`${mismatch.testItemId}-${mismatch.rowIndex}`}>
                    <TableCell className="align-top">{mismatch.rowIndex}</TableCell>
                    <TableCell className="max-w-md align-top text-xs text-slate-700">
                      <span className="line-clamp-3">{mismatch.prompt}</span>
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge variant="outline">
                        <code>{mismatch.expected}</code>
                      </Badge>
                    </TableCell>
                    <TableCell className="align-top">
                      {mismatch.actual === null ? (
                        <Badge variant="destructive">none extracted</Badge>
                      ) : (
                        <Badge variant="destructive">
                          <code>{mismatch.actual}</code>
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right align-top">
                      <Link
                        className="text-xs text-sky-700 underline-offset-2 hover:underline"
                        href={`/admin/tests/${testId}/items/${mismatch.testItemId}`}
                      >
                        Item history
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </table>
          </div>
        </details>
      ) : scoredItemCount > 0 ? (
        <p className="mt-2 text-xs text-emerald-700">
          All {scoredItemCount} scored item{scoredItemCount === 1 ? '' : 's'} matched.
        </p>
      ) : null}
    </div>
  );
}

/**
 * B0-790 — per-signal ground-truth vs. extracted precision/recall panel, mirroring
 * `RunToolRoutingPanel`'s layout. Reads the `signals_analysis` gate (B0-786) on the
 * `orchestration_planner` `workflow_steps` row, which is frequently absent — most runs (and any
 * run with `BEX_SIGNALS_ANALYSIS_ENABLED` off) have no gate at all, so every signal in that case
 * shows "no scoreable items" rather than a misleading 0%.
 */
export function SignalAccuracyPanel({ testId, report }: SignalAccuracyPanelProps) {
  const rows = SIGNAL_ROWS.map((row) => ({ ...row, metric: report.signals[row.key] }));
  const totalScoredAcrossSignals = rows.reduce((sum, row) => sum + row.metric.scoredItemCount, 0);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Signal accuracy</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Ground truth vs. the B0-786 signals extraction (product mention, surface type, brand
            family, setting) for every item in this run that carries an expected value AND ran with
            signals analysis on.
          </p>
        </div>
      </div>

      {totalScoredAcrossSignals === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
          Not scoreable — signals analysis was off for this run, no item carries ground truth for
          any of the four signals, or this run predates B0-786.
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <SignalMetricRow
              key={row.key}
              groundTruthHint={row.groundTruthHint}
              label={row.label}
              metric={row.metric}
              testId={testId}
            />
          ))}
        </div>
      )}
    </section>
  );
}
