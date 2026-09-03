import type {
  ReportCase,
  ReportCaseStatus,
  ReportEvaluatedCase,
} from '~/lib/tests/report/data-schemas';
import { caseAnchorId } from '~/lib/tests/report/render';

/**
 * B0-587 — the pure joins behind the verdict strip's "cases needing attention" column.
 *
 * Kept out of the component (and free of JSX) so the ordering and the reason-picking rules are
 * unit-testable in this repo's `node`-environment Vitest setup, which has no Testing Library.
 *
 * Nothing here computes a score, a grade, a rate or a percentage: every such value is read off the
 * `ReportDataReady` payload exactly as `assembleReportData` produced it. The one-line reason is
 * likewise passed through verbatim — it carries dilution ratios, ppm, oz/gal, contact times and
 * EPA/DIN numbers, so it is never sliced, rounded or reformatted here. Truncation is CSS-only.
 */

/** Ordering key for the exception list; a `Pass` never appears in it. */
const STATUS_SEVERITY: Record<ReportCaseStatus, number> = {
  Fail: 0,
  Pass: 1,
};

export type ReportExceptionRow = {
  id: string;
  /** The ledger deep-link target — the case's own `anchorId` when present, else `caseAnchorId`. */
  anchorId: string;
  question: string;
  tier: string;
  category: string;
  /** The payload's weighted 0–100 roll-up. Rendered as-is. */
  overall: number;
  status: ReportCaseStatus;
  /** Verbatim grader narrative, or null when the case has none to show. */
  reason: string | null;
};

/**
 * The grader's narrative fields, most specific first: what the answer got *wrong*, then what it
 * *missed*, then the general explanation. Returns null rather than inventing a reason.
 */
export function exceptionReason(score: ReportCase['score'] | undefined): string | null {
  if (!score) return null;
  for (const candidate of [score.incorrect, score.missed, score.explanation]) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Every failing evaluated case, worst first: lower score before higher, and dataset order preserved
 * within a tie.
 */
export function buildExceptionRows(
  perCase: readonly ReportEvaluatedCase[],
  cases: readonly ReportCase[],
): ReportExceptionRow[] {
  const byId = new Map(cases.map((c) => [c.id, c]));

  return perCase
    .map((c, index) => [c, index] as const)
    .filter(([c]) => c.status !== 'Pass')
    .sort(
      (a, b) =>
        STATUS_SEVERITY[a[0].status] - STATUS_SEVERITY[b[0].status] ||
        a[0].overall - b[0].overall ||
        a[1] - b[1],
    )
    .map(([c]) => {
      const detail = byId.get(c.id);
      return {
        id: c.id,
        anchorId: detail?.anchorId ?? caseAnchorId(c.id),
        question: c.question,
        tier: c.tier,
        category: c.category,
        overall: c.overall,
        status: c.status,
        reason: exceptionReason(detail?.score),
      };
    });
}
