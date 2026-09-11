'use client';

import { Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { BexStreamdown } from '~/components/bex/BexStreamdown';
import {
  CaseTraceDownloadButton,
  CaseTraceViewButton,
} from '~/components/admin/tests/report/CaseTraceDownloadButton';
import {
  caseMarkers,
  conceptChecklist,
  formatConceptCoverage,
  formatConceptList,
  MANDATORY_CONCEPTS_LABEL,
  mandatoryMissingLegend,
  NO_MANDATORY_CONCEPTS_NOTE,
  REVIEW_MARKER_LEGEND,
} from '~/lib/tests/report/case-concepts';
import {
  CONCEPT_DISAGREEMENT_LABELS,
  VARIANCE_CAUSE_LABELS,
} from '~/lib/tests/report/consolidate';
import type {
  ReportCase,
  ReportCaseConcepts,
  ReportCaseStatus,
  ReportGroupRate,
  ReportMetricsData,
  ReportSpeedBand,
} from '~/lib/tests/report/data-schemas';
import { formatExpectedSourceRef } from '~/lib/tests/report/expected-sources';
import { hasExpectation } from '~/lib/tests/report/render';
import { SPEED_METRIC_LABELS } from '~/lib/tests/report/speed-rules';
import { cn } from '~/lib/utils';

/**
 * B0-590 — "Detailed results — case by case" as a compact ledger: one row per case, grouped by
 * tier, with the complete per-case record (everything `renderReportMarkdown`'s per-case section
 * emits) behind the row rather than ahead of it.
 *
 * Three rules this module holds to:
 *
 * 1. **Nothing is recomputed.** Tier group headers read `metrics.tiers[].block` — the `n`, `avg`
 *    and `grade` `computeReportMetrics` already produced. Nothing here averages `cases`.
 * 2. **Regulated values pass through verbatim.** Expected answers, agent responses, sub-scores,
 *    latencies and similarities carry dilution ratios, dwell/contact times, ppm, oz/gal, mL/L and
 *    EPA/DIN numbers. Every one of them is rendered exactly as stored — no `toFixed`, no rounding,
 *    no unit conversion, no slicing. Where a value must be visually constrained it is constrained
 *    with CSS (`truncate`, `whitespace-pre-wrap`) and never with string surgery. Note this is
 *    *stricter* than the Markdown, which prints harness similarity through `.toFixed(2)`; the
 *    ledger shows the stored precision instead.
 * 3. **Disclosures are real `<details>` elements.** Keyboard-operable for free, deep-linkable
 *    (`id={case.anchorId}` lives on the `<details>`), and force-openable for PDF export with a
 *    single `details > *:not(summary) { display: revert }` print rule — the body is always in the
 *    DOM, only hidden by the UA stylesheet.
 */

/** Query-string key the filter chips write. Linkable without any server-side `searchParams`. */
export const LEDGER_FILTER_PARAM = 'caseFilter';

export type LedgerFilter =
  | { kind: 'all' }
  | { kind: 'exceptions' }
  | { kind: 'tier'; tier: string };

const FILTER_ALL: LedgerFilter = { kind: 'all' };
const TIER_FILTER_PREFIX = 'tier:';

/** `?caseFilter=` → a filter. Unknown values (and unknown tiers) fall back to "all". */
export function parseLedgerFilter(
  raw: string | null | undefined,
  tierNames: readonly string[],
): LedgerFilter {
  if (!raw || raw === 'all') return FILTER_ALL;
  if (raw === 'exceptions') return { kind: 'exceptions' };
  if (raw.startsWith(TIER_FILTER_PREFIX)) {
    const tier = raw.slice(TIER_FILTER_PREFIX.length);
    return tierNames.includes(tier) ? { kind: 'tier', tier } : FILTER_ALL;
  }
  return FILTER_ALL;
}

/** The `?caseFilter=` value for a filter, or null when the param should be dropped entirely. */
export function serializeLedgerFilter(filter: LedgerFilter): string | null {
  if (filter.kind === 'all') return null;
  if (filter.kind === 'exceptions') return 'exceptions';
  return `${TIER_FILTER_PREFIX}${filter.tier}`;
}

export function ledgerFilterEquals(a: LedgerFilter, b: LedgerFilter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'tier' && b.kind === 'tier') return a.tier === b.tier;
  return true;
}

/**
 * A graded case that failed. Deliberately the same population the verdict strip's "cases needing
 * attention" column uses (B0-587 `buildExceptionRows`): evaluated, non-`Pass`. Unable-to-Evaluate
 * cases are *not* exceptions — they have no grade to fail.
 */
export function isExceptionCase(c: ReportCase): boolean {
  return c.evaluated != null && c.evaluated.status !== 'Pass';
}

/**
 * Which rows open on first paint. Exceptions per the ticket, plus Unable-to-Evaluate cases so
 * their `uteReason` is visible without a click — a UTE case is the one row whose whole story is
 * "why it could not be judged". Derived from the data during render, never from an effect.
 */
export function isDefaultOpenCase(c: ReportCase): boolean {
  return isExceptionCase(c) || c.unableToEvaluate;
}

/** The set of case ids open on first paint: the defaults, plus an incoming `#case-…` deep link. */
export function seedOpenCaseIds(
  cases: readonly ReportCase[],
  hashTarget: string | null,
): Set<string> {
  const open = new Set<string>();
  for (const c of cases) {
    if (isDefaultOpenCase(c) || (hashTarget && c.anchorId === hashTarget)) open.add(c.id);
  }
  return open;
}

export type BulkDisclosureAction = 'expand' | 'collapse';

/**
 * B0-706 — which action the bulk control offers. Two-state on purpose: while any visible row is
 * open it collapses, and only once they are all closed does it expand, so one click is always
 * predictable rather than depending on how many rows happen to be open.
 */
export function bulkDisclosureAction(
  openIds: ReadonlySet<string>,
  visibleIds: readonly string[],
): BulkDisclosureAction {
  return visibleIds.some((id) => openIds.has(id)) ? 'collapse' : 'expand';
}

/** `openIds` with every visible row opened or closed; rows the filter hides keep their state. */
export function applyBulkDisclosure(
  openIds: ReadonlySet<string>,
  visibleIds: readonly string[],
  action: BulkDisclosureAction,
): ReadonlySet<string> {
  const next = new Set(openIds);
  for (const id of visibleIds) {
    if (action === 'expand') next.add(id);
    else next.delete(id);
  }
  return next;
}

export function matchesLedgerFilter(c: ReportCase, filter: LedgerFilter): boolean {
  if (filter.kind === 'all') return true;
  if (filter.kind === 'exceptions') return isExceptionCase(c);
  return c.tier === filter.tier;
}

export type ReportTierGroup = {
  /** `Tier N`, or `Unspecified`. */
  tier: string;
  /** The raw priority shared by the group's cases; null for the "Unspecified" group. */
  priorityRaw: number | null;
  /** `metrics.tiers[].block` for this tier — read, never derived. Null if metrics has no row. */
  block: ReportGroupRate['block'] | null;
  cases: ReportCase[];
  /** Rows in this group excluded from `block.avg` because they could not be judged. */
  uteCount: number;
};

/**
 * Groups the already-ordered `cases` (Tier 1 → Tier N → "Unspecified") by tier, preserving both
 * the group order and the within-group order the payload arrived in. Each group is paired with
 * the metrics block of the same name; a tier with no metrics row (every case UTE) gets `null`.
 */
export function groupCasesByTier(
  cases: readonly ReportCase[],
  tiers: readonly ReportGroupRate[],
): ReportTierGroup[] {
  const blocks = new Map(tiers.map((t) => [t.name, t.block]));
  const groups: ReportTierGroup[] = [];
  const byTier = new Map<string, ReportTierGroup>();

  for (const c of cases) {
    let group = byTier.get(c.tier);
    if (!group) {
      group = {
        tier: c.tier,
        priorityRaw: c.priorityRaw,
        block: blocks.get(c.tier) ?? null,
        cases: [],
        uteCount: 0,
      };
      byTier.set(c.tier, group);
      groups.push(group);
    }
    group.cases.push(c);
    if (c.unableToEvaluate) group.uteCount += 1;
  }

  return groups;
}

export type LedgerChip = {
  key: string;
  label: string;
  /** How many ledger *rows* this chip shows — not a metric `n` (which counts graded cases only). */
  count: number;
  filter: LedgerFilter;
};

export function buildLedgerChips(
  cases: readonly ReportCase[],
  groups: readonly ReportTierGroup[],
): LedgerChip[] {
  return [
    { key: 'all', label: 'All', count: cases.length, filter: FILTER_ALL },
    {
      key: 'exceptions',
      label: 'Exceptions',
      count: cases.filter(isExceptionCase).length,
      filter: { kind: 'exceptions' },
    },
    ...groups.map((group) => ({
      key: `tier:${group.tier}`,
      label: group.tier,
      count: group.cases.length,
      filter: { kind: 'tier', tier: group.tier } as LedgerFilter,
    })),
  ];
}

const STATUS_BAR_CLASS: Record<ReportCaseStatus, string> = {
  Pass: 'bg-emerald-500',
  Fail: 'bg-rose-500',
};

const STATUS_BADGE_CLASS: Record<ReportCaseStatus, string> = {
  Pass: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  Fail: 'bg-rose-50 text-rose-700 ring-rose-200',
};

const SPEED_BAND_CLASS: Record<ReportSpeedBand, string> = {
  good: 'text-emerald-700',
  acceptable: 'text-amber-700',
  slow: 'text-rose-700',
};

/** The Markdown's `mdBlock` placeholder, so an empty narrative field reads the same in both. */
const NONE_NOTED = '(none noted)';

/**
 * Free text straight from the payload. `whitespace-pre-wrap` keeps stored line breaks, and
 * `break-words` constrains long strings visually rather than by slicing them.
 */
function Verbatim({ className, value }: { className?: string; value: string | null }) {
  const text = value?.trim() ?? '';
  if (!text) {
    return <p className="text-sm text-slate-400 italic">{NONE_NOTED}</p>;
  }
  return (
    <p className={cn('text-sm leading-relaxed break-words whitespace-pre-wrap text-slate-700', className)}>
      {text}
    </p>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
      {children}
    </p>
  );
}

function SubScore({
  label,
  value,
  aside,
}: {
  label: string;
  value: number;
  /** B0-835 — the judged value beside a capped one ("40 (judged 66)"); omitted otherwise. */
  aside?: string;
}) {
  return (
    <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
      <p className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      {/* Raw grader sub-score — printed exactly as stored, never rounded. */}
      <p className="mt-0.5 text-base font-semibold text-slate-900 tabular-nums">
        {value}
        {aside ? (
          <span className="ml-1 text-xs font-normal text-slate-500">{aside}</span>
        ) : null}
      </p>
    </div>
  );
}

function ScoreBar({ overall, status }: { overall: number; status: ReportCaseStatus }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200">
        <span
          className={cn('block h-full rounded-full', STATUS_BAR_CLASS[status])}
          style={{ width: `${Math.max(0, Math.min(100, overall))}%` }}
        />
      </span>
      <span className="text-xs font-semibold text-slate-700 tabular-nums">{overall}</span>
    </span>
  );
}

/**
 * The row's total-response-time readout. Deliberately *not* the Speed Performance Score: the
 * summary row already carries the content score, grade and Result, and putting a second 0–100
 * number beside them is exactly the confusion §7 exists to prevent. The full speed line lives in
 * the expanded record, below the sub-scores (B0-718).
 */
function LatencyReadout({ c, className }: { c: ReportCase; className?: string }) {
  const total = c.speed?.total ?? null;
  if (!total) {
    return <span className={cn('text-xs text-slate-400', className)}>—</span>;
  }
  return (
    <span className={cn('text-xs tabular-nums', SPEED_BAND_CLASS[total.band], className)}>
      {total.seconds} s ({total.band})
    </span>
  );
}

/** One metric on the expanded record's speed line: seconds, normalized score, band and raw ms. */
function SpeedMetricReadout({
  label,
  metric,
  sourceMs,
}: {
  label: string;
  metric: NonNullable<ReportCase['speed']>['total'];
  /** `latencyMs` / `ttftMs` — the stored millisecond value, shown beside the converted seconds. */
  sourceMs: number | null;
}) {
  if (!metric) return null;
  return (
    <>
      <span className="font-medium">{label}:</span>{' '}
      {/* Seconds and score both arrive rounded once at source — printed exactly as stored. */}
      <span className={cn('tabular-nums', SPEED_BAND_CLASS[metric.band])}>
        {metric.seconds} s
      </span>
      <span className="tabular-nums"> · {metric.score}/100</span> ({metric.band})
      {sourceMs != null ? <span className="text-slate-400"> · {sourceMs} ms</span> : null}
      {' · '}
    </>
  );
}

/**
 * B0-718 — the per-case speed line, placed below the sub-score grid and never inside it, and
 * labelled so it cannot be read as part of the content grade. Rating words are printed verbatim
 * from the payload; they are never mapped onto A–F.
 */
function CaseSpeedLine({ c }: { c: ReportCase }) {
  const speed = c.speed;
  if (!speed) {
    return (
      <p className="mt-3 text-xs text-slate-500">
        <span className="font-medium">Speed:</span>{' '}
        <span className="text-slate-400">no timing recorded for this case</span>
      </p>
    );
  }

  return (
    <p className="mt-3 rounded-xl bg-white px-3 py-2 text-xs leading-5 text-slate-600 ring-1 ring-slate-200">
      <span className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
        Speed — reported separately; not part of the content grade
      </span>
      <br />
      <SpeedMetricReadout
        label={SPEED_METRIC_LABELS.ttft}
        metric={speed.ttft}
        sourceMs={c.ttftMs}
      />
      <SpeedMetricReadout
        label={SPEED_METRIC_LABELS.total}
        metric={speed.total}
        sourceMs={c.latencyMs}
      />
      <span className="font-medium">Speed Performance Score:</span>{' '}
      <span className="tabular-nums">{speed.score}/100</span> ({speed.rating})
      {speed.basis !== 'combined' ? (
        <span className="text-slate-400">
          {' '}
          — scored from{' '}
          {speed.basis === 'ttft_only' ? SPEED_METRIC_LABELS.ttft : SPEED_METRIC_LABELS.total}{' '}
          alone; no{' '}
          {speed.basis === 'ttft_only' ? SPEED_METRIC_LABELS.total : SPEED_METRIC_LABELS.ttft} was
          recorded.
        </span>
      ) : null}
    </p>
  );
}

/**
 * B0-811 — the judged metrics, directly beneath the speed line and labelled the same way (§9):
 * similarity to the Ideal Response and the grader's confidence in the grade, with the grader's own
 * one-line notes. Reported beside the grade, never in it.
 */
function CaseJudgedLine({ c }: { c: ReportCase }) {
  const e = c.evaluated;
  if (!e || (e.similarity == null && e.evalConfidence == null)) return null;
  return (
    <p className="mt-3 rounded-xl bg-white px-3 py-2 text-xs leading-5 text-slate-600 ring-1 ring-slate-200">
      <span className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">
        Judged — reported separately; not part of the content grade
      </span>
      <br />
      {e.similarity != null ? (
        <>
          <span className="font-medium">Similarity to the Ideal Response:</span>{' '}
          <span className="tabular-nums">{e.similarity}</span>
          {e.similarityNote ? <span className="text-slate-500"> — {e.similarityNote}</span> : null}
        </>
      ) : null}
      {e.similarity != null && e.evalConfidence != null ? ' · ' : null}
      {e.evalConfidence != null ? (
        <>
          <span className="font-medium">Evaluator confidence:</span>{' '}
          <span className="tabular-nums">{e.evalConfidence}/100</span>
          {e.confidenceNote ? <span className="text-slate-500"> — {e.confidenceNote}</span> : null}
        </>
      ) : null}
    </p>
  );
}

/**
 * The harness's own verdict. Kept visually subordinate — smaller, muted, set off behind a rule —
 * because it is a different judgement from the LLM grade and must never read as its equal.
 */
function HarnessAside({ harness }: { harness: NonNullable<ReportCase['harness']> }) {
  const bits = [
    harness.passed != null ? `harness result: ${harness.passed ? 'passed' : 'failed'}` : null,
    harness.status ? `status ${harness.status}` : null,
    // Source precision on purpose: the Markdown rounds this to 2 dp, the ledger must not.
    harness.similarity != null ? `similarity ${harness.similarity}` : null,
  ].filter(Boolean);

  if (bits.length === 0) return null;

  return (
    <p className="border-l border-slate-200 pl-3 text-[11px] text-slate-400">
      <span className="font-medium">Harness signal</span> · {bits.join(' · ')}
    </p>
  );
}

/**
 * B0-933 — the expectation block. `expectedShouldAnswer` is gone; the run-time pass/fail axis is
 * mandatory concept coverage (B0-932). Document titles are rendered verbatim — dilution ratios,
 * contact times and EPA registration numbers survive intact.
 *
 * The expected/must-have concept phrases are NOT repeated here: the Concept coverage card above
 * prints the same golden lists as a per-concept checklist with met/missed state, which strictly
 * dominates the comma-separated quoted strings this block used to carry. They are still printed
 * here when a case has no concept grading at all (no coverage card), so the phrases are never
 * silently dropped.
 */
function ExpectedColumn({ c }: { c: ReportCase }) {
  // Same truthiness test the Markdown's `formatExpected` uses, so both agree on "nothing recorded".
  const hasAny = hasExpectation(c);
  // Mirrors `ConceptCoverageCard`'s own guard — when it renders nothing, this block is the only
  // place the golden phrases would appear.
  const coverageCardShown = c.concepts != null;
  // With the concept lists moved to the coverage card, a case whose only expectation *was* those
  // concepts would otherwise render an empty panel — say where they went instead.
  const conceptsOnly =
    hasAny && coverageCardShown && !c.idealResponse && c.expectedSources.length === 0;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <FieldLabel>Expected answer / behavior</FieldLabel>
      {conceptsOnly ? (
        <p className="mt-2 text-sm text-slate-400 italic">
          (expectation is the concept lists — see Concept coverage above)
        </p>
      ) : hasAny ? (
        <div className="mt-2 flex flex-col gap-3">
          {c.idealResponse ? <Verbatim value={c.idealResponse} /> : null}
          {!coverageCardShown && c.expectedConcepts.length > 0 ? (
            <div>
              <FieldLabel>Expected concepts</FieldLabel>
              <Verbatim className="mt-1" value={formatConceptList(c.expectedConcepts)} />
            </div>
          ) : null}
          {!coverageCardShown ? (
            <div>
              <FieldLabel>{MANDATORY_CONCEPTS_LABEL}</FieldLabel>
              {c.minimumConcepts.length > 0 ? (
                <Verbatim className="mt-1" value={formatConceptList(c.minimumConcepts)} />
              ) : (
                <p className="mt-1 text-sm text-slate-400 italic">{NO_MANDATORY_CONCEPTS_NOTE}</p>
              )}
            </div>
          ) : null}
          {c.expectedSources.length > 0 ? (
            <div>
              <FieldLabel>Expected sources</FieldLabel>
              <ul className="mt-1 flex flex-col gap-0.5">
                {c.expectedSources.map((source) => (
                  <li
                    key={source.id}
                    className={cn(
                      'text-sm leading-relaxed break-words',
                      source.resolved ? 'text-slate-700' : 'text-amber-700',
                    )}
                    title={source.id}
                  >
                    {formatExpectedSourceRef(source)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-400 italic">(no expected answer recorded)</p>
      )}
    </div>
  );
}

function ActualColumn({ c }: { c: ReportCase }) {
  const trimmedResponse = c.actual?.trim() ?? '';

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <FieldLabel>Agent&apos;s actual response</FieldLabel>
      {c.responseRecorded ? (
        trimmedResponse ? (
          <BexStreamdown content={trimmedResponse} isStreaming={false} isUser={false} />
        ) : (
          <p className="text-sm text-slate-400 italic">{NONE_NOTED}</p>
        )
      ) : (
        // `actual` still carries the payload's own placeholder — shown as-is, flagged as absent.
        <p className="mt-2 text-sm text-slate-400 italic">{c.actual}</p>
      )}

      <div className="mt-4 border-t border-slate-100 pt-3">
        <FieldLabel>Retrieved documents</FieldLabel>
        {c.retrievedDocumentIds.length > 0 ? (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {c.retrievedDocumentIds.map((documentId) => (
              <li
                className="rounded-lg bg-slate-100 px-2 py-0.5 font-mono text-[11px] break-all text-slate-600"
                key={documentId}
              >
                {documentId}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-slate-400 italic">(none recorded)</p>
        )}
        <p className="mt-2 text-[11px] text-slate-400">
          Documents retrieved while answering — not a citation list.
          {c.workflowRunId ? (
            <>
              {' '}
              Workflow run <span className="font-mono break-all">{c.workflowRunId}</span>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}

/**
 * The per-case concept lines (B0-813 / B0-835): where the Completeness came from, the coverage
 * readout, what each concept rule did to this case, and what is missing by name. Methodology §9
 * caps the per-case detail here — the full audit lives in the run-level rollup, not in every row.
 *
 * `conceptNote` is the skill's own one-sentence explanation. The floor, automatic-Pass and
 * withheld-Pass lines below state it word for word for those three outcomes, so it is printed only
 * where it is not already a duplicate — the same rule `renderReportMarkdown` follows.
 *
 * Concept phrases are regulated free text and are rendered exactly as stored.
 */
/**
 * The concept checklist: every required phrase, in authored order, ticked or crossed.
 *
 * Regulated-data rule: a phrase is rendered verbatim and never truncated — long phrases wrap.
 * The icon is decorative; each row carries a text label for screen readers, so the verdict is
 * never conveyed by colour alone.
 */
function ConceptChecklist({
  title,
  coverage,
  emphasis,
}: {
  title: string;
  coverage: ReportCaseConcepts['mandatory'];
  emphasis: 'mandatory' | 'expected';
}) {
  const entries = conceptChecklist(coverage);
  if (entries.length === 0) return null;
  const satisfied = entries.filter((entry) => entry.met).length;

  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-slate-700">
        {title}{' '}
        <span className="font-normal text-slate-500 tabular-nums">
          {satisfied}/{entries.length}
        </span>
      </p>
      <ul className="mt-1.5 space-y-1">
        {entries.map((entry, index) => (
          <li
            className="flex items-start gap-2 text-sm break-words whitespace-pre-wrap"
            key={`${emphasis}-${index}`}
          >
            {entry.met ? (
              <Check
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-emerald-600"
                strokeWidth={2.5}
              />
            ) : (
              <X
                aria-hidden
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  emphasis === 'mandatory' ? 'text-rose-600' : 'text-amber-600',
                )}
                strokeWidth={2.5}
              />
            )}
            <span className="sr-only">{entry.met ? 'Communicated:' : 'Missed:'}</span>
            <span
              className={cn(
                entry.met
                  ? 'text-slate-700'
                  : emphasis === 'mandatory'
                    ? 'font-medium text-rose-800'
                    : 'text-amber-800',
              )}
            >
              {entry.phrase}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConceptCoverageCard({ c }: { c: ReportCase }) {
  const concepts = c.concepts;
  if (!concepts) return null;
  const evaluated = c.evaluated;
  const noteIsDuplicate =
    evaluated != null &&
    (evaluated.floorApplied ||
      evaluated.statusSource === 'auto_pass' ||
      evaluated.autoPassBlocked);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <FieldLabel>Concept coverage</FieldLabel>
      <p className="mt-2 text-sm font-semibold text-slate-900 tabular-nums">
        {formatConceptCoverage(concepts)}
      </p>
      {evaluated ? (
        <p className="mt-1 text-xs text-slate-600 tabular-nums">
          {evaluated.coverageApplied ? (
            <>
              Completeness judged {evaluated.completenessJudged}, capped at coverage{' '}
              {evaluated.completeness}
            </>
          ) : (
            <>Completeness {evaluated.completeness}</>
          )}{' '}
          — {evaluated.coverage.satisfied} of {evaluated.coverage.required} expected concept
          {evaluated.coverage.required === 1 ? '' : 's'} communicated.
          {!evaluated.coverageApplied && evaluated.completenessJudged === null
            ? ' (no judged value on this pass; coverage used)'
            : ''}
        </p>
      ) : null}

      {/* B0-835 — the diagnostic that keeps a near miss distinguishable from a total one. */}
      {evaluated?.ceilingApplied ? (
        <p className="mt-2 text-xs text-slate-600 tabular-nums">
          <span className="font-medium">Pre-Gate Content Score:</span> {evaluated.preGateScore}/100
          ({evaluated.preGateGrade}) — the rubric arithmetic before the mandatory cap; diagnostic
          only.
        </p>
      ) : null}
      {evaluated?.floorApplied ? (
        <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200 ring-inset">
          <span className="font-medium">Mandatory floor:</span> raised from {evaluated.weighted} to{' '}
          {evaluated.floor} — every mandatory concept satisfied. NOTE: the sub-scores placed this
          below a C despite full mandatory coverage — re-check.
        </p>
      ) : null}
      {evaluated?.statusSource === 'auto_pass' ? (
        <p className="mt-2 text-xs text-emerald-700">
          <span className="font-medium">Automatic Pass:</span> all expected concepts communicated,
          no material issue.
        </p>
      ) : null}
      {evaluated?.autoPassBlocked ? (
        <p className="mt-2 text-xs break-words whitespace-pre-wrap text-amber-800">
          <span className="font-medium">Automatic Pass withheld:</span>{' '}
          {concepts.materialIssueNote ?? 'a material factual issue was recorded on this case.'}
        </p>
      ) : null}

      {/*
        B0-938 — the per-concept checklist replaces the former "Missing mandatory / Missing
        expected" prose lines. Those named only what was missed; this shows the whole golden list
        so a reader can see what was asked for as well as what was delivered.
      */}
      <ConceptChecklist
        coverage={concepts.mandatory}
        emphasis="mandatory"
        title="Must-have concepts"
      />
      <ConceptChecklist
        coverage={concepts.expected}
        emphasis="expected"
        title="Expected concepts"
      />

      {concepts.materialIssue ? (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm break-words whitespace-pre-wrap text-amber-900 ring-1 ring-amber-200 ring-inset">
          Material factual issue:{' '}
          {concepts.materialIssueNote ?? 'a material factual issue was recorded on this case.'}
        </p>
      ) : null}

      {evaluated?.conceptNote && !noteIsDuplicate ? (
        <p className="mt-3 text-xs break-words whitespace-pre-wrap text-slate-600">
          <span className="font-medium">Concept rules:</span> {evaluated.conceptNote}
        </p>
      ) : null}
    </div>
  );
}

/**
 * B0-721 — the per-pass spread behind this case's review flag. Detailed ledger only: the row badge
 * carries the mark, this carries the evidence a reviewer needs to settle the grade.
 *
 * Nothing here is recomputed — every number is read off `case.variance`, which
 * `consolidateCasePasses` produced once.
 */
function GradingConsistencyCard({ c }: { c: ReportCase }) {
  const variance = c.variance;
  if (!variance) return null;

  return (
    <div
      className={cn(
        'rounded-2xl border p-4',
        variance.flagged ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white',
      )}
    >
      <FieldLabel>Grading consistency</FieldLabel>
      <p className="mt-2 text-sm text-slate-900 tabular-nums">
        {variance.passes} independent passes · overalls{' '}
        {variance.passOveralls
          .map((overall) => (overall == null ? 'n/a' : String(overall)))
          .join(' / ')}
        {variance.range == null ? '' : ` · range ${variance.range}`}
        {/* B0-835 — a floor that bound on a pass is a review signal in its own right: that pass's
            sub-scores and its concept verdicts disagree. */}
        {variance.floorApplied.length > 0
          ? ` · the mandatory floor raised the score of ${variance.floorApplied
              .map((entry) => `pass ${entry.pass} (${entry.weighted} → ${entry.floor})`)
              .join(', ')}`
          : ''}
      </p>
      {variance.flagged ? (
        <ul className="mt-2 space-y-1 text-sm text-amber-900">
          {variance.causes.map((cause) => (
            <li className="break-words whitespace-pre-wrap" key={cause}>
              {cause === 'concept' && variance.conceptDisagreements.length > 0
                ? `${VARIANCE_CAUSE_LABELS.concept}: ${variance.conceptDisagreements
                    .map((d) => {
                      const label = CONCEPT_DISAGREEMENT_LABELS[d.kind];
                      // Concept phrases are regulated free text — quoted verbatim.
                      const subject = d.concept ? `${label} ${formatConceptList([d.concept])}` : label;
                      return `${subject} (${d.votesFor} of ${d.voters} passes)`;
                    })
                    .join('; ')}`
                : VARIANCE_CAUSE_LABELS[cause]}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-slate-600">
          The passes agreed — no human review needed on consistency grounds.
        </p>
      )}
      {variance.timingWarnings.length > 0 ? (
        <p className="mt-2 text-xs text-slate-600">
          <span className="font-medium">Data quality (not a grading flag):</span>{' '}
          {variance.timingWarnings.join(' ')}
        </p>
      ) : null}
    </div>
  );
}

function NarrativeCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <FieldLabel>{label}</FieldLabel>
      <Verbatim className="mt-2" value={value} />
    </div>
  );
}

function CaseRow({
  c,
  open,
  onToggle,
  canDownloadTrace,
}: {
  c: ReportCase;
  open: boolean;
  onToggle: (caseId: string, open: boolean) => void;
  canDownloadTrace: boolean;
}) {
  const evaluated = c.evaluated;

  return (
    <details
      className="group border-b border-slate-100 last:border-b-0"
      // B0-592 — marks one case record as an unbreakable block for the PDF export.
      data-report-case
      id={c.anchorId}
      onToggle={(event) => onToggle(c.id, event.currentTarget.open)}
      open={open}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-90" />
        {/* The UUID's first segment — the same short form the synthesis cites. Full id below. */}
        <code className="w-[4.75rem] shrink-0 font-mono text-[11px] text-slate-500" title={c.id}>
          {c.id.slice(0, 8)}
        </code>
        <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{c.question}</span>
        <span className="hidden w-28 shrink-0 sm:block">
          {evaluated ? (
            <ScoreBar overall={evaluated.overall} status={evaluated.status} />
          ) : (
            <span className="text-xs text-slate-400">not scored</span>
          )}
        </span>
        <LatencyReadout c={c} className="hidden w-24 shrink-0 text-right sm:block" />
        <span className="shrink-0">
          {evaluated ? (
            <span
              className={cn(
                'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
                STATUS_BADGE_CLASS[evaluated.status],
              )}
            >
              {evaluated.status}
              {/* B0-835 — † missing a must-have concept, so the score shown is a capped one.
                  B0-721 adds ⚑ flagged for human review, alongside it rather than instead of it;
                  the legend above the groups is written from the rules actually in force. */}
              {caseMarkers({
                mandatoryMissing: evaluated.mandatoryMissing,
                reviewFlagged: c.variance?.flagged ?? false,
              })}{' '}
              · {evaluated.grade}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200 ring-inset">
              {/* An Unable-to-Evaluate case can still be flagged: the passes may have disagreed
                  about whether it could be judged at all. */}
              Unable to Evaluate
              {caseMarkers({
                mandatoryMissing: false,
                reviewFlagged: c.variance?.flagged ?? false,
              })}
            </span>
          )}
        </span>
        {canDownloadTrace ? (
          <div className="flex gap-1">
            <CaseTraceViewButton workflowRunId={c.workflowRunId} />
            <CaseTraceDownloadButton caseId={c.id} workflowRunId={c.workflowRunId} />
          </div>
        ) : null}
      </summary>

      <div className="flex flex-col gap-4 px-3 pt-1 pb-6">
        {/* --- Header band --- */}
        <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
          <p className="font-mono text-xs break-all text-slate-500">{c.id}</p>
          <p className="mt-1 text-xs text-slate-600">
            {c.tier}
            {c.priorityRaw != null ? ` (priority ${c.priorityRaw})` : ''} · {c.category}
          </p>

          {evaluated ? (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <SubScore label="Accuracy" value={evaluated.accuracy} />
              <SubScore
                aside={
                  evaluated.coverageApplied
                    ? `(judged ${evaluated.completenessJudged})`
                    : undefined
                }
                label="Completeness"
                value={evaluated.completeness}
              />
              <SubScore label="Relevance" value={evaluated.relevance} />
              <SubScore label="Clarity" value={evaluated.clarity} />
            </div>
          ) : (
            <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-sm font-medium text-slate-700">
                Unable to Evaluate — excluded from all scores, grades, counts and rates
                {c.tier ? `, including the ${c.tier} average` : ''}.
              </p>
              <p className="mt-1 text-sm text-slate-600">
                <span className="font-medium">Reason:</span> {c.score.uteReason ?? 'unspecified'}
              </p>
            </div>
          )}

          {evaluated ? (
            <p className="mt-3 text-xs text-slate-600">
              <span className="font-medium">Overall</span>{' '}
              <span className="tabular-nums">{evaluated.overall}</span>/100 ·{' '}
              <span className="font-medium">Grade</span> {evaluated.grade} ·{' '}
              <span className="font-medium">Result</span> {evaluated.status}
            </p>
          ) : null}

          {/* Below the score grid, never inside it. */}
          <CaseSpeedLine c={c} />
          <CaseJudgedLine c={c} />

          {c.harness ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <HarnessAside harness={c.harness} />
            </div>
          ) : null}
        </div>

        {/* --- Concept coverage (only when this case has concept data) --- */}
        <ConceptCoverageCard c={c} />

        {/* --- Grading consistency (only when this case was graded more than once) --- */}
        <GradingConsistencyCard c={c} />

        {/* --- Expected vs actual --- */}
        <div className="grid gap-4 lg:grid-cols-2">
          <ExpectedColumn c={c} />
          <ActualColumn c={c} />
        </div>

        {/* --- The grade, in the grader's words --- */}
        <NarrativeCard label="Explanation of the grade" value={c.score.explanation} />
        <div className="grid gap-4 lg:grid-cols-3">
          <NarrativeCard label="Important information missed" value={c.score.missed} />
          <NarrativeCard
            label="Incorrect, misleading, or unsupported information"
            value={c.score.incorrect}
          />
          <NarrativeCard label="Recommended improvement" value={c.score.improvement} />
        </div>
      </div>
    </details>
  );
}

function TierGroupHeader({ group }: { group: ReportTierGroup }) {
  const block = group.block;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-2xl bg-slate-100/70 px-3 py-2">
      <h3 className="text-sm font-semibold text-slate-900">{group.tier}</h3>
      <p className="text-xs text-slate-600">
        {group.priorityRaw != null ? `priority ${group.priorityRaw}` : 'no priority'}
        {/* Straight from `metrics.tiers[].block` — never averaged from the rows below. */}
        {block ? (
          <>
            {' · '}n={block.n}
            {' · '}avg {block.avg ?? '—'}
            {' · '}grade {block.grade}
          </>
        ) : null}
      </p>
      {group.uteCount > 0 ? (
        <p className="text-xs text-slate-500 italic">
          {group.uteCount} unable to evaluate — excluded from this average
        </p>
      ) : null}
    </div>
  );
}

/**
 * `metrics`, narrowed to the slices the ledger reads. Passing the whole object satisfies it.
 * `scoringRules` (B0-835) is what the † legend is written from, so a report scored with the gate or
 * the ceiling off never claims a cap that did not happen.
 */
export type ReportCaseLedgerMetrics = Pick<ReportMetricsData, 'tiers' | 'scoringRules'>;

export type ReportCaseLedgerProps = {
  /** `ReportDataReady.cases`, already ordered Tier 1 → Tier N → "Unspecified". Not re-sorted. */
  cases: readonly ReportCase[];
  metrics: ReportCaseLedgerMetrics;
  /**
   * B0-707 — whether to offer the per-row trace download. Resolved on the server from
   * `navigation.sidebar.observability`, the permission the export route itself enforces, so a user
   * who would only get a 403 is never shown the button.
   */
  canDownloadTrace: boolean;
  className?: string;
};

function readLocationHash(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function ReportCaseLedgerContent({
  cases,
  metrics,
  canDownloadTrace,
  className,
}: ReportCaseLedgerProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const groups = useMemo(() => groupCasesByTier(cases, metrics.tiers), [cases, metrics.tiers]);
  const chips = useMemo(() => buildLedgerChips(cases, groups), [cases, groups]);
  const tierNames = useMemo(() => groups.map((g) => g.tier), [groups]);
  const filter = parseLedgerFilter(searchParams.get(LEDGER_FILTER_PARAM), tierNames);

  const [hashTarget, setHashTarget] = useState<string | null>(readLocationHash);
  // Seeded during the first render from the data itself — exceptions (and UTE cases) are open on
  // first paint with no effect, no second fetch and no post-paint state flip.
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() =>
    seedOpenCaseIds(cases, readLocationHash()),
  );

  const handleToggle = useCallback((caseId: string, open: boolean) => {
    setOpenIds((prev) => {
      if (prev.has(caseId) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(caseId);
      else next.delete(caseId);
      return next;
    });
  }, []);

  // Later `#case-…` navigations (evidence chips elsewhere on the page) open and reveal their row.
  useEffect(() => {
    const applyHash = () => {
      const target = readLocationHash();
      setHashTarget(target);
      if (!target) return;
      const match = cases.find((c) => c.anchorId === target);
      if (!match) return;
      setOpenIds((prev) => (prev.has(match.id) ? prev : new Set(prev).add(match.id)));
      window.requestAnimationFrame(() => {
        document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    };

    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, [cases]);

  const selectFilter = useCallback(
    (next: LedgerFilter) => {
      const params = new URLSearchParams(searchParams.toString());
      const value = serializeLedgerFilter(next);
      if (value) params.set(LEDGER_FILTER_PARAM, value);
      else params.delete(LEDGER_FILTER_PARAM);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // A deep-linked row stays visible even when the active filter would otherwise hide it, so an
  // anchor from an evidence chip always lands on its target.
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      cases: group.cases.filter(
        (c) => matchesLedgerFilter(c, filter) || (hashTarget != null && c.anchorId === hashTarget),
      ),
    }))
    .filter((group) => group.cases.length > 0);

  // The bulk control acts on what is on screen under the active filter, never the whole payload.
  const visibleCaseIds = visibleGroups.flatMap((group) => group.cases.map((c) => c.id));

  // B0-713 — only legend the marks actually on screen, so a filtered view never carries an
  // orphan footnote and a run with no concept data shows no legend at all.
  const visibleEvaluated = visibleGroups.flatMap((group) =>
    group.cases.map((c) => c.evaluated).filter((e) => e != null),
  );
  // B0-721 — the review mark is legended on the same terms: only when it is actually on screen,
  // and read off every visible case (an Unable-to-Evaluate one can carry it too).
  const visibleCases = visibleGroups.flatMap((group) => group.cases);
  const legendLines = [
    visibleEvaluated.some((e) => e.mandatoryMissing)
      ? mandatoryMissingLegend(metrics.scoringRules)
      : null,
    visibleCases.some((c) => c.variance?.flagged) ? REVIEW_MARKER_LEGEND : null,
  ].filter((line) => line != null);
  const bulkAction = bulkDisclosureAction(openIds, visibleCaseIds);
  const toggleAllVisible = () =>
    setOpenIds((prev) => applyBulkDisclosure(prev, visibleCaseIds, bulkAction));

  return (
    <section
      className={cn(
        'rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8',
        className,
      )}
    >
      <h2 className="text-lg font-semibold tracking-tight text-slate-950">
        Detailed results — case by case
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        One row per case; open a row for the full record. Response time and harness signal are
        reported for reference only and are not part of the grade.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {chips.map((chip) => {
          const active = ledgerFilterEquals(chip.filter, filter);
          return (
            <button
              aria-pressed={active}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                active
                  ? 'border-sky-600 bg-sky-600 text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50',
              )}
              key={chip.key}
              onClick={() => selectFilter(chip.filter)}
              type="button"
            >
              {chip.label}
              <span className={cn('tabular-nums', active ? 'text-sky-100' : 'text-slate-400')}>
                {chip.count}
              </span>
            </button>
          );
        })}

        {visibleCaseIds.length > 0 ? (
          <button
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 print:hidden"
            onClick={toggleAllVisible}
            title={
              bulkAction === 'collapse'
                ? 'Close every case record shown below'
                : 'Open every case record shown below'
            }
            type="button"
          >
            {bulkAction === 'collapse' ? (
              <ChevronsDownUp className="size-3.5 text-slate-400" />
            ) : (
              <ChevronsUpDown className="size-3.5 text-slate-400" />
            )}
            {bulkAction === 'collapse' ? 'Collapse all' : 'Expand all'}
          </button>
        ) : null}
      </div>

      {legendLines.length > 0 ? (
        <p className="mt-3 text-xs text-slate-500">{legendLines.join('  ')}</p>
      ) : null}

      {visibleGroups.length === 0 ? (
        <p className="mt-6 text-sm text-slate-500">No cases match this filter.</p>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {visibleGroups.map((group) => (
            <div key={group.tier}>
              <TierGroupHeader group={group} />
              <div className="mt-2 overflow-hidden rounded-2xl border border-slate-200">
                {group.cases.map((c) => (
                  <CaseRow
                    c={c}
                    canDownloadTrace={canDownloadTrace}
                    key={c.id}
                    onToggle={handleToggle}
                    open={openIds.has(c.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * `useSearchParams()` needs a Suspense boundary above it under static rendering; owning one here
 * keeps the ledger safe to drop anywhere in `RunReportView` without the caller having to know.
 */
export function ReportCaseLedger(props: ReportCaseLedgerProps) {
  return (
    <Suspense fallback={null}>
      <ReportCaseLedgerContent {...props} />
    </Suspense>
  );
}
