import type { ConceptKindCoverage } from './case-concepts';
import type { EvaluatedCase, RateBlock } from './metrics';

/**
 * B0-714 — the report's reconciliation checks (methodology §11), split by severity.
 *
 * The manual skill's `compute_metrics.py` exits non-zero and refuses to build the document when a
 * check fails. Ours used to push a string onto `metrics.warnings` and render anyway, which makes a
 * structurally impossible report — a case rated Pass while missing a must-have concept, a rate
 * table whose counts do not add up — look like a finished report with a note attached.
 *
 * The severity split agreed on B0-714 (Tom Bird, 2026-08-27):
 *
 * - **Structural invariants (this module) hard-fail generation.** They describe facts that cannot
 *   be true of a correctly computed report, so there is no version of the document worth shipping.
 *   `assertReportInvariants` throws a `ReportInvariantError`; the orchestrator's existing catch
 *   persists `status: 'failed'` with the message in `state.error` and never reaches
 *   `saveReportMarkdown`, so the report can never be written as `completed`.
 * - **Data-quality notes stay advisory** on `metrics.warnings` and still render: a missing
 *   sub-score coerced to 0, absent concepts, implausible timing. We deliberately diverge from the
 *   Python script on the null sub-score in particular — one flaky grading call should degrade a
 *   report, not destroy it.
 *
 * The checks are a list, not a run of inline `if`s, so adding one (B0-717 adds a ninth) is a
 * single entry rather than an edit to control flow.
 */

/**
 * Stable marker on `report_state.error`. The report UI branches on this to tell "the numbers did
 * not reconcile" apart from "OpenAI/the network failed" — two failures with completely different
 * remedies (fix the data / press Retry).
 */
export const INVARIANT_ERROR_PREFIX = 'INVARIANT:';

/** Thrown by `assertReportInvariants`. Named so a `catch` can identify it after serialization. */
export class ReportInvariantError extends Error {
  /** The failing check's `name`, e.g. `mandatory_concept_missing_not_passed`. */
  readonly check: string;

  constructor(check: string, detail: string) {
    super(`${INVARIANT_ERROR_PREFIX} ${check} — ${detail}`);
    this.name = 'ReportInvariantError';
    this.check = check;
  }
}

/** True for a `state.error` string produced by a failed structural invariant. */
export function isInvariantErrorMessage(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.startsWith(INVARIANT_ERROR_PREFIX);
}

/** Everything the structural checks read. Deliberately the computed values, not the raw inputs. */
export type ReportInvariantContext = {
  totalCases: number;
  uteCount: number;
  evaluated: readonly EvaluatedCase[];
  overall: RateBlock;
  tiers: ReadonlyArray<[string, RateBlock]>;
  categories: ReadonlyArray<[string, RateBlock]>;
};

/**
 * One named structural check. `failed` returns the human-readable detail of the violation, or
 * null when the check holds.
 */
export type ReportInvariant = {
  name: string;
  /** What the check guarantees, in one line — printed nowhere, read by whoever edits this list. */
  describes: string;
  failed: (ctx: ReportInvariantContext) => string | null;
};

/** Order-insensitive multiset equality; concept phrases may legitimately repeat. */
function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function coverageMismatch(
  kind: string,
  coverage: ConceptKindCoverage,
): string | null {
  return sameMultiset([...coverage.satisfied, ...coverage.missing], coverage.required)
    ? null
    : `${kind}: required ${coverage.required.length}, satisfied ${coverage.satisfied.length} + missing ${coverage.missing.length}`;
}

export const REPORT_INVARIANTS: readonly ReportInvariant[] = [
  {
    name: 'status_counts_sum_to_evaluated',
    describes: 'pass + partial + fail equals the evaluated case count',
    failed: (ctx) => {
      const sum = ctx.overall.pass + ctx.overall.partial + ctx.overall.fail;
      return sum === ctx.evaluated.length
        ? null
        : `pass+partial+fail = ${sum}, evaluated = ${ctx.evaluated.length}`;
    },
  },
  {
    name: 'evaluated_equals_total_minus_ute',
    describes: 'every case is either evaluated or Unable to Evaluate, never both or neither',
    failed: (ctx) =>
      ctx.evaluated.length === ctx.totalCases - ctx.uteCount
        ? null
        : `evaluated = ${ctx.evaluated.length}, total - UTE = ${ctx.totalCases - ctx.uteCount}`,
  },
  {
    name: 'tier_counts_sum_to_evaluated',
    describes: 'the tier breakdown partitions the evaluated cases exactly',
    failed: (ctx) => {
      const sum = ctx.tiers.reduce((total, [, block]) => total + block.n, 0);
      return sum === ctx.evaluated.length
        ? null
        : `tier counts = ${sum}, evaluated = ${ctx.evaluated.length}`;
    },
  },
  {
    name: 'category_counts_sum_to_evaluated',
    describes: 'the category breakdown partitions the evaluated cases exactly',
    failed: (ctx) => {
      const sum = ctx.categories.reduce((total, [, block]) => total + block.n, 0);
      return sum === ctx.evaluated.length
        ? null
        : `category counts = ${sum}, evaluated = ${ctx.evaluated.length}`;
    },
  },
  {
    name: 'mandatory_concept_missing_not_passed',
    describes: 'no case missing a must-have concept is reported as a Pass',
    failed: (ctx) => {
      const offenders = ctx.evaluated.filter(
        (c) => (c.concepts?.mandatory.missing.length ?? 0) > 0 && c.status === 'Pass',
      );
      return offenders.length === 0
        ? null
        : `rated Pass while missing a mandatory concept: ${offenders.map((c) => c.id).join(', ')}`;
    },
  },
  {
    name: 'auto_pass_is_rated_pass',
    describes: 'a case the automatic-Pass rule fired on ends up rated Pass',
    failed: (ctx) => {
      // Cannot legitimately fail: mandatory ⊆ expected, so full expected coverage means nothing
      // is left for the gate to cap. A hit here means the two concept sets disagree — corrupt
      // input, not a rule conflict.
      const offenders = ctx.evaluated.filter((c) => c.autoPassTriggered && c.status !== 'Pass');
      return offenders.length === 0
        ? null
        : `automatic Pass triggered but not rated Pass: ${offenders
            .map((c) => `${c.id} (${c.status})`)
            .join(', ')}`;
    },
  },
  {
    name: 'blocked_auto_pass_not_auto_passed',
    describes: 'an automatic Pass withheld over a material issue was not granted anyway',
    failed: (ctx) => {
      const offenders = ctx.evaluated.filter(
        (c) => c.autoPassBlocked && (c.autoPassTriggered || c.statusSource === 'auto_pass'),
      );
      return offenders.length === 0
        ? null
        : `automatic Pass both blocked and granted: ${offenders.map((c) => c.id).join(', ')}`;
    },
  },
  {
    name: 'concept_coverage_partitions_required',
    describes: "each case's satisfied + missing concepts equal its required concepts, per kind",
    failed: (ctx) => {
      const offenders: string[] = [];
      for (const c of ctx.evaluated) {
        if (!c.concepts) continue;
        const mismatches = [
          coverageMismatch('mandatory', c.concepts.mandatory),
          coverageMismatch('expected', c.concepts.expected),
        ].filter((m): m is string => m !== null);
        if (mismatches.length > 0) offenders.push(`${c.id} — ${mismatches.join('; ')}`);
      }
      return offenders.length === 0 ? null : offenders.join(' | ');
    },
  },
];

/**
 * Runs every structural invariant and throws on the first violation. Called at the end of
 * `computeReportMetrics`, so no caller can build a document from metrics that do not reconcile.
 */
export function assertReportInvariants(ctx: ReportInvariantContext): void {
  for (const invariant of REPORT_INVARIANTS) {
    const detail = invariant.failed(ctx);
    if (detail !== null) {
      throw new ReportInvariantError(invariant.name, detail);
    }
  }
}

/**
 * Every violation, as `INVARIANT:`-prefixed strings, instead of throwing on the first.
 *
 * This is the **read** path's severity. The hard-fail decision on B0-714 is about what may be
 * *persisted*: generation refuses to write a report whose numbers contradict each other. A report
 * already stored is a historical record, and re-deriving it on every page load means a stored
 * report that trips a check would otherwise become permanently unopenable — `loadReportData` has
 * no catch, so the error would surface as a bare 500, not even as the invariant panel (which reads
 * `report_state.error`, written only by the generation path).
 *
 * So the read path degrades instead: the report renders and every violation is surfaced loudly on
 * `metrics.warnings`, which the UI already displays. Refusing to *create* bad numbers and refusing
 * to *show* numbers already created are different questions, and only the first one was decided.
 */
export function collectInvariantFailures(ctx: ReportInvariantContext): string[] {
  const failures: string[] = [];
  for (const invariant of REPORT_INVARIANTS) {
    const detail = invariant.failed(ctx);
    if (detail !== null) {
      failures.push(`${INVARIANT_ERROR_PREFIX} ${invariant.name} — ${detail}`);
    }
  }
  return failures;
}
