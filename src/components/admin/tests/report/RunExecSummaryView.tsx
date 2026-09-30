'use client';

import { FileDown, Loader2 } from 'lucide-react';
import Link from 'next/link';
import {
  createContext,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { Button } from '~/components/ui/button';
import { formatConceptList } from '~/lib/tests/report/case-concepts';
import { VARIANCE_CAUSE_LABELS } from '~/lib/tests/report/consolidate';
import type {
  ReportConceptRollup,
  ReportConsistency,
  ReportGateFloor,
  ReportGroupRate,
  ReportJudged,
  ReportRateBlock,
  ReportRateGrade,
  ReportScoringRules,
  ReportSpeed,
  ReportSpeedMetricAggregate,
  ReportSpeedRating,
} from '~/lib/tests/report/data-schemas';
import {
  categoryMarkerLegend,
  formatGradingConfig,
  formatRatingDistribution,
  gradeBandsAtPassMark,
  mandatoryMissingCountByCategory,
  plural,
  type ReportExecSummaryData,
  resolveCaseIdMentions,
  scoringRulesSentence,
  weightPercent,
} from '~/lib/tests/report/exec-summary';
import { caseAnchorId } from '~/lib/tests/report/render';
import { SPEED_METRIC_LABELS } from '~/lib/tests/report/speed-rules';
import { cn } from '~/lib/utils';

/**
 * B0-834 — the leadership one-pager: the `agent-evaluation` skill's executive summary, rendered
 * in-app from the same `ReportDataReady` the detailed report is built from (minus `cases`).
 *
 * Section order follows the skill's PDF exactly: header, scorecard, tier table, category table
 * with † markers and legend, strongest/weakest, pass-mark line, speed, judged metrics (≤ 2
 * lines), concept coverage (≤ 3 lines), grading consistency (1 line), Top 3, executive assessment.
 *
 * Two rules from `data-schemas.ts` hold throughout: every regulated value (concept phrases,
 * synthesis prose, sub-scores, seconds, percentages, thresholds) is printed exactly as received —
 * no rounding, unit conversion, slicing, clamping or ellipsis — and nothing is recomputed. The
 * only derivations here are counts (`mandatoryMissingCountByCategory`) and prose tokenization.
 *
 * Bex's scoring has no 59 cap, no 70 floor and no automatic Pass (B0-813); the wording below
 * never claims one, even where the skill's own PDF does.
 */

type ExecLinkContextValue = {
  /** `/admin/tests/{testId}/runs/{runId}/report` — every case id links into the detailed ledger. */
  reportHref: string;
  /** Evaluated case ids, for resolving 8-hex shorthand in synthesis prose. */
  perCaseIds: string[];
};

const ExecLinkContext = createContext<ExecLinkContextValue>({
  reportHref: '',
  perCaseIds: [],
});

const GRADE_CLASSES: Record<ReportRateGrade, string> = {
  A: 'text-emerald-700',
  B: 'text-emerald-700',
  C: 'text-amber-700',
  D: 'text-amber-700',
  F: 'text-red-700',
  '-': 'text-slate-500',
};

/** Rating words keep their own palette and are never mapped onto A–F. */
const SPEED_RATING_CLASSES: Record<ReportSpeedRating, string> = {
  Excellent: 'text-emerald-700',
  Good: 'text-emerald-700',
  Acceptable: 'text-amber-700',
  Slow: 'text-red-700',
  'Very slow': 'text-red-700',
};

/** A fail share at or above this reads in red. Display only; nothing is decided by it. */
const FAIL_PCT_ALERT = 50;

/** Cap on the mandatory-miss id list — the one list the ticket caps (`+n more`). */
const MISSING_MANDATORY_ID_CAP = 10;

function sanitizeFilename(name: string): string {
  const trimmed = name.trim() || 'executive-summary';
  return trimmed.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 100);
}

const subscribeToNothing = () => () => {};

/**
 * The browser's origin, hydration-safe: the server snapshot is `''` and the client snapshot is
 * `window.location.origin`, so the "Test run:" line prints an absolute URL (usable from a printed
 * PDF, like the skill's own summary) without a server/client markup mismatch.
 */
function useOrigin(): string {
  return useSyncExternalStore(
    subscribeToNothing,
    () => window.location.origin,
    () => '',
  );
}

/** The 8-hex first segment — the shorthand the synthesis model uses; the full id sits in `title`. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** A case id linked into the detailed report's ledger (`<details>` auto-opens on the hash). */
function CaseLink({ id, display }: { id: string; display?: string }) {
  const { reportHref } = useContext(ExecLinkContext);
  return (
    <Link
      className="font-mono text-sky-700 underline decoration-sky-300 underline-offset-2 hover:decoration-sky-700"
      href={`${reportHref}#${caseAnchorId(id)}`}
      title={id}
    >
      {display ?? shortId(id)}
    </Link>
  );
}

/** Comma-joined case links, optionally capped with `+n more` (the ids beyond the cap are not shown). */
function IdList({ ids, max }: { ids: readonly string[]; max?: number }) {
  const shown = max == null ? ids : ids.slice(0, max);
  const hidden = ids.length - shown.length;
  return (
    <>
      {shown.map((id, index) => (
        <Fragment key={id}>
          {index > 0 ? ', ' : null}
          <CaseLink id={id} />
        </Fragment>
      ))}
      {hidden > 0 ? `, +${hidden} more` : null}
    </>
  );
}

/**
 * Synthesis prose, verbatim, with every case-id mention linked. The text between mentions is the
 * exact string the synthesizer wrote; `whitespace-pre-wrap` preserves its line breaks.
 */
function Prose({ text }: { text: string }) {
  const { perCaseIds } = useContext(ExecLinkContext);
  const segments = resolveCaseIdMentions(text, perCaseIds);
  return (
    <span className="whitespace-pre-wrap">
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          <Fragment key={index}>{segment.text}</Fragment>
        ) : (
          <CaseLink display={segment.display} id={segment.id} key={index} />
        ),
      )}
    </span>
  );
}

function Section({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <section
      className={cn('border-t border-slate-200 pt-4', className)}
      data-exec-section
    >
      {title ? (
        <h2 className="text-sm font-semibold tracking-tight text-slate-950">
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}

function Line({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cn('mt-1.5 text-sm leading-6 text-slate-700', className)}>
      {children}
    </p>
  );
}

function Grade({ grade }: { grade: ReportRateGrade }) {
  return (
    <span className={cn('font-semibold', GRADE_CLASSES[grade])}>{grade}</span>
  );
}

const TH_CLASS =
  'border-b border-slate-300 px-2 py-1 text-left font-semibold text-slate-600';
const TD_CLASS = 'border-b border-slate-200 px-2 py-1 align-top text-slate-800';
const NUM_CLASS = 'text-right tabular-nums';

function RateRow({
  block,
  marker,
  name,
}: {
  block: ReportRateBlock;
  marker?: number;
  name: string;
}) {
  return (
    <tr>
      <td className={TD_CLASS}>
        {name}
        {marker != null && marker > 0 ? (
          <span className="ml-1 font-semibold text-red-700">†{marker}</span>
        ) : null}
      </td>
      <td className={cn(TD_CLASS, NUM_CLASS)}>{block.n}</td>
      <td className={cn(TD_CLASS, NUM_CLASS)}>{block.avg ?? '—'}</td>
      <td className={cn(TD_CLASS, 'text-center')}>
        <Grade grade={block.grade} />
      </td>
      <td className={cn(TD_CLASS, NUM_CLASS)}>{block.passPct}%</td>
      <td
        className={cn(
          TD_CLASS,
          NUM_CLASS,
          block.n > 0 &&
            block.failPct >= FAIL_PCT_ALERT &&
            'font-semibold text-red-700',
        )}
      >
        {block.failPct}%
      </td>
    </tr>
  );
}

function RateTable({
  firstColumn,
  markers,
  rows,
}: {
  firstColumn: string;
  markers?: Record<string, number>;
  rows: ReportGroupRate[];
}) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className={TH_CLASS}>{firstColumn}</th>
            <th className={cn(TH_CLASS, NUM_CLASS)}>N</th>
            <th className={cn(TH_CLASS, NUM_CLASS)}>Avg</th>
            <th className={cn(TH_CLASS, 'text-center')}>Grade</th>
            <th className={cn(TH_CLASS, NUM_CLASS)}>Pass</th>
            <th className={cn(TH_CLASS, NUM_CLASS)}>Fail</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className={cn(TD_CLASS, 'text-slate-500')} colSpan={6}>
                No evaluated cases.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <RateRow
                block={row.block}
                key={row.name}
                marker={markers?.[row.name]}
                name={row.name}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function ScoreTile({
  caption,
  label,
  value,
  valueClassName,
}: {
  caption?: ReactNode;
  label: string;
  value: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-center">
      <p className="text-[11px] font-semibold tracking-[0.16em] text-slate-500 uppercase">
        {label}
      </p>
      <p
        className={cn(
          'mt-1 text-2xl font-semibold tabular-nums text-slate-950',
          valueClassName,
        )}
      >
        {value}
      </p>
      {caption ? (
        <p className="mt-0.5 text-xs text-slate-500">{caption}</p>
      ) : null}
    </div>
  );
}

function SpeedRow({
  aggregate,
  fallbackLabel,
}: {
  aggregate: ReportSpeedMetricAggregate | null;
  fallbackLabel: string;
}) {
  if (!aggregate) {
    return (
      <tr>
        <td className={TD_CLASS}>{fallbackLabel}</td>
        <td className={cn(TD_CLASS, 'text-slate-500')} colSpan={6}>
          not recorded
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td className={TD_CLASS}>{aggregate.label}</td>
      <td className={cn(TD_CLASS, NUM_CLASS)}>{aggregate.avgSeconds} s</td>
      <td className={cn(TD_CLASS, NUM_CLASS)}>{aggregate.medianSeconds} s</td>
      <td className={cn(TD_CLASS, NUM_CLASS)}>
        {aggregate.p90Seconds == null
          ? aggregate.p90Label
          : `${aggregate.p90Seconds} s`}
      </td>
      <td className={cn(TD_CLASS, NUM_CLASS)}>{aggregate.bands.good}</td>
      <td className={cn(TD_CLASS, NUM_CLASS)}>{aggregate.bands.acceptable}</td>
      <td className={cn(TD_CLASS, NUM_CLASS)}>{aggregate.bands.slow}</td>
    </tr>
  );
}

/** `{id} ({seconds} s), {id} ({seconds} s)` for the two slowest cases of one metric. */
function Outliers({
  entries,
  unit,
}: {
  entries: ReadonlyArray<{ id: string; seconds: number }>;
  unit: string;
}) {
  return (
    <>
      {entries.slice(0, 2).map((entry, index) => (
        <Fragment key={entry.id}>
          {index > 0 ? ', ' : null}
          <CaseLink id={entry.id} /> ({entry.seconds} {unit})
        </Fragment>
      ))}
    </>
  );
}

function SpeedSection({ speed }: { speed: ReportSpeed | null }) {
  if (!speed) {
    return (
      <Section title="Speed performance (separate from the content grade)">
        <Line>
          Timing data was unavailable for this run — no case recorded a time to
          first token or a total response time; content grading is unaffected.
        </Line>
      </Section>
    );
  }

  const partial = speed.basisCounts.ttftOnly + speed.basisCounts.totalOnly;
  const distribution = formatRatingDistribution(speed.ratingDistribution);

  return (
    <Section title="Speed performance (separate from the content grade)">
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th className={TH_CLASS}>Measure</th>
              <th className={cn(TH_CLASS, NUM_CLASS)}>Avg</th>
              <th className={cn(TH_CLASS, NUM_CLASS)}>Median</th>
              <th className={cn(TH_CLASS, NUM_CLASS)}>P90</th>
              <th className={cn(TH_CLASS, NUM_CLASS)}>Good</th>
              <th className={cn(TH_CLASS, NUM_CLASS)}>Ok</th>
              <th className={cn(TH_CLASS, NUM_CLASS)}>Slow</th>
            </tr>
          </thead>
          <tbody>
            <SpeedRow
              aggregate={speed.metrics.ttft}
              fallbackLabel={SPEED_METRIC_LABELS.ttft}
            />
            <SpeedRow
              aggregate={speed.metrics.total}
              fallbackLabel={SPEED_METRIC_LABELS.total}
            />
          </tbody>
        </table>
      </div>
      <Line>
        <span className="font-semibold text-slate-900">
          Speed Performance Score: {speed.avgScore}/100 (
          <span className={SPEED_RATING_CLASSES[speed.rating]}>
            {speed.rating}
          </span>
          )
        </span>{' '}
        — TTFT {weightPercent(speed.weights.ttft)}% / total{' '}
        {weightPercent(speed.weights.total)}%, normalized to 0–100 before
        weighting{distribution ? `; ${distribution}` : ''}.
      </Line>
      <Line>
        <span className="font-semibold text-slate-900">Outliers:</span>{' '}
        {speed.metrics.ttft ? (
          <>
            slowest to first token{' '}
            <Outliers entries={speed.metrics.ttft.slowest} unit={speed.unit} />
          </>
        ) : null}
        {speed.metrics.ttft && speed.metrics.total ? '; ' : null}
        {speed.metrics.total ? (
          <>
            slowest overall{' '}
            <Outliers entries={speed.metrics.total.slowest} unit={speed.unit} />
          </>
        ) : null}
        .
        {partial > 0
          ? ` ${partial} ${plural(partial, 'case')} had only one timing recorded — the missing measure was not estimated.`
          : null}
      </Line>
    </Section>
  );
}

/** B0-811 — at most two lines, no table. A line whose stat is null is skipped, not zeroed. */
function JudgedSection({ judged }: { judged: ReportJudged }) {
  const t = judged.thresholds;
  const hasExceptions =
    judged.highSimilarityFailures.length > 0 ||
    judged.lowSimilarityPasses.length > 0;

  if (!judged.similarity && !judged.evalConfidence) return null;

  return (
    <Section title="Judged metrics (reported separately, not part of the content grade)">
      {judged.similarity ? (
        <Line>
          Similarity to the ideal answer averages {judged.similarity.avg}{' '}
          (median {judged.similarity.median}, {judged.similarityBands.low} of{' '}
          {judged.similarity.n} {plural(judged.similarity.n, 'case')} below{' '}
          {t.simLow}).
          {judged.highSimilarityFailures.length > 0 ? (
            <span className="text-red-700">
              {' '}
              {judged.highSimilarityFailures.length}{' '}
              {plural(judged.highSimilarityFailures.length, 'case')} closely
              matched the ideal and still failed —{' '}
              <IdList ids={judged.highSimilarityFailures.map((c) => c.id)} />.
            </span>
          ) : null}
          {judged.lowSimilarityPasses.length > 0 ? (
            <>
              {' '}
              {judged.lowSimilarityPasses.length}{' '}
              {plural(judged.lowSimilarityPasses.length, 'case')} passed while
              diverging from the ideal —{' '}
              <IdList ids={judged.lowSimilarityPasses.map((c) => c.id)} />.
            </>
          ) : null}
          {!hasExceptions && judged.similarityScoreCorrelation != null
            ? ` Similarity and content score move together (r = ${judged.similarityScoreCorrelation}) with no exceptions either way.`
            : null}
        </Line>
      ) : null}
      {judged.evalConfidence ? (
        <Line>
          Evaluator confidence in these grades averages{' '}
          {judged.evalConfidence.avg}
          {judged.reviewQueue.length > 0 ? (
            <span className="text-amber-700">
              ; {judged.reviewQueue.length}{' '}
              {plural(judged.reviewQueue.length, 'grade')} held at{' '}
              {t.lowConfidence} or below and want an SME look —{' '}
              {judged.reviewQueue.map((entry, index) => (
                <Fragment key={entry.id}>
                  {index > 0 ? ', ' : null}
                  <CaseLink id={entry.id} /> ({entry.evalConfidence})
                </Fragment>
              ))}
              .
            </span>
          ) : (
            `, with no grade at or below the ${t.lowConfidence} review threshold.`
          )}
        </Line>
      ) : null}
    </Section>
  );
}

/**
 * B0-713 / B0-835 — at most three lines, the skill's `build_summary.js` concept block: coverage
 * shares; the gate, automatic-Pass and material-issue counts with the rules in force; recurring
 * gaps. Every count is read off `concepts` / `gateFloor`, and every rule statement is written from
 * `rules`, so a report scored with a rule off never claims it fired.
 */
function ConceptSection({
  concepts,
  gateFloor,
  rules,
}: {
  concepts: ReportConceptRollup;
  gateFloor: ReportGateFloor;
  rules: ReportScoringRules;
}) {
  const recurring = concepts.recurringMissing.slice(0, 3);
  const gateOn = rules.minimalGate.enabled;
  // Under the gate every mandatory miss is a gated case; with the gate off the miss is reported only.
  const missingIds = gateOn
    ? concepts.gatedIds
    : concepts.missingMandatory.map((c) => c.id);
  return (
    <Section title="Concept coverage">
      <Line>
        {concepts.mandatory.pct}% satisfied all mandatory concepts (
        {concepts.mandatory.casesSatisfyingAll}/
        {concepts.mandatory.casesSpecifying}); {concepts.expected.pct}%
        satisfied all expected key concepts (
        {concepts.expected.casesSatisfyingAll}/
        {concepts.expected.casesSpecifying}).
      </Line>
      <Line>
        <span
          className={cn(
            'font-semibold',
            missingIds.length > 0 ? 'text-red-700' : 'text-emerald-700',
          )}
        >
          {missingIds.length}
        </span>{' '}
        {plural(missingIds.length, 'response')} missing a mandatory concept
        {missingIds.length > 0 ? (
          <>
            {' '}
            (<IdList ids={missingIds} max={MISSING_MANDATORY_ID_CAP} />)
          </>
        ) : null}
        {gateOn ? (
          <>
            ,{' '}
            <span
              className={cn(
                'font-semibold',
                concepts.preventedIds.length > 0
                  ? 'text-red-700'
                  : 'text-slate-600',
              )}
            >
              {concepts.preventedIds.length}
            </span>{' '}
            of them blocked from a Pass they would otherwise have earned.
          </>
        ) : (
          <> — reported only; the mandatory gate is off for this report.</>
        )}{' '}
        <span className="font-semibold text-slate-900">
          {concepts.autoPassIds.length}
        </span>{' '}
        qualified for automatic Pass on full expected coverage
        {concepts.autoPassBlockedIds.length > 0 ? (
          <>
            ; {concepts.autoPassBlockedIds.length} withheld over a material
            factual issue (
            <IdList
              ids={concepts.autoPassBlockedIds}
              max={MISSING_MANDATORY_ID_CAP}
            />
            )
          </>
        ) : null}
        . {concepts.materialIssues.length} flagged with a material factual
        issue.{' '}
        <span className="text-slate-600">
          {scoringRulesSentence(rules, gateFloor)}
        </span>
      </Line>
      {recurring.length > 0 ? (
        <Line>
          <span className="font-semibold text-slate-900">Recurring gaps:</span>{' '}
          {recurring.map((entry, index) => (
            <Fragment key={entry.concept}>
              {index > 0 ? ', ' : null}
              {/* Concept phrases verbatim — they carry ratios, contact times, ppm and EPA numbers. */}
              {formatConceptList([entry.concept])} ({entry.count}×)
            </Fragment>
          ))}
        </Line>
      ) : null}
    </Section>
  );
}

/** B0-721 — one line. Omitted entirely for a single-pass run (`metrics.consistency` is null). */
function ConsistencySection({
  consistency,
}: {
  consistency: ReportConsistency;
}) {
  const causeLabels = [
    ...new Set(consistency.queue.flatMap((entry) => entry.causes)),
  ].map((cause) => VARIANCE_CAUSE_LABELS[cause]);

  return (
    <Section title="Grading consistency">
      <Line>
        each case graded {consistency.passes}×; headline is the median.{' '}
        {consistency.flagged > 0 ? (
          <span className="text-red-700">
            {consistency.flagged} {plural(consistency.flagged, 'case')} flagged
            for human review
            {causeLabels.length > 0 ? ` (${causeLabels.join(', ')})` : ''}:{' '}
            <IdList ids={consistency.queue.map((entry) => entry.id)} />.
          </span>
        ) : (
          <span className="text-emerald-700">
            all grades stable across passes — none flagged.
          </span>
        )}
      </Line>
    </Section>
  );
}

function LabelledProse({ label, text }: { label: string; text: string }) {
  if (text.trim().length === 0) return null;
  return (
    <p className="mt-1 text-sm leading-6 text-slate-700">
      <span className="font-semibold text-slate-900">{label}:</span>{' '}
      <Prose text={text} />
    </p>
  );
}

type RunExecSummaryViewProps = {
  testId: string;
  runId: string;
  testName: string;
  data: ReportExecSummaryData;
  fileBase: string;
};

export function RunExecSummaryView({
  testId,
  runId,
  testName,
  data,
  fileBase,
}: RunExecSummaryViewProps) {
  const { metrics: m, synthesis, config } = data;
  const runHref = `/admin/tests/${testId}/runs/${runId}`;
  const reportHref = `${runHref}/report`;
  const origin = useOrigin();

  const [pdfLoading, setPdfLoading] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const linkContext = useMemo<ExecLinkContextValue>(
    () => ({ reportHref, perCaseIds: m.perCase.map((c) => c.id) }),
    [reportHref, m.perCase],
  );

  const markers = useMemo(() => mandatoryMissingCountByCategory(m), [m]);
  const anyMarker = Object.values(markers).some((count) => count > 0);

  const gradeBands = gradeBandsAtPassMark(m.passMark);
  const top3 = [...synthesis.top3].sort((a, b) => a.priority - b.priority);

  // Mirrors `renderReportMarkdown`'s fallbacks and its cap of three, so the two say the same thing.
  const strongestAreas = (
    synthesis.exec.strongestAreas.length
      ? synthesis.exec.strongestAreas
      : synthesis.strengths
  ).slice(0, 3);
  const improvementAreas = (
    synthesis.exec.improvementAreas.length
      ? synthesis.exec.improvementAreas
      : synthesis.weaknesses
  ).slice(0, 3);
  const mostSignificantFailure =
    synthesis.exec.mostSignificantFailure || synthesis.failurePatterns[0] || '';

  const subtitle = [
    data.intendedAgent ? `${data.intendedAgent} workflow` : null,
    `${m.evaluated} ${plural(m.evaluated, 'question')} evaluated${
      m.uteCount ? ` (+${m.uteCount} unable to evaluate)` : ''
    }`,
    `Generated ${new Date(data.generatedAt).toLocaleString()}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' • ');

  const downloadPdf = useCallback(async () => {
    const root = contentRef.current;
    if (!root) return;
    setPdfLoading(true);
    root.classList.add('exec-pdf-capture');
    try {
      const html2pdf = (await import('html2pdf.js')).default;
      await html2pdf()
        .from(root)
        .set({
          filename: `${sanitizeFilename(fileBase)}.pdf`,
          margin: 12,
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: 'pt', format: 'letter', orientation: 'portrait' },
        })
        .save();
    } finally {
      root.classList.remove('exec-pdf-capture');
      setPdfLoading(false);
    }
  }, [fileBase]);

  return (
    <ExecLinkContext.Provider value={linkContext}>
      <div className="flex flex-col gap-4">
        {/* Toolbar — outside the PDF root. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={runHref}>Back</Link>
            </Button>
            <Button
              disabled={pdfLoading}
              onClick={() => void downloadPdf()}
              size="sm"
              variant="outline"
            >
              {pdfLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FileDown className="size-4" />
              )}
              PDF Download
            </Button>
          </div>
          {data.stale ? (
            <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Items were added or removed since this report was generated —{' '}
              <Link className="font-medium underline" href={reportHref}>
                regenerate it from the detailed report
              </Link>
              .
            </p>
          ) : null}
        </div>

        {/* PDF root — sections 1–10. */}
        <div
          className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"
          ref={contentRef}
        >
          <style>{`
            .exec-pdf-capture [data-exec-section] { break-inside: avoid; page-break-inside: avoid; }
          `}</style>

          {/* 1 — Header */}
          <section data-exec-section>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
              Agent evaluation — executive summary
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              {testName}
            </h1>
            <p className="mt-1 text-sm text-slate-600" suppressHydrationWarning>
              {subtitle}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Test run:{' '}
              <Link className="text-sky-700 underline" href={runHref}>
                {origin}
                {runHref}
              </Link>
            </p>
            <p className="mt-3 text-sm italic leading-6 text-slate-700">
              Content quality: was the response correct and complete? • Speed
              performance: how quickly did the agent begin, and finish,
              responding? The two are scored independently.
            </p>
            {config ? (
              <p className="mt-2 text-xs text-slate-500">
                {formatGradingConfig(config, m.strictPassMark)}
              </p>
            ) : null}
          </section>

          {/* 2 — Scorecard */}
          <section
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            data-exec-section
          >
            <ScoreTile
              caption="out of 100"
              label="Overall score"
              value={m.overall.avg ?? '—'}
            />
            <ScoreTile
              label="Overall grade"
              value={m.overall.grade}
              valueClassName={GRADE_CLASSES[m.overall.grade]}
            />
            <ScoreTile
              caption={`${m.overall.pass} of ${m.evaluated} at ${m.passMark}+`}
              label="Pass rate"
              value={`${m.overall.passPct}%`}
            />
            <ScoreTile
              caption={
                m.uteCount
                  ? `${m.uteCount} unable to evaluate`
                  : 'all evaluable'
              }
              label="Questions"
              value={m.evaluated}
            />
          </section>

          {/* 3 — Tier table */}
          <Section title="Performance by tier">
            <RateTable firstColumn="Tier" rows={m.tiers} />
          </Section>

          {/* 4 — Category table, legend, strongest/weakest, pass mark */}
          <Section title="Performance by category">
            <RateTable
              firstColumn="Category"
              markers={markers}
              rows={m.categories}
            />
            {anyMarker ? (
              /* B0-835 — written from the rules in force: cap, gate-only, or reported-only. */
              <p className="mt-2 text-xs leading-5 text-slate-600">
                <span className="font-semibold text-red-700">†</span>{' '}
                {categoryMarkerLegend(m.scoringRules)}
              </p>
            ) : null}
            <Line className="italic">
              Strongest: {m.strongestCategory ?? '—'} • Weakest:{' '}
              {m.weakestCategory ?? '—'}
            </Line>
            <Line>
              <span className="font-semibold text-slate-900">Pass mark:</span>{' '}
              {m.passMark} or above
              {gradeBands
                ? ` (${gradeBands.pass.join('/')} pass · ${gradeBands.fail.join('/')} fail)`
                : ''}
              .{' '}
              {m.passOnlyUnderCurrentMark.length > 0 ? (
                <span className="text-amber-700">
                  {m.passOnlyUnderCurrentMark.length}{' '}
                  {plural(
                    m.passOnlyUnderCurrentMark.length,
                    'case passes',
                    'cases pass',
                  )}{' '}
                  only under this mark and would Fail at {m.strictPassMark}:{' '}
                  <IdList ids={m.passOnlyUnderCurrentMark} />.
                </span>
              ) : (
                'No case passes only under this mark.'
              )}
            </Line>
          </Section>

          {/* 5 — Speed */}
          <SpeedSection speed={m.speed} />

          {/* 6 — Judged metrics */}
          {m.judged ? <JudgedSection judged={m.judged} /> : null}

          {/* 7 — Concept coverage */}
          {m.concepts ? (
            <ConceptSection
              concepts={m.concepts}
              gateFloor={m.gateFloor}
              rules={m.scoringRules}
            />
          ) : null}

          {/* 8 — Grading consistency */}
          {m.consistency ? (
            <ConsistencySection consistency={m.consistency} />
          ) : null}

          {/* 9 — Top 3 */}
          <Section title="Top 3 recommended agent improvements">
            {top3.length === 0 ? (
              <Line className="text-slate-500">
                This report&rsquo;s synthesis produced no prioritized
                improvements.
              </Line>
            ) : (
              <div className="mt-2 space-y-3">
                {top3.map((rec, index) => (
                  <div data-exec-section key={`${rec.priority}-${index}`}>
                    <h3 className="text-sm font-semibold leading-6 text-slate-900">
                      Priority #{rec.priority}: <Prose text={rec.what} />
                    </h3>
                    <LabelledProse label="Why first" text={rec.whyFirst} />
                    <LabelledProse label="Evidence" text={rec.evidence} />
                    <LabelledProse label="Affected" text={rec.affected} />
                    <LabelledProse label="Change" text={rec.change} />
                    <LabelledProse label="Expected impact" text={rec.impact} />
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* 10 — Executive assessment */}
          <Section title="Executive assessment">
            <Line>
              <span className="font-semibold text-slate-900">
                Overall grade:
              </span>{' '}
              <Grade grade={m.overall.grade} /> ({m.overall.avg ?? '—'}/100).
              Reflects calculated performance; not adjusted.
            </Line>
            <Line>
              <span className="font-semibold text-slate-900">
                Strongest areas:
              </span>{' '}
              {strongestAreas.length > 0 ? (
                <Prose text={strongestAreas.join(' • ')} />
              ) : (
                '—'
              )}
            </Line>
            <Line>
              <span className="font-semibold text-slate-900">
                Areas needing improvement:
              </span>{' '}
              {improvementAreas.length > 0 ? (
                <Prose text={improvementAreas.join(' • ')} />
              ) : (
                '—'
              )}
            </Line>
            <Line>
              <span className="font-semibold text-slate-900">
                Most significant failure pattern:
              </span>{' '}
              {mostSignificantFailure ? (
                <Prose text={mostSignificantFailure} />
              ) : (
                '—'
              )}
            </Line>
            <LabelledProse label="Major risk" text={synthesis.exec.majorRisk} />
            <LabelledProse
              label="Readiness for broader testing"
              text={synthesis.exec.readiness}
            />
          </Section>
        </div>
      </div>
    </ExecLinkContext.Provider>
  );
}

/**
 * The page's "nothing to show yet" card — the run has not finished, or its report has not been
 * generated. This page never triggers generation; the detailed report owns that.
 */
export function ExecSummaryUnavailable({
  children,
  link,
}: {
  children: ReactNode;
  link: { href: string; label: string };
}) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
        Agent evaluation — executive summary
      </p>
      <p className="mt-3 text-sm text-slate-600">
        {children}{' '}
        <Link className="font-medium text-sky-700 underline" href={link.href}>
          {link.label}
        </Link>
      </p>
    </section>
  );
}
