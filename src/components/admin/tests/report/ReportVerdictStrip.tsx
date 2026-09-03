import Link from 'next/link';

import type {
  ReportCase,
  ReportMetricsData,
  ReportRateGrade,
  ReportCaseStatus,
  ReportScoreExtreme,
} from '~/lib/tests/report/data-schemas';
import { caseAnchorId } from '~/lib/tests/report/render';
import { cn } from '~/lib/utils';

import { buildExceptionRows, type ReportExceptionRow } from './verdict-strip-data';

/**
 * B0-587 — the run report's verdict strip (epic B0-571): the exec scorecard collapsed into one
 * strip of three columns — overall grade, result split, and the fails pulled to the top.
 *
 * Presentation only, and deliberately arithmetic-free: every score, grade, count and percentage is
 * read straight off the `ReportDataReady` payload (`assembleReportData`), which is the same object
 * the Markdown report renders from, so the two can never disagree. Percentages arrive pre-rounded
 * to one decimal and are printed as-is. Free text (questions, grader narrative) is regulated
 * content — it is rendered verbatim and only ever truncated by CSS (`line-clamp`), never sliced.
 *
 * Fetching belongs to the container; this takes the already-fetched ready payload as props.
 */

/** The weighting behind `overall`, stated for the reader (see `computeReportMetrics`). */
const WEIGHTING_LABEL = 'Accuracy 40 · Completeness 30 · Relevance 20 · Clarity 10';

const GRADE_STYLES: Record<ReportRateGrade, string> = {
  A: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  B: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  C: 'border-amber-200 bg-amber-50 text-amber-700',
  D: 'border-orange-200 bg-orange-50 text-orange-700',
  F: 'border-red-200 bg-red-50 text-red-700',
  '-': 'border-slate-200 bg-slate-50 text-slate-500',
};

const STATUS_BADGE_STYLES: Record<ReportCaseStatus, string> = {
  Pass: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  Fail: 'border-red-200 bg-red-50 text-red-700',
};

type SegmentTone = 'pass' | 'fail';

const SEGMENT_BAR_STYLES: Record<SegmentTone, string> = {
  pass: 'bg-emerald-500',
  fail: 'bg-red-500',
};

const SEGMENT_DOT_STYLES: Record<SegmentTone, string> = {
  pass: 'bg-emerald-500',
  fail: 'bg-red-500',
};

/** Rendered as stored — `avg` is already at the payload's precision. */
function scoreText(value: number | null): string {
  return value === null ? '—' : String(value);
}

function pluralCases(count: number): string {
  return `${count} case${count === 1 ? '' : 's'}`;
}

/** A `metrics.highest` / `metrics.lowest` group: ties included, every id linked to its ledger row. */
function ExtremeLine({
  label,
  entries,
}: {
  label: string;
  entries: ReportScoreExtreme[];
}) {
  if (entries.length === 0) {
    return (
      <p className="text-xs text-slate-400">
        {label} <span className="text-slate-400">— none</span>
      </p>
    );
  }

  return (
    <p className="text-xs text-slate-500">
      <span className="font-medium text-slate-700">{label}</span>{' '}
      <span className="tabular-nums">{scoreText(entries[0]!.overall)}</span>{' '}
      {entries.map((entry, index) => (
        <span key={entry.id}>
          {index > 0 ? ', ' : '· '}
          <Link
            className="font-mono text-[11px] text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900"
            href={`#${caseAnchorId(entry.id)}`}
            title={entry.question}
          >
            {entry.id}
          </Link>
        </span>
      ))}
    </p>
  );
}

function ExceptionRow({ row }: { row: ReportExceptionRow }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold',
            STATUS_BADGE_STYLES[row.status],
          )}
        >
          {/* Words, not colour alone. */}
          {row.status}
          <span className="tabular-nums font-normal opacity-80">{scoreText(row.overall)}</span>
        </span>

        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium text-slate-900">{row.question}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
            {row.tier} · {row.category}
            {row.reason ? ` · ${row.reason}` : ''}
          </p>
        </div>

        <Link
          className="shrink-0 font-mono text-[11px] text-slate-500 underline decoration-slate-300 underline-offset-4 hover:text-slate-900"
          href={`#${row.anchorId}`}
        >
          {row.id}
        </Link>
      </div>
    </li>
  );
}

export type ReportVerdictStripProps = {
  metrics: ReportMetricsData;
  cases: ReportCase[];
  className?: string;
};

export function ReportVerdictStrip({ metrics, cases, className }: ReportVerdictStripProps) {
  const { overall } = metrics;
  const exceptions = buildExceptionRows(metrics.perCase, cases);

  const segments: { tone: SegmentTone; label: string; count: number; pct: number }[] = [
    { tone: 'pass', label: 'Pass', count: overall.pass, pct: overall.passPct },
    { tone: 'fail', label: 'Fail', count: overall.fail, pct: overall.failPct },
  ];
  const marginal = metrics.passOnlyUnderCurrentMark.length;

  // The same sentence the bar shows, for readers who get no colour at all.
  const splitSentence = segments
    .map((segment) => `${segment.label}: ${segment.count} (${segment.pct}%)`)
    .join(', ');

  return (
    <section
      className={cn(
        'grid grid-cols-1 gap-8 rounded-3xl border border-slate-200 bg-white p-8 shadow-sm lg:grid-cols-3',
        className,
      )}
    >
      {/* --- Overall grade --- */}
      <div className="lg:border-r lg:border-slate-100 lg:pr-8">
        <h2 className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
          Overall grade
        </h2>

        <div className="mt-4 flex items-end gap-4">
          <span
            className={cn(
              'inline-flex size-16 shrink-0 items-center justify-center rounded-2xl border text-4xl font-semibold',
              GRADE_STYLES[overall.grade],
            )}
          >
            {overall.grade}
          </span>
          <p className="text-3xl font-semibold tabular-nums leading-none text-slate-950">
            {scoreText(overall.avg)}
            <span className="ml-1 text-base font-normal text-slate-500">/ 100</span>
          </p>
        </div>

        <p className="mt-4 text-xs text-slate-500">
          Weighted score · {WEIGHTING_LABEL}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Reflects calculated performance; not adjusted.
        </p>
        <p className="mt-3 text-xs text-slate-500">
          {pluralCases(metrics.evaluated)} evaluated of {metrics.totalCases}
          {metrics.uteCount > 0
            ? ` · ${metrics.uteCount} unable to evaluate (excluded from every score and rate)`
            : ''}
        </p>
      </div>

      {/* --- Result split --- */}
      <div className="lg:border-r lg:border-slate-100 lg:pr-8">
        <h2 className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
          Result split
        </h2>

        <div className="mt-4 flex items-end gap-3">
          <p className="text-3xl font-semibold tabular-nums leading-none text-slate-950">
            {overall.passPct}%
          </p>
          <p className="text-sm text-slate-500">
            pass rate · {overall.pass} of {metrics.evaluated}
          </p>
        </div>
        {/* A pass rate means nothing without the line it was measured against (methodology §2). */}
        <p className="mt-1 text-xs text-slate-500 tabular-nums">
          Pass mark {metrics.passMark} — Pass at {metrics.passMark} or above, Fail below.
          {overall.n > 0
            ? marginal > 0
              ? ` ${marginal} ${marginal === 1 ? 'case passes' : 'cases pass'} only under this mark and would fail at ${metrics.strictPassMark}.`
              : ` Every pass would still pass at ${metrics.strictPassMark}.`
            : ''}
        </p>

        {overall.n === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No evaluated cases to split.</p>
        ) : (
          <>
            <div
              aria-label={`Result split — ${splitSentence}`}
              className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-slate-100"
              role="img"
            >
              {segments.map((segment) =>
                segment.count > 0 ? (
                  <span
                    className={SEGMENT_BAR_STYLES[segment.tone]}
                    key={segment.tone}
                    style={{ width: `${segment.pct}%` }}
                  />
                ) : null,
              )}
            </div>

            <ul className="mt-3 space-y-1">
              {segments.map((segment) => (
                <li
                  className="flex items-center gap-2 text-xs text-slate-600"
                  key={segment.tone}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'inline-block size-2 shrink-0 rounded-full',
                      SEGMENT_DOT_STYLES[segment.tone],
                    )}
                  />
                  <span className="font-medium text-slate-700">{segment.label}</span>
                  <span className="tabular-nums text-slate-500">
                    {segment.count} · {segment.pct}%
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="mt-4 space-y-1 border-t border-slate-100 pt-3">
          <ExtremeLine entries={metrics.highest} label="Highest" />
          <ExtremeLine entries={metrics.lowest} label="Lowest" />
        </div>
      </div>

      {/* --- Cases needing attention --- */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
          Cases needing attention ({exceptions.length})
        </h2>

        {exceptions.length === 0 ? (
          <p className="mt-4 text-sm text-slate-600">
            {metrics.evaluated === 0
              ? 'No cases were evaluated in this run, so nothing is flagged.'
              : `No fails — all ${pluralCases(metrics.evaluated)} evaluated passed.`}
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs text-slate-500">Every fail, worst first.</p>
            <ul className="mt-3 max-h-96 divide-y divide-slate-100 overflow-y-auto pr-1">
              {exceptions.map((row) => (
                <ExceptionRow key={row.id} row={row} />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
