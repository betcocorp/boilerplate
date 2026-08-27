/**
 * B0-588 (epic B0-571) — the three breakdown cards that sit under the verdict strip on the run
 * report: performance by tier, performance by category, and responsiveness.
 *
 * Every figure here is read straight off the B0-586 wire contract (`ReportMetricsData`). Nothing
 * is averaged, re-rated or re-rounded in this file: `avg` and the pass/partial/fail percentages
 * arrive already rounded to one decimal, latencies arrive at source precision, and both are
 * printed verbatim. The only arithmetic is laying segment widths out along a bar and counting how
 * many cases recorded no response time at all.
 *
 * Presentation only — the container owns fetching.
 */

import type { ReactNode } from 'react';

import type {
  ReportGroupRate,
  ReportLatency,
  ReportRateBlock,
  ReportRateGrade,
} from '~/lib/tests/report/data-schemas';
import { caseAnchorId } from '~/lib/tests/report/render';
import { cn } from '~/lib/utils';

const GRADE_STYLES: Record<ReportRateGrade, string> = {
  A: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  B: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  C: 'border-amber-200 bg-amber-50 text-amber-700',
  D: 'border-amber-200 bg-amber-50 text-amber-700',
  F: 'border-red-200 bg-red-50 text-red-700',
  '-': 'border-slate-200 bg-slate-50 text-slate-500',
};

/** Pass / partial / fail, in bar order — colour, label and which percentage field to read. */
const RATE_SEGMENTS = [
  { key: 'pass', label: 'pass', bar: 'bg-emerald-500', dot: 'bg-emerald-500' },
  { key: 'partial', label: 'partial', bar: 'bg-amber-400', dot: 'bg-amber-400' },
  { key: 'fail', label: 'fail', bar: 'bg-red-500', dot: 'bg-red-500' },
] as const;

const LATENCY_SEGMENTS = [
  { key: 'good', label: 'good', bar: 'bg-emerald-500', dot: 'bg-emerald-500' },
  { key: 'acceptable', label: 'acceptable', bar: 'bg-amber-400', dot: 'bg-amber-400' },
  { key: 'slow', label: 'slow', bar: 'bg-red-500', dot: 'bg-red-500' },
] as const;

const CARD_CLASS = 'flex flex-col rounded-3xl border border-slate-200 bg-white p-6 shadow-sm';
const CARD_TITLE_CLASS = 'text-sm font-semibold text-slate-900';

function pctOf(block: ReportRateBlock, key: (typeof RATE_SEGMENTS)[number]['key']): number {
  if (key === 'pass') return block.passPct;
  if (key === 'partial') return block.partialPct;
  return block.failPct;
}

function countOf(block: ReportRateBlock, key: (typeof RATE_SEGMENTS)[number]['key']): number {
  if (key === 'pass') return block.pass;
  if (key === 'partial') return block.partial;
  return block.fail;
}

/** A UUID is too long for a card; show its first segment but keep the full id addressable. */
function shortCaseId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export type ReportSegment = {
  /** Width of this slice, as a percentage of the bar. Rendered verbatim — never re-derived. */
  percent: number;
  /** Tailwind background class for the slice. */
  className: string;
};

export type ReportSegmentedBarProps = {
  segments: ReportSegment[];
  className?: string;
};

/**
 * The shared segmented bar. Decorative by design (`aria-hidden`): every segment it draws is
 * spelled out in the text legend beside it, which is the accessible content.
 */
export function ReportSegmentedBar({ className, segments }: ReportSegmentedBarProps) {
  return (
    <div
      aria-hidden
      className={cn('flex h-2 w-full overflow-hidden rounded-full bg-slate-100', className)}
    >
      {segments.map((segment, index) => (
        <div
          className={segment.className}
          data-report-bar-segment
          key={index}
          style={{ width: `${segment.percent}%` }}
        />
      ))}
    </div>
  );
}

function GradeBadge({ grade }: { grade: ReportRateGrade }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-6 items-center justify-center rounded-md border px-1.5 py-0.5 text-xs font-semibold',
        GRADE_STYLES[grade],
      )}
    >
      {grade}
    </span>
  );
}

/** One tier/category row: label + n, avg + grade, the segmented bar, and the rates in words. */
function RateRow({ block, name }: ReportGroupRate) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-sm font-medium text-slate-900" title={name}>
          {name}{' '}
          <span className="text-xs font-normal tabular-nums text-slate-500">n={block.n}</span>
        </p>
        <p className="flex shrink-0 items-center gap-2">
          <span className="text-sm font-semibold tabular-nums text-slate-950">
            {/* Already rounded upstream; `null` only ever means n=0. */}
            {block.avg ?? '—'}
          </span>
          <GradeBadge grade={block.grade} />
        </p>
      </div>

      <ReportSegmentedBar
        className="mt-2"
        segments={RATE_SEGMENTS.map((segment) => ({
          className: segment.bar,
          percent: pctOf(block, segment.key),
        }))}
      />

      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums text-slate-500">
        {RATE_SEGMENTS.map((segment) => (
          <li className="flex items-center gap-1.5" key={segment.key}>
            <span aria-hidden className={cn('inline-block size-2 rounded-full', segment.dot)} />
            {pctOf(block, segment.key)}% {segment.label} ({countOf(block, segment.key)})
          </li>
        ))}
      </ul>
    </li>
  );
}

function EmptyRows({ children }: { children: ReactNode }) {
  return <p className="mt-4 text-sm text-slate-500">{children}</p>;
}

export type ReportTierCardProps = {
  /** `metrics.tiers` — already ordered ascending with "Unspecified" last. Never re-sort. */
  tiers: ReportGroupRate[];
  className?: string;
};

/** "Performance by tier" — one row per tier, exactly as the payload orders them. */
export function ReportTierCard({ className, tiers }: ReportTierCardProps) {
  return (
    <section className={cn(CARD_CLASS, className)}>
      <h2 className={CARD_TITLE_CLASS}>Performance by tier</h2>

      {tiers.length === 0 ? (
        <EmptyRows>No evaluated case in this run carries a tier.</EmptyRows>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {tiers.map((tier) => (
            <RateRow block={tier.block} key={tier.name} name={tier.name} />
          ))}
        </ul>
      )}
    </section>
  );
}

export type ReportCategoryCardProps = {
  /** `metrics.categories` — first-seen order. Never re-sort. */
  categories: ReportGroupRate[];
  strongestCategory: string | null;
  weakestCategory: string | null;
  className?: string;
};

/** "Performance by category", closed with the strongest/weakest sentence. */
export function ReportCategoryCard({
  categories,
  className,
  strongestCategory,
  weakestCategory,
}: ReportCategoryCardProps) {
  const sameCategory =
    strongestCategory !== null && strongestCategory === weakestCategory;

  return (
    <section className={cn(CARD_CLASS, className)}>
      <h2 className={CARD_TITLE_CLASS}>Performance by category</h2>

      {categories.length === 0 ? (
        <EmptyRows>No evaluated case in this run carries a category.</EmptyRows>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {categories.map((category) => (
            <RateRow block={category.block} key={category.name} name={category.name} />
          ))}
        </ul>
      )}

      <p className="mt-4 border-t border-slate-100 pt-3 text-xs leading-5 text-slate-500">
        {sameCategory ? (
          <>
            <span className="font-medium text-slate-700">{strongestCategory}</span> is both the
            strongest and the weakest category — no other category in this run scored differently.
          </>
        ) : (
          <>
            Strongest:{' '}
            <span className="font-medium text-emerald-700">{strongestCategory ?? '—'}</span> ·
            Weakest: <span className="font-medium text-red-700">{weakestCategory ?? '—'}</span>
          </>
        )}
      </p>
    </section>
  );
}

export type ReportResponsivenessCardProps = {
  /** `metrics.latency` — null when no case in the run recorded a response time. */
  latency: ReportLatency | null;
  /**
   * `metrics.totalCases`, used only to say how many cases recorded no response time and are
   * therefore outside `latency.n`. Omit to leave that line off.
   */
  totalCases?: number;
  /** Deep link for a slowest-case id. Defaults to the report's own `#case-…` anchor. */
  caseHref?: (caseId: string) => string;
  className?: string;
};

/**
 * "Responsiveness" — reported beside the grade, never part of it, so the not-graded badge is the
 * first thing in the card. Band boundaries come from `latency.thresholds`, not from constants.
 */
export function ReportResponsivenessCard({
  caseHref = (caseId) => `#${caseAnchorId(caseId)}`,
  className,
  latency,
  totalCases,
}: ReportResponsivenessCardProps) {
  const missing =
    typeof totalCases === 'number' ? Math.max(0, totalCases - (latency?.n ?? 0)) : null;

  return (
    <section className={cn(CARD_CLASS, className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={CARD_TITLE_CLASS}>Responsiveness</h2>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-slate-700">
          <span aria-hidden className="inline-block size-1.5 rounded-full bg-slate-500" />
          Not graded
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-5 text-slate-500">
        Response time is reported for reference only — it is not part of the weighted score or any
        grade on this page.
      </p>

      {latency === null ? (
        <>
          <p className="mt-4 text-3xl font-semibold tabular-nums text-slate-300">—</p>
          <p className="mt-2 text-sm text-slate-500">
            No case in this run recorded a response time.
          </p>
        </>
      ) : (
        <>
          <p className="mt-4 flex items-baseline gap-2">
            {/* Source precision, verbatim — never rounded for tidiness. */}
            <span className="text-3xl font-semibold tabular-nums text-slate-950">
              {latency.avg} {latency.unit}
            </span>
            <span className="text-xs text-slate-500">average</span>
          </p>
          <p className="mt-1 text-xs tabular-nums leading-5 text-slate-500">
            Median {latency.median} {latency.unit} · range {latency.min}–{latency.max}{' '}
            {latency.unit} · n={latency.n}
          </p>
          {missing !== null && missing > 0 ? (
            <p className="mt-1 text-xs tabular-nums leading-5 text-slate-500">
              {missing} of {totalCases} case{missing === 1 ? '' : 's'} recorded no response time
              (—) and {missing === 1 ? 'is' : 'are'} excluded from this average.
            </p>
          ) : null}

          <ReportSegmentedBar
            className="mt-4"
            segments={LATENCY_SEGMENTS.map((segment) => ({
              className: segment.bar,
              // Counts, not stored percentages — the contract carries no band percentages.
              percent: latency.n > 0 ? (latency.bands[segment.key] / latency.n) * 100 : 0,
            }))}
          />

          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums text-slate-500">
            {LATENCY_SEGMENTS.map((segment) => (
              <li className="flex items-center gap-1.5" key={segment.key}>
                <span
                  aria-hidden
                  className={cn('inline-block size-2 rounded-full', segment.dot)}
                />
                {latency.bands[segment.key]} {segment.label}
                {segment.key === 'good'
                  ? ` (≤ ${latency.thresholds.good} ${latency.unit})`
                  : segment.key === 'acceptable'
                    ? ` (≤ ${latency.thresholds.slow} ${latency.unit})`
                    : ` (> ${latency.thresholds.slow} ${latency.unit})`}
              </li>
            ))}
          </ul>

          {latency.slowest.length > 0 ? (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
                Slowest cases
              </p>
              <ul className="mt-2 space-y-1 text-xs tabular-nums text-slate-600">
                {latency.slowest.map((entry) => (
                  <li className="flex items-baseline justify-between gap-3" key={entry.id}>
                    <a
                      className="truncate font-mono underline decoration-slate-300 underline-offset-4 hover:text-slate-900"
                      href={caseHref(entry.id)}
                      title={entry.id}
                    >
                      {shortCaseId(entry.id)}
                    </a>
                    <span className="shrink-0">
                      {entry.seconds} {latency.unit}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export type ReportBreakdownCardsProps = ReportTierCardProps &
  Omit<ReportCategoryCardProps, 'className'> &
  Omit<ReportResponsivenessCardProps, 'className'>;

/** The three cards laid out as one row under the verdict strip. */
export function ReportBreakdownCards({
  caseHref,
  categories,
  className,
  latency,
  strongestCategory,
  tiers,
  totalCases,
  weakestCategory,
}: ReportBreakdownCardsProps) {
  return (
    <div className={cn('grid grid-cols-1 gap-4 lg:grid-cols-3', className)}>
      <ReportTierCard tiers={tiers} />
      <ReportCategoryCard
        categories={categories}
        strongestCategory={strongestCategory}
        weakestCategory={weakestCategory}
      />
      <ReportResponsivenessCard
        caseHref={caseHref}
        latency={latency}
        totalCases={totalCases}
      />
    </div>
  );
}
