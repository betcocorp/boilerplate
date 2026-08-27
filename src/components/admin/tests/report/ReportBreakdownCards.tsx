/**
 * B0-588 (epic B0-571) — the breakdown cards that sit under the verdict strip on the run report:
 * performance by tier, performance by category, and — on its own row since B0-718 — speed.
 *
 * Every figure here is read straight off the B0-586 wire contract (`ReportMetricsData`). Nothing
 * is averaged, re-rated, re-rounded or re-banded in this file: `avg` and the pass/partial/fail
 * percentages arrive already rounded to one decimal, timings and speed scores arrive rounded once
 * at source, and all of them are printed verbatim. The only arithmetic is laying segment widths
 * out along a bar and counting how many cases recorded no timing at all.
 *
 * Presentation only — the container owns fetching.
 */

import { Fragment, type ReactNode } from 'react';

import type {
  ReportGroupRate,
  ReportRateBlock,
  ReportRateGrade,
  ReportSpeed,
  ReportSpeedMetricAggregate,
} from '~/lib/tests/report/data-schemas';
import { caseAnchorId } from '~/lib/tests/report/render';
import { SPEED_METRIC_LABELS } from '~/lib/tests/report/speed-rules';
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

/** Speed bands, in bar order. Same three bands `metricBand` assigns, never a fourth. */
const SPEED_BAND_SEGMENTS = [
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

export type ReportSpeedCardProps = {
  /** `metrics.speed` — null when no case in the run recorded either timing. */
  speed: ReportSpeed | null;
  /**
   * `metrics.totalCases`, used only to say how many cases recorded no timing at all and are
   * therefore outside `speed.n`. Omit to leave that line off.
   */
  totalCases?: number;
  /** Deep link for a fastest/slowest case id. Defaults to the report's own `#case-…` anchor. */
  caseHref?: (caseId: string) => string;
  className?: string;
};

/** A case id, linked back to its ledger entry. */
function CaseLink({ href, id }: { href: string; id: string }) {
  return (
    <a
      className="truncate font-mono underline decoration-slate-300 underline-offset-4 hover:text-slate-900"
      href={href}
      title={id}
    >
      {shortCaseId(id)}
    </a>
  );
}

/** Fastest/slowest for one metric — ids and their seconds, exactly as the payload ordered them. */
function ExtremeList({
  caseHref,
  entries,
  label,
  unit,
}: {
  caseHref: (caseId: string) => string;
  entries: ReportSpeedMetricAggregate['fastest'];
  label: string;
  unit: string;
}) {
  if (entries.length === 0) return null;
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">{label}</p>
      <ul className="mt-1.5 space-y-1 text-xs tabular-nums text-slate-600">
        {entries.map((entry) => (
          <li className="flex items-baseline justify-between gap-3" key={entry.id}>
            <CaseLink href={caseHref(entry.id)} id={entry.id} />
            <span className="shrink-0">
              {entry.seconds} {unit}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * B0-718 — "Speed", reported beside the grade and never part of it. Three things carry that:
 * the not-graded badge is the first thing in the card, the headline figure is a 0–100 speed score
 * labelled with a *word* (never a letter, so it cannot be misread as a grade), and the card sits
 * outside the tier/category row rather than beside it as a peer.
 *
 * Every number is read straight off `metrics.speed`, including the thresholds and the `n/a` P90
 * sentinel — nothing is averaged, re-rated, re-rounded or re-banded in this file. The only
 * arithmetic is laying band counts out along a bar.
 */
export function ReportSpeedCard({
  caseHref = (caseId) => `#${caseAnchorId(caseId)}`,
  className,
  speed,
  totalCases,
}: ReportSpeedCardProps) {
  const untimed =
    typeof totalCases === 'number' ? Math.max(0, totalCases - (speed?.n ?? 0)) : null;
  const aggregates = speed
    ? [speed.metrics.ttft, speed.metrics.total].filter(
        (aggregate): aggregate is ReportSpeedMetricAggregate => aggregate !== null,
      )
    : [];

  return (
    <section className={cn(CARD_CLASS, className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={CARD_TITLE_CLASS}>Speed</h2>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-slate-700">
          <span aria-hidden className="inline-block size-1.5 rounded-full bg-slate-500" />
          Not graded
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-5 text-slate-500">
        Reported separately — speed is not part of the weighted score or any grade on this page.
        The score below is a responsiveness score on its own 0–100 scale, rated in words.
      </p>

      {speed === null ? (
        <p className="mt-4 text-sm text-slate-500">
          Timing data was unavailable for this run — no case recorded a {SPEED_METRIC_LABELS.ttft}{' '}
          or a {SPEED_METRIC_LABELS.total}, so no speed figures are reported.
        </p>
      ) : (
        <>
          <p className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-3xl font-semibold tabular-nums text-slate-950">
              {speed.avgScore}
            </span>
            <span className="text-xs text-slate-500">/ 100 average</span>
            {/* Rating word, verbatim from the contract. Never remapped onto A–F. */}
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
              {speed.rating}
            </span>
          </p>
          <p className="mt-1 text-xs leading-5 tabular-nums text-slate-500">
            Speed Performance Score · median {speed.medianScore} / 100 · {speed.n} timed case
            {speed.n === 1 ? '' : 's'}
          </p>
          {untimed !== null && untimed > 0 ? (
            <p className="mt-1 text-xs leading-5 tabular-nums text-slate-500">
              {untimed} of {totalCases} case{untimed === 1 ? '' : 's'} recorded no timing at all and{' '}
              {untimed === 1 ? 'is' : 'are'} outside every figure here.
            </p>
          ) : null}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-xs tabular-nums text-slate-600">
              <thead className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
                <tr>
                  <th className="py-1.5 pr-3 font-bold">Metric</th>
                  <th className="py-1.5 pr-3 font-bold">n</th>
                  <th className="py-1.5 pr-3 font-bold">Avg</th>
                  <th className="py-1.5 pr-3 font-bold">Median</th>
                  <th className="py-1.5 pr-3 font-bold">P90</th>
                  <th className="py-1.5 pr-3 font-bold">Range</th>
                  <th className="py-1.5 pr-3 font-bold">Avg score</th>
                  <th className="py-1.5 font-bold">Good / acc. / slow</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {aggregates.map((aggregate) => (
                  <tr key={aggregate.metric}>
                    <th className="py-2 pr-3 font-medium text-slate-900" scope="row">
                      {aggregate.label}
                    </th>
                    <td className="py-2 pr-3">{aggregate.n}</td>
                    <td className="py-2 pr-3">
                      {aggregate.avgSeconds} {speed.unit}
                    </td>
                    <td className="py-2 pr-3">
                      {aggregate.medianSeconds} {speed.unit}
                    </td>
                    {/* Already the `n/a` sentinel below the minimum sample size. */}
                    <td className="py-2 pr-3">{aggregate.p90Label}</td>
                    <td className="py-2 pr-3">
                      {aggregate.minSeconds}–{aggregate.maxSeconds} {speed.unit}
                    </td>
                    <td className="py-2 pr-3">{aggregate.avgScore}</td>
                    <td className="py-2">
                      {aggregate.bands.good} / {aggregate.bands.acceptable} / {aggregate.bands.slow}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {aggregates.map((aggregate) => (
            <div className="mt-4" key={`bands-${aggregate.metric}`}>
              <p className="text-[11px] font-medium text-slate-700">{aggregate.label}</p>
              <ReportSegmentedBar
                className="mt-1.5"
                segments={SPEED_BAND_SEGMENTS.map((segment) => ({
                  className: segment.bar,
                  // Counts, not stored percentages — the contract carries no band percentages.
                  percent:
                    aggregate.n > 0 ? (aggregate.bands[segment.key] / aggregate.n) * 100 : 0,
                }))}
              />
              <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums text-slate-500">
                {SPEED_BAND_SEGMENTS.map((segment) => (
                  <li className="flex items-center gap-1.5" key={segment.key}>
                    <span
                      aria-hidden
                      className={cn('inline-block size-2 rounded-full', segment.dot)}
                    />
                    {aggregate.bands[segment.key]} {segment.label}
                    {/* Thresholds in force, from the payload — never restated as prose. */}
                    {segment.key === 'good'
                      ? ` (≤ ${aggregate.thresholds.good} ${speed.unit})`
                      : segment.key === 'acceptable'
                        ? ` (≤ ${aggregate.thresholds.acceptable} ${speed.unit})`
                        : ` (> ${aggregate.thresholds.acceptable} ${speed.unit})`}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className="mt-4 border-t border-slate-100 pt-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
              Rating distribution
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums text-slate-500">
              {speed.ratingDistribution.map((entry) => (
                <li key={entry.rating}>
                  {entry.count} {entry.rating}
                </li>
              ))}
            </ul>
          </div>

          {aggregates.length > 0 ? (
            <div className="mt-4 grid gap-4 border-t border-slate-100 pt-3 sm:grid-cols-2 lg:grid-cols-4">
              {aggregates.map((aggregate) => (
                <Fragment key={`extremes-${aggregate.metric}`}>
                  <ExtremeList
                    caseHref={caseHref}
                    entries={aggregate.fastest}
                    label={`${aggregate.label} — fastest`}
                    unit={speed.unit}
                  />
                  <ExtremeList
                    caseHref={caseHref}
                    entries={aggregate.slowest}
                    label={`${aggregate.label} — slowest`}
                    unit={speed.unit}
                  />
                </Fragment>
              ))}
            </div>
          ) : null}

          <p className="mt-4 border-t border-slate-100 pt-3 text-[11px] leading-5 text-slate-500">
            Weighting: {SPEED_METRIC_LABELS.ttft} {speed.weights.ttft} ·{' '}
            {SPEED_METRIC_LABELS.total} {speed.weights.total}.{' '}
            {speed.basisCounts.ttftOnly > 0 || speed.basisCounts.totalOnly > 0 ? (
              <>
                {speed.basisCounts.combined} case
                {speed.basisCounts.combined === 1 ? '' : 's'} scored from both timings,{' '}
                {speed.basisCounts.ttftOnly} from {SPEED_METRIC_LABELS.ttft} alone and{' '}
                {speed.basisCounts.totalOnly} from {SPEED_METRIC_LABELS.total} alone — the
                remaining weight is renormalized, never imputed.
              </>
            ) : (
              <>All {speed.basisCounts.combined} timed cases were scored from both timings.</>
            )}
          </p>
        </>
      )}
    </section>
  );
}

export type ReportBreakdownCardsProps = ReportTierCardProps &
  Omit<ReportCategoryCardProps, 'className'> &
  Omit<ReportSpeedCardProps, 'className'>;

/**
 * The breakdown cards under the verdict strip: the two grade breakdowns side by side, then speed
 * on its own row beneath them. The split is deliberate (B0-718) — speed sitting as a third peer
 * beside "Performance by tier" and "Performance by category" invited exactly the reading that
 * methodology §7 forbids.
 */
export function ReportBreakdownCards({
  caseHref,
  categories,
  className,
  speed,
  strongestCategory,
  tiers,
  totalCases,
  weakestCategory,
}: ReportBreakdownCardsProps) {
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ReportTierCard tiers={tiers} />
        <ReportCategoryCard
          categories={categories}
          strongestCategory={strongestCategory}
          weakestCategory={weakestCategory}
        />
      </div>
      <ReportSpeedCard caseHref={caseHref} speed={speed} totalCases={totalCases} />
    </div>
  );
}
