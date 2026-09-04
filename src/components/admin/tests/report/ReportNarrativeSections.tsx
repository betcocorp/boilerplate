import { ChevronRight, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatConceptList } from '~/lib/tests/report/case-concepts';
import {
  CONCEPT_DISAGREEMENT_LABELS,
  VARIANCE_CAUSE_LABELS,
} from '~/lib/tests/report/consolidate';
import type {
  ReportConceptDisagreement,
  ReportConceptRollup,
  ReportConsistency,
  ReportGradingConfigData,
  ReportJudged,
  ReportMetricsData,
  ReportVarianceCause,
} from '~/lib/tests/report/data-schemas';
import { GRADE_BANDS, WEIGHTS } from '~/lib/tests/report/metrics';
import type { ReportSynthesis } from '~/lib/tests/report/schemas';
import { DEFAULT_PASS_MARK, STRICT_PASS_MARK } from '~/lib/tests/report/scoring-config';
import { cn } from '~/lib/utils';

/**
 * B0-591 — the report's three narrative blocks: the executive assessment (sidebar), the aggregate
 * findings (full width, after the ledger) and the methodology disclosure.
 *
 * Two rules govern everything below:
 *
 * 1. **Generated prose is rendered verbatim.** Every string here comes from `reportSynthesisSchema`
 *    and quotes regulated values — dilution ratios, contact times, ppm, oz/gal, mL/L and EPA/DIN
 *    numbers. Nothing is re-worded, summarized, sliced, clamped or ellipsized; `whitespace-pre-wrap`
 *    keeps the synthesizer's own line breaks. (The Markdown renderer caps the executive lists at
 *    three items; this UI deliberately does not.)
 * 2. **The stated scoring rule is the applied one.** The weighting and grade bands in the
 *    methodology are rendered from `WEIGHTS` / `GRADE_BANDS` — the same constants
 *    `computeReportMetrics` and `gradeFromScore` use — and the pass mark is the one the report was
 *    graded at (`metrics.passMark`), so the methodology can never drift from the arithmetic it
 *    describes.
 *
 * The three blocks sit in three different places in the page layout, so they are exported
 * separately rather than as one section stack.
 */

/** Restated wherever an excluded case or an average is visible (methodology §11). */
const UTE_EXCLUSION_RULE =
  'Cases that could not be judged are marked "Unable to Evaluate" and are excluded from every average, grade, count and rate.';

const SUB_SCORE_LABELS: Record<keyof typeof WEIGHTS, string> = {
  accuracy: 'Accuracy',
  completeness: 'Completeness',
  relevance: 'Relevance',
  clarity: 'Clarity',
};

/** `0.4 → '40%'` without float noise (`0.4 * 100` is `40.000000000000006`). */
function weightPercent(weight: number): string {
  return `${Number((weight * 100).toFixed(6))}%`;
}

/**
 * Turns an ordered highest-first band list into human ranges without restating any threshold:
 * the top band is `≥ min`, a middle band runs to one below the band above it, and the 0 floor
 * reads `below <next band's min>`.
 */
function bandRangeLabel(
  bands: ReadonlyArray<{ min: number }>,
  index: number,
): string {
  if (index === 0) return `≥ ${bands[index]!.min}`;
  const above = bands[index - 1]!.min;
  return bands[index]!.min === 0 ? `below ${above}` : `${bands[index]!.min}–${above - 1}`;
}

/** Verbatim generated prose. Never truncated — the container grows to fit it. */
function Prose({ children, className }: { children: string; className?: string }) {
  return (
    <p className={cn('whitespace-pre-wrap break-words text-sm text-slate-700', className)}>
      {children}
    </p>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </h3>
  );
}

function VerbatimList({ items }: { items: readonly string[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-slate-400">—</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={`${index}-${item}`} className="flex gap-2 text-sm text-slate-700">
          <span aria-hidden className="mt-[0.45rem] size-1.5 shrink-0 rounded-full bg-slate-300" />
          <span className="whitespace-pre-wrap break-words">{item}</span>
        </li>
      ))}
    </ul>
  );
}

export type ReportExecutiveAssessmentProps = {
  synthesis: ReportSynthesis;
  className?: string;
};

/**
 * The narrative half of the verdict — sits beside the top-3 fix list.
 *
 * Mirrors `renderReportMarkdown`'s fallbacks (an empty `exec` list falls back to the aggregate
 * strengths/weaknesses, an empty failure line to the first aggregate pattern) so the page and the
 * exported Markdown say the same thing, but shows every item rather than the Markdown's first three.
 */
export function ReportExecutiveAssessment({
  synthesis,
  className,
}: ReportExecutiveAssessmentProps) {
  const { exec } = synthesis;
  const strongestAreas = exec.strongestAreas.length ? exec.strongestAreas : synthesis.strengths;
  const improvementAreas = exec.improvementAreas.length
    ? exec.improvementAreas
    : synthesis.weaknesses;
  const mostSignificantFailure =
    exec.mostSignificantFailure || synthesis.failurePatterns[0] || '';

  const paragraphs: Array<{ label: string; text: string }> = [
    { label: 'Most significant failure pattern', text: mostSignificantFailure },
    { label: 'Major risk', text: exec.majorRisk },
    { label: 'Readiness for broader testing', text: exec.readiness },
  ].filter((entry) => entry.text.trim().length > 0);

  return (
    <section
      aria-labelledby="report-executive-assessment-heading"
      className={cn(
        'rounded-2xl border border-slate-200 bg-white p-6 shadow-sm',
        className,
      )}
      id="report-executive-assessment"
    >
      <h2
        className="text-lg font-semibold tracking-tight text-slate-950"
        id="report-executive-assessment-heading"
      >
        Executive assessment
      </h2>

      <div className="mt-5 space-y-5">
        <div className="space-y-2">
          <SectionLabel>Strongest areas</SectionLabel>
          <VerbatimList items={strongestAreas} />
        </div>

        <div className="space-y-2">
          <SectionLabel>Areas needing improvement</SectionLabel>
          <VerbatimList items={improvementAreas} />
        </div>

        {paragraphs.map((entry) => (
          <div className="space-y-2" key={entry.label}>
            <SectionLabel>{entry.label}</SectionLabel>
            <Prose>{entry.text}</Prose>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * B0-713 — the run-level concept readout. Every number is read straight off
 * `metrics.concepts`; nothing here counts cases.
 *
 * Two things it is careful about:
 *
 * - The denominator is *cases that specify concepts of that kind*, never the whole run. A run
 *   where three of forty cases carry criteria must not report "3 of 40 satisfied all mandatory
 *   concepts" — the other thirty-seven were never asked.
 * - The whole block is absent when `metrics.concepts` is null, so a run with no concept data
 *   shows no heading and no "0 of 0".
 */
function ConceptCoverageRollup({ concepts }: { concepts: ReportConceptRollup }) {
  return (
    <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <h3 className="text-sm font-semibold text-slate-900">Concept coverage</h3>
      <p className="mt-1 text-xs text-slate-600">
        Across the {concepts.casesWithConcepts} evaluated{' '}
        {concepts.casesWithConcepts === 1 ? 'case' : 'cases'}. Percentages are out of the cases
        that specify concepts of that kind, not the whole run.
      </p>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <dt className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
            Satisfied every mandatory concept
          </dt>
          <dd className="mt-1 text-sm text-slate-900 tabular-nums">
            {concepts.mandatory.casesSatisfyingAll} of {concepts.mandatory.casesSpecifying} (
            {concepts.mandatory.pct}%)
          </dd>
        </div>
        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <dt className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
            Satisfied every expected concept
          </dt>
          <dd className="mt-1 text-sm text-slate-900 tabular-nums">
            {concepts.expected.casesSatisfyingAll} of {concepts.expected.casesSpecifying} (
            {concepts.expected.pct}%)
          </dd>
        </div>
      </dl>

      <ul className="mt-4 space-y-1.5 text-sm text-slate-700">
        <li>
          <span className="font-medium text-rose-700 tabular-nums">
            {concepts.missingMandatory.length}
          </span>{' '}
          missing a mandatory concept — reported on each case; the miss lowered Completeness through
          coverage and did not by itself change any Result.
        </li>
        <li>
          <span className="font-medium text-amber-700 tabular-nums">
            {concepts.materialIssues.length}
          </span>{' '}
          flagged by the grader with a material factual issue — reported, not scored.
        </li>
      </ul>

      {concepts.missingMandatory.length > 0 ? (
        <div className="mt-5">
          <SectionLabel>Cases missing a mandatory concept</SectionLabel>
          <ul className="mt-2 space-y-2">
            {concepts.missingMandatory.map((entry) => (
              <li className="text-sm" key={entry.id}>
                <a className="font-mono text-[0.6875rem] text-sky-700 hover:underline" href={`#case-${entry.id}`}>
                  {entry.id}
                </a>
                {/* Concept phrases verbatim — regulated free text, never re-worded. */}
                <p className="break-words whitespace-pre-wrap text-rose-700">
                  {formatConceptList(entry.missing)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {concepts.materialIssues.length > 0 ? (
        <div className="mt-5">
          <SectionLabel>Material factual issues</SectionLabel>
          <ul className="mt-2 space-y-2">
            {concepts.materialIssues.map((entry) => (
              <li className="text-sm" key={entry.id}>
                <a className="font-mono text-[0.6875rem] text-sky-700 hover:underline" href={`#case-${entry.id}`}>
                  {entry.id}
                </a>
                <p className="break-words whitespace-pre-wrap text-amber-800">
                  {entry.note ?? 'material factual issue recorded'}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {concepts.recurringMissing.length > 0 ? (
        <div className="mt-5">
          <SectionLabel>Recurring missing concepts</SectionLabel>
          <ul className="mt-2 space-y-2">
            {concepts.recurringMissing.map((entry) => (
              <li className="text-sm" key={entry.concept}>
                <p className="break-words whitespace-pre-wrap text-slate-800">
                  {formatConceptList([entry.concept])}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  missing in {entry.count} cases ·{' '}
                  {entry.caseIds.map((caseId, index) => (
                    <span key={caseId}>
                      {index > 0 ? ', ' : ''}
                      <a className="font-mono text-sky-700 hover:underline" href={`#case-${caseId}`}>
                        {caseId.slice(0, 8)}
                      </a>
                    </span>
                  ))}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * B0-721 — one split concept judgment, worded from the same label maps the Markdown reads, so the
 * two renderers can never name the same disagreement differently. The phrase is regulated free
 * text: quoted verbatim, never re-worded.
 */
function conceptDisagreementText(d: ReportConceptDisagreement): string {
  const label = CONCEPT_DISAGREEMENT_LABELS[d.kind];
  const subject = d.concept ? `${label} ${formatConceptList([d.concept])}` : label;
  return `${subject} (${d.votesFor} of ${d.voters} passes)`;
}

/** The causes of one flag, in the order `consolidateCasePasses` recorded them. */
function varianceCauseText(
  causes: readonly ReportVarianceCause[],
  disagreements: readonly ReportConceptDisagreement[],
): string {
  return causes
    .map((cause) =>
      cause === 'concept' && disagreements.length > 0
        ? `${VARIANCE_CAUSE_LABELS.concept}: ${disagreements.map(conceptDisagreementText).join('; ')}`
        : VARIANCE_CAUSE_LABELS[cause],
    )
    .join(' · ');
}

/** `58 / 62 / 60`, with a pass that could not evaluate shown as `n/a`, never as a zero. */
export function passOverallsText(overalls: ReadonlyArray<number | null>): string {
  return overalls.map((overall) => (overall == null ? 'n/a' : String(overall))).join(' / ');
}

/**
 * B0-721 — the grading-consistency summary and the human-review queue.
 *
 * Every number is read straight off `metrics.consistency`; nothing here counts cases or re-judges
 * a disagreement. The block is absent entirely when `metrics.consistency` is null — a single-pass
 * run has nothing to compare, and "0 flags" would read as a clean bill of health for a
 * measurement that was never taken.
 */
function GradingConsistencyRollup({ consistency }: { consistency: ReportConsistency }) {
  const con = consistency;
  const causeRows: Array<{ label: string; count: number; tone?: string }> = [
    { label: VARIANCE_CAUSE_LABELS.band_split, count: con.byCause.band_split },
    {
      label: `${VARIANCE_CAUSE_LABELS.score_range} (≥ ${con.spreadThreshold} points)`,
      count: con.byCause.score_range,
    },
    { label: VARIANCE_CAUSE_LABELS.evaluability, count: con.byCause.evaluability },
  ];

  return (
    <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <h3 className="text-sm font-semibold text-slate-900">Grading consistency</h3>
      <p className="mt-1 text-xs text-slate-600">
        Every case was graded {con.passes} times, independently — no pass saw another pass&apos;s
        scores or narrative. The sub-scores in this report are the median of those passes; this is
        how much they disagreed. A flagged case needs a human to settle the grade; it is not a
        failure.
      </p>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <dt className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
            Flagged for human review
          </dt>
          <dd className="mt-1 text-sm text-slate-900 tabular-nums">
            <span className="font-semibold text-amber-700">{con.flagged}</span> of{' '}
            {con.casesConsolidated} cases graded more than once
          </dd>
        </div>
        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <dt className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
            Widest score range
          </dt>
          <dd className="mt-1 text-sm text-slate-900 tabular-nums">{con.maxRange ?? '—'}</dd>
        </div>
      </dl>

      <ul className="mt-4 space-y-1.5 text-sm text-slate-700">
        {causeRows.map((row) => (
          <li key={row.label}>
            <span className="font-medium tabular-nums">{row.count}</span> — {row.label}
          </li>
        ))}
        {/* Called out separately from the other three: a split on a concept is a split on a
            regulated must-have, not on a number. */}
        <li>
          <span className="font-medium text-rose-700 tabular-nums">
            {con.conceptDisagreementCases}
          </span>{' '}
          — {VARIANCE_CAUSE_LABELS.concept}, across{' '}
          <span className="font-medium tabular-nums">{con.conceptDisagreements}</span> individual
          concept {con.conceptDisagreements === 1 ? 'judgment' : 'judgments'}
        </li>
      </ul>

      {con.queue.length > 0 ? (
        <div className="mt-5">
          <SectionLabel>Human-review queue</SectionLabel>
          <ul className="mt-2 space-y-2">
            {con.queue.map((entry) => (
              <li className="rounded-xl bg-white p-3 ring-1 ring-slate-200" key={entry.id}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <a
                    className="font-mono text-[0.6875rem] text-sky-700 hover:underline"
                    href={`#case-${entry.id}`}
                  >
                    {entry.id}
                  </a>
                  <span className="text-xs text-slate-500 tabular-nums">
                    passes {passOverallsText(entry.passOveralls)}
                    {entry.range == null ? '' : ` · range ${entry.range}`}
                    {entry.unableToEvaluate ? ' · Unable to Evaluate' : ''}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm text-slate-800" title={entry.question}>
                  {entry.question}
                </p>
                <p className="mt-1 break-words whitespace-pre-wrap text-xs text-amber-800">
                  {varianceCauseText(entry.causes, entry.conceptDisagreements)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {con.timingDisagreementCases > 0 ? (
        <p className="mt-4 text-xs text-slate-600">
          <span className="font-medium">Data quality (not a grading flag):</span>{' '}
          {con.timingDisagreementCases}{' '}
          {con.timingDisagreementCases === 1 ? 'case' : 'cases'} recorded different timings across
          passes. A timing is a measurement, not a judgment, so it is reported exactly as recorded
          and never averaged. The affected cases are named in the data-quality notes.
        </p>
      ) : null}
    </div>
  );
}

/**
 * B0-811 — the judged-metrics rollup (methodology §7c), under its own heading and explicitly outside
 * the grade: the two distributions, the two exception cells named case by case (or an explicit
 * "none"), and the SME review queue. No average is presented as a verdict.
 */
function JudgedMetricsRollup({ judged }: { judged: ReportJudged }) {
  const t = judged.thresholds;
  const exception = (
    label: string,
    entries: ReportJudged['highSimilarityFailures'],
    none: string,
  ) => (
    <li>
      <span className="font-medium tabular-nums">{entries.length}</span> — {label}
      {entries.length > 0 ? (
        <ul className="mt-1 ml-4 space-y-0.5 text-xs text-slate-600">
          {entries.map((entry) => (
            <li key={entry.id}>
              <a className="font-mono text-sky-700 hover:underline" href={`#case-${entry.id}`}>
                {entry.id.slice(0, 8)}
              </a>{' '}
              similarity {entry.similarity}, scored {entry.overall}
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-slate-500"> ({none})</span>
      )}
    </li>
  );

  return (
    <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Judged metrics</h3>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-slate-700">
          <span aria-hidden className="inline-block size-1.5 rounded-full bg-slate-500" />
          Not graded
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-600">
        Two judgments the grader made while reading each case, reported beside the grade and never
        folded into it: how much of what the Ideal Response says the answer also says, and how sure
        the grader was of the grade it gave. The gap between them and the grade is the point.
      </p>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <dt className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
            Similarity to the Ideal Response
          </dt>
          <dd className="mt-1 text-sm text-slate-900 tabular-nums">
            {judged.similarity ? (
              <>
                avg <span className="font-semibold">{judged.similarity.avg}</span> · median{' '}
                {judged.similarity.median} · range {judged.similarity.min}–{judged.similarity.max} (n=
                {judged.similarity.n})
                <p className="mt-1 text-xs text-slate-600">
                  high (≥ {t.simHigh}) {judged.similarityBands.high} · mid {judged.similarityBands.mid}{' '}
                  · low (&lt; {t.simLow}) {judged.similarityBands.low} · vs content score:{' '}
                  {judged.similarityScoreCorrelation != null
                    ? `r = ${judged.similarityScoreCorrelation}`
                    : `not reported (fewer than ${t.corrMinN} cases, or no variance)`}
                </p>
              </>
            ) : (
              <span className="text-slate-500">not judged on this run</span>
            )}
          </dd>
        </div>
        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <dt className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
            Evaluator confidence
          </dt>
          <dd className="mt-1 text-sm text-slate-900 tabular-nums">
            {judged.evalConfidence ? (
              <>
                avg <span className="font-semibold">{judged.evalConfidence.avg}</span> · median{' '}
                {judged.evalConfidence.median} · range {judged.evalConfidence.min}–
                {judged.evalConfidence.max} (n={judged.evalConfidence.n})
              </>
            ) : (
              <span className="text-slate-500">not judged on this run</span>
            )}
          </dd>
        </div>
      </dl>

      <ul className="mt-4 space-y-1.5 text-sm text-slate-700">
        {exception(
          `close to the ideal (≥ ${t.highSimFail}) and still failed — shape right, substance wrong`,
          judged.highSimilarityFailures,
          'none',
        )}
        {exception(
          `passed while diverging from the ideal (< ${t.lowSimPass}) — right by a different route`,
          judged.lowSimilarityPasses,
          'none',
        )}
      </ul>

      <div className="mt-5">
        <SectionLabel>SME review queue — confidence ≤ {t.lowConfidence}</SectionLabel>
        {judged.reviewQueue.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">Empty — no grade is held at or below the line.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {judged.reviewQueue.map((entry) => (
              <li className="rounded-xl bg-white p-3 ring-1 ring-slate-200" key={entry.id}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <a className="font-mono text-[0.6875rem] text-sky-700 hover:underline" href={`#case-${entry.id}`}>
                    {entry.id}
                  </a>
                  <span className="text-xs text-slate-500 tabular-nums">
                    confidence {entry.evalConfidence} · {entry.status}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm text-slate-800" title={entry.question}>
                  {entry.question}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export type ReportAggregateFindingsProps = {
  synthesis: ReportSynthesis;
  metrics: ReportMetricsData;
  className?: string;
};

/**
 * The run-wide narrative, full width under the case ledger. Also the visible home for the two
 * things that otherwise fall on the floor: `metrics.warnings` (non-fatal reconciliation notes) and
 * the Unable-to-Evaluate roster, each stated with the exclusion rule attached.
 */
export function ReportAggregateFindings({
  synthesis,
  metrics,
  className,
}: ReportAggregateFindingsProps) {
  const groups: Array<{ label: string; items: readonly string[] }> = [
    { label: 'Most common failure patterns', items: synthesis.failurePatterns },
    { label: 'Key strengths', items: synthesis.strengths },
    { label: 'Recurring weaknesses', items: synthesis.weaknesses },
  ];

  return (
    <section
      aria-labelledby="report-aggregate-findings-heading"
      className={cn(
        'rounded-3xl border border-slate-200 bg-white p-8 shadow-sm',
        className,
      )}
      id="report-aggregate-findings"
    >
      <h2
        className="text-lg font-semibold tracking-tight text-slate-950"
        id="report-aggregate-findings-heading"
      >
        Aggregate findings
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        {metrics.evaluated} of {metrics.totalCases}{' '}
        {metrics.totalCases === 1 ? 'question' : 'questions'} evaluated
        {metrics.uteCount > 0 ? ` · ${metrics.uteCount} unable to evaluate` : ''}. Every average,
        grade, count and rate below is out of {metrics.evaluated}.
      </p>

      <div className="mt-6 grid gap-6 md:grid-cols-3">
        {groups.map((group) => (
          <div className="space-y-3" key={group.label}>
            <SectionLabel>{group.label}</SectionLabel>
            <VerbatimList items={group.items} />
          </div>
        ))}
      </div>

      {metrics.concepts ? <ConceptCoverageRollup concepts={metrics.concepts} /> : null}

      {metrics.judged ? <JudgedMetricsRollup judged={metrics.judged} /> : null}

      {metrics.consistency ? (
        <GradingConsistencyRollup consistency={metrics.consistency} />
      ) : null}

      {metrics.warnings.length > 0 ? (
        <div className="mt-8 rounded-2xl border border-amber-300 bg-amber-50 p-5">
          <div className="flex items-center gap-2">
            <TriangleAlert aria-hidden className="size-4 shrink-0 text-amber-700" />
            <h3 className="text-sm font-semibold text-amber-900">Data-quality notes</h3>
          </div>
          <p className="mt-1 text-xs text-amber-800">
            Raised while computing these metrics. The numbers above are still internally
            consistent, but the underlying run data did not fully reconcile.
          </p>
          <ul className="mt-3 space-y-1.5">
            {metrics.warnings.map((warning, index) => (
              <li
                className="whitespace-pre-wrap break-words font-mono text-xs text-amber-900"
                key={`${index}-${warning}`}
              >
                {warning}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {metrics.ute.length > 0 ? (
        <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <h3 className="text-sm font-semibold text-slate-900">
            Unable to evaluate ({metrics.uteCount})
          </h3>
          <p className="mt-1 text-xs text-slate-600">{UTE_EXCLUSION_RULE}</p>
          <ul className="mt-3 space-y-3">
            {metrics.ute.map((ute) => (
              <li className="text-sm" key={ute.id}>
                <p className="whitespace-pre-wrap break-words font-medium text-slate-800">
                  {ute.question}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-slate-600">{ute.reason}</p>
                <p className="mt-1 font-mono text-[0.6875rem] text-slate-400">{ute.id}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export type ReportMethodologyProps = {
  /** Named in the exclusion sentence when the run has excluded cases. */
  uteCount?: number;
  /** B0-812 — the pass mark this report's Results were derived from (`metrics.passMark`). */
  passMark?: number;
  /** The stricter line the report measures against (`metrics.strictPassMark`). */
  strictPassMark?: number;
  /** B0-825 — what this report was graded with (`payload.config`); null on a legacy report. */
  config?: ReportGradingConfigData | null;
  /** Collapsed by default on screen; B0-592 forces it open for the PDF via `details[open]`. */
  defaultOpen?: boolean;
  className?: string;
};

/**
 * The scoring contract, stated plainly. Native `<details>`/`<summary>` — keyboard-operable with no
 * JS, and forceable open for print/PDF export.
 */
export function ReportMethodology({
  uteCount,
  passMark = DEFAULT_PASS_MARK,
  strictPassMark = STRICT_PASS_MARK,
  config = null,
  defaultOpen = false,
  className,
}: ReportMethodologyProps) {
  return (
    <details
      className={cn(
        'group rounded-2xl border border-slate-200 bg-slate-50/60 px-6 py-4',
        className,
      )}
      id="report-methodology"
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-slate-800 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-90"
        />
        Methodology &amp; scoring
      </summary>

      <div className="mt-4 space-y-4 text-sm text-slate-700">
        {config ? (
          <div className="space-y-2">
            <SectionLabel>Graded with</SectionLabel>
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <div className="flex gap-2">
                <dt className="text-slate-500">Model</dt>
                <dd className="font-mono text-xs text-slate-900">{config.model}</dd>
              </div>
              {config.effort ? (
                <div className="flex gap-2">
                  <dt className="text-slate-500">Effort</dt>
                  <dd className="text-slate-900">{config.effort}</dd>
                </div>
              ) : null}
              <div className="flex gap-2">
                <dt className="text-slate-500">Independent passes</dt>
                <dd className="tabular-nums text-slate-900">{config.passes}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500">Pass mark</dt>
                <dd className="tabular-nums text-slate-900">
                  {config.passMark ?? passMark} (strict {strictPassMark})
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500">Spread threshold</dt>
                <dd className="tabular-nums text-slate-900">{config.spreadThreshold ?? '—'}</dd>
              </div>
              {config.judgedThresholds ? (
                <div className="flex gap-2 sm:col-span-2">
                  <dt className="text-slate-500">Judged thresholds</dt>
                  <dd className="tabular-nums text-slate-900">
                    similarity high ≥ {config.judgedThresholds.simHigh} · low &lt;{' '}
                    {config.judgedThresholds.simLow} · review ≤ {config.judgedThresholds.lowConfidence}{' '}
                    confidence · exceptions ≥ {config.judgedThresholds.highSimFail} / &lt;{' '}
                    {config.judgedThresholds.lowSimPass} · correlation from n ≥{' '}
                    {config.judgedThresholds.corrMinN}
                  </dd>
                </div>
              ) : null}
              {config.gradingPromptHash ? (
                <div className="flex gap-2 sm:col-span-2">
                  <dt className="text-slate-500">Grading prompt</dt>
                  <dd className="font-mono text-xs break-all text-slate-900" title={config.gradingPromptHash}>
                    {config.gradingPromptHash.slice(0, 12)}
                  </dd>
                </div>
              ) : null}
            </dl>
            <p className="text-xs text-slate-500">
              Every Result above was derived under exactly these settings; a report graded under
              different ones shows different values here before anything else differs.
            </p>
          </div>
        ) : null}

        <p>
          Cases were matched to this run&apos;s own test items by ID, not row position, so a case
          always carries the expectations of the item it actually ran.
        </p>

        <div className="space-y-2">
          <SectionLabel>Weighted score (0–100)</SectionLabel>
          <ul className="space-y-1">
            {(Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).map((key) => (
              <li key={key}>
                {SUB_SCORE_LABELS[key]} {weightPercent(WEIGHTS[key])}
              </li>
            ))}
          </ul>
          <p className="text-xs text-slate-500">
            Accuracy, Relevance and Clarity are the grader&apos;s judgments. Completeness is
            computed, never judged: the share of the case&apos;s expected concepts the response
            communicated (100 × satisfied ÷ required), from the grader&apos;s per-concept verdicts.
            The weighted roll-up is the case&apos;s score — never raised, never capped.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <SectionLabel>Grade bands</SectionLabel>
            <ul className="space-y-1">
              {GRADE_BANDS.map((band, index) => (
                <li key={band.grade}>
                  <span className="font-medium text-slate-900">{band.grade}</span>{' '}
                  {bandRangeLabel(GRADE_BANDS, index)}
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-2">
            <SectionLabel>Result</SectionLabel>
            <ul className="space-y-1">
              <li>
                <span className="font-medium text-slate-900">Pass</span> ≥ {passMark}
              </li>
              <li>
                <span className="font-medium text-slate-900">Fail</span> below {passMark}
              </li>
            </ul>
            <p className="text-xs text-slate-500">
              Nothing else changes a Result. Cases that pass only under this mark and would fail at{' '}
              {strictPassMark} are listed in the scorecard.
            </p>
          </div>
        </div>

        <p>
          The golden dataset — ideal response, expected and mandatory concepts, expected sources —
          is the source of truth. Responses are judged on substantive correctness, not wording.
        </p>

        <div className="space-y-2">
          <SectionLabel>Reported, not scored</SectionLabel>
          <p>
            A missing mandatory (must-have) concept is named on the case and lowers Completeness
            through coverage like any other expected concept; it does not by itself change the
            Result. A material factual issue the grader flagged on a regulated value is likewise
            named on the case, not scored.
          </p>
          <p className="text-xs text-slate-500">
            A case with no expected concepts has no data for Completeness and is Unable to Evaluate
            — never a guessed number.
          </p>
        </div>

        <p>
          {UTE_EXCLUSION_RULE}
          {uteCount != null && uteCount > 0
            ? ` This run has ${uteCount} such ${uteCount === 1 ? 'case' : 'cases'}.`
            : ''}
        </p>

        <p className="text-xs text-slate-500">
          Response times are reported alongside the grade but never blended into it.
        </p>
      </div>
    </details>
  );
}
