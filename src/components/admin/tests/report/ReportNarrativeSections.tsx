import { ChevronRight, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatConceptList } from '~/lib/tests/report/case-concepts';
import type { ReportConceptRollup, ReportMetricsData } from '~/lib/tests/report/data-schemas';
import {
  GRADE_BANDS,
  STATUS_BANDS,
  WEIGHTS,
} from '~/lib/tests/report/metrics';
import type { ReportSynthesis } from '~/lib/tests/report/schemas';
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
 * 2. **The stated scoring rule is the applied one.** The weighting, grade bands and result bands in
 *    the methodology are rendered from `WEIGHTS` / `GRADE_BANDS` / `STATUS_BANDS` — the same
 *    constants `computeReportMetrics`, `gradeFromScore` and `statusFromScore` use — so the
 *    methodology can never drift from the arithmetic it describes.
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
        Across the {concepts.casesWithConcepts}{' '}
        {concepts.casesWithConcepts === 1 ? 'case that carries' : 'cases that carry'} expected
        criteria. Percentages are out of the cases that specify concepts of that kind, not the
        whole run.
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
          missing a mandatory concept, of which{' '}
          <span className="font-medium tabular-nums">{concepts.gateBlockedPasses}</span> lost a Pass
          to the gate.
        </li>
        <li>
          <span className="font-medium tabular-nums">{concepts.autoPassed.length}</span> qualified
          for an automatic Pass on full expected coverage.
        </li>
        <li>
          <span className="font-medium text-amber-700 tabular-nums">
            {concepts.autoPassBlocked.length}
          </span>{' '}
          had an automatic Pass withheld over a material factual issue.
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

      {concepts.autoPassBlocked.length > 0 ? (
        <div className="mt-5">
          <SectionLabel>Automatic Passes withheld</SectionLabel>
          <ul className="mt-2 space-y-2">
            {concepts.autoPassBlocked.map((entry) => (
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
  /**
   * B0-713 — whether this run has any concept data. The concept rules are stated only when they
   * actually applied, so a legacy run's methodology reads exactly as it did before.
   */
  hasConcepts?: boolean;
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
  hasConcepts = false,
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
            Each response is judged on those four sub-scores; the weighted roll-up is the case&apos;s
            score.
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
            <SectionLabel>Result bands</SectionLabel>
            <ul className="space-y-1">
              {STATUS_BANDS.map((band, index) => (
                <li key={band.status}>
                  <span className="font-medium text-slate-900">{band.status}</span>{' '}
                  {bandRangeLabel(STATUS_BANDS, index)}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <p>
          The golden dataset — ideal response, expected concepts and expected sources — is the
          source of truth. Responses are judged on substantive correctness, not wording.
        </p>

        {hasConcepts ? (
          <div className="space-y-2">
            <SectionLabel>Concept rules</SectionLabel>
            <p>
              Where a case carries expected criteria, the grade above stays pure arithmetic and only
              the Result can move: satisfying every expected concept raises a below-Pass Result to
              Pass, and missing a mandatory (must-have) concept caps the Result below Pass.
            </p>
            <p className="text-xs text-slate-500">
              The cap is applied last, so it always wins over the automatic Pass, and the automatic
              Pass is withheld entirely when a deterministic check on a regulated value failed.
            </p>
          </div>
        ) : null}

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
