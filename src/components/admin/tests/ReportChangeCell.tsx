import { ArrowDown, ArrowUp, Minus } from 'lucide-react';

import type { ReportScoreChange } from '~/lib/tests/report-trend';
import { formatChangePercent, formatChangePoints } from '~/lib/tests/report-trend';

/**
 * Run-over-run change (B0-689). An absent change is an em-dash, never `0%`: a dataset's first
 * scored run has nothing to compare against, which is not the same as "no change".
 *
 * Server-safe (renders only). Shared by the "Reports" table and the Thursday scorecard
 * (B0-1164); the defaults are the "Reports" table's exact titles, and the scorecard overrides
 * them to name the previous Thursday-night sweep.
 */
export function ReportChangeCell({
  change,
  score,
  noChangeTitle,
  previousTitle,
}: {
  change: ReportScoreChange | undefined | null;
  /** This row's score — decides which "no comparison" title applies when `change` is absent. */
  score: number | null;
  /** Overrides the em-dash title when there is no comparison. */
  noChangeTitle?: string;
  /** Overrides the title on a rendered change (default: `Previous scored run: N/100`). */
  previousTitle?: string;
}) {
  if (!change) {
    return (
      <span
        className="text-slate-400"
        title={
          noChangeTitle ??
          (score === null
            ? 'This run has no score yet, so there is nothing to compare'
            : 'First scored run for this dataset — no earlier score to compare against')
        }
      >
        —
      </span>
    );
  }

  const rising = change.deltaPoints > 0;
  const falling = change.deltaPoints < 0;
  const Icon = rising ? ArrowUp : falling ? ArrowDown : Minus;
  const tone = rising
    ? 'text-emerald-600'
    : falling
      ? 'text-rose-600'
      : 'text-slate-500';

  return (
    <span
      className="flex flex-col items-start"
      title={previousTitle ?? `Previous scored run: ${change.previousScore}/100`}
    >
      <span className="text-xs tabular-nums text-slate-500">
        {formatChangePoints(change)}
      </span>
      <span
        className={`inline-flex items-center gap-1 font-medium tabular-nums ${tone}`}
      >
        <Icon aria-hidden className="size-3.5" />
        {formatChangePercent(change)}
      </span>
    </span>
  );
}
