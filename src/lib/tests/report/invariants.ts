import type { ConceptKindCoverage } from './case-concepts';
import type { EvaluatedCase, RateBlock, SpeedBlock, SubScoreWeights } from './metrics';

/**
 * B0-714 / B0-815 — the report's reconciliation checks (methodology §11), split by severity.
 *
 * The reference skill's `compute_metrics.py` exits non-zero and refuses to build the document when
 * a check fails. Ours used to push a string onto `metrics.warnings` and render anyway, which makes
 * a structurally impossible report — a rate table whose counts do not add up, a Completeness that
 * is not the coverage it claims — look like a finished report with a note attached.
 *
 * The severity split agreed on B0-714 (Tom Bird, 2026-08-27):
 *
 * - **Structural invariants (this module) hard-fail generation.** They describe facts that cannot
 *   be true of a correctly computed report, so there is no version of the document worth shipping.
 *   `assertReportInvariants` throws a `ReportInvariantError`; the orchestrator's existing catch
 *   persists `status: 'failed'` with the message in `state.error` and never reaches
 *   `saveReportMarkdown`, so the report can never be written as `completed`.
 * - **Data-quality notes stay advisory** on `metrics.warnings` and still render: a missing
 *   sub-score coerced to 0, implausible timing. We deliberately diverge from the Python script on
 *   the null sub-score in particular — one flaky grading call should degrade a report, not destroy
 *   it.
 *
 * B0-813 (pure-math scoring) removed every floor/ceiling/gate/auto-Pass check — there is no such
 * rule left to verify — and added the three that pin the new model: Completeness *is* the
 * expected-concept coverage, `overall` *is* the weighted sum, and the Result *is* the pass mark.
 *
 * The checks are a list, not a run of inline `if`s, so adding one is a single entry rather than
 * an edit to control flow.
 */

/**
 * Stable marker on `report_state.error`. The report UI branches on this to tell "the numbers did
 * not reconcile" apart from "OpenAI/the network failed" — two failures with completely different
 * remedies (fix the data / press Retry).
 */
export const INVARIANT_ERROR_PREFIX = 'INVARIANT:';

/** Thrown by `assertReportInvariants`. Named so a `catch` can identify it after serialization. */
export class ReportInvariantError extends Error {
  /** The failing check's `name`, e.g. `completeness_equals_expected_coverage`. */
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
  /** B0-717 — the run's speed readout, or null when nothing was timed. */
  speed: SpeedBlock | null;
  /**
   * The sub-score weighting `computeReportMetrics` used. Handed in rather than imported so
   * `overall_recomputes_from_sub_scores` can recompute a content score from the *same* constant
   * without this module taking a runtime dependency on `./metrics` (which imports this one).
   */
  weights: SubScoreWeights;
  /** B0-812 — the pass mark every Result was derived from. */
  passMark: number;
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

/**
 * Slack allowed when re-deriving a combined speed score from its stored parts. Both the per-metric
 * scores and the combined score are rounded once at source (one decimal each), so an exact
 * comparison would fail on rounding alone; anything past this is a real disagreement.
 */
const SPEED_RECOMPUTE_TOLERANCE = 0.2;

/** Order-insensitive multiset equality; concept phrases may legitimately repeat. */
function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/** Order-insensitive multiset inclusion: every phrase of `a` (with multiplicity) is in `b`. */
function multisetSubset(a: readonly string[], b: readonly string[]): boolean {
  const remaining = [...b];
  for (const phrase of a) {
    const at = remaining.indexOf(phrase);
    if (at === -1) return false;
    remaining.splice(at, 1);
  }
  return true;
}

function coverageMismatch(
  kind: string,
  coverage: ConceptKindCoverage,
): string | null {
  return sameMultiset([...coverage.satisfied, ...coverage.missing], coverage.required)
    ? null
    : `${kind}: required ${coverage.required.length}, satisfied ${coverage.satisfied.length} + missing ${coverage.missing.length}`;
}

/** The letter a score earns — duplicated from `./metrics` on purpose to avoid the import cycle. */
function gradeFor(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export const REPORT_INVARIANTS: readonly ReportInvariant[] = [
  {
    name: 'status_counts_sum_to_evaluated',
    describes: 'pass + fail equals the evaluated case count',
    failed: (ctx) => {
      const sum = ctx.overall.pass + ctx.overall.fail;
      return sum === ctx.evaluated.length
        ? null
        : `pass+fail = ${sum}, evaluated = ${ctx.evaluated.length}`;
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
    name: 'overall_recomputes_from_sub_scores',
    describes:
      'every content score is the weighted sum of its four sub-scores and nothing else — no floor, no cap, no speed, no judged metric',
    failed: (ctx) => {
      const offenders: string[] = [];
      for (const c of ctx.evaluated) {
        const recomputed = Math.round(
          ctx.weights.accuracy * c.accuracy +
            ctx.weights.completeness * c.completeness +
            ctx.weights.relevance * c.relevance +
            ctx.weights.clarity * c.clarity,
        );
        if (recomputed !== c.overall) {
          offenders.push(`${c.id} — overall ${c.overall}, sub-scores recompute to ${recomputed}`);
        }
      }
      return offenders.length === 0 ? null : offenders.join(' | ');
    },
  },
  {
    name: 'completeness_equals_expected_coverage',
    describes:
      "every evaluated case's Completeness is 100 × expected concepts satisfied ÷ required, and every evaluated case specifies at least one expected concept",
    failed: (ctx) => {
      const offenders: string[] = [];
      for (const c of ctx.evaluated) {
        const required = c.concepts.expected.required.length;
        if (required === 0) {
          offenders.push(`${c.id} — evaluated with no expected concepts`);
          continue;
        }
        const satisfied = c.concepts.expected.satisfied.length;
        const recomputed = Math.round((100 * satisfied) / required);
        if (
          recomputed !== c.completeness ||
          c.coverage.required !== required ||
          c.coverage.satisfied !== satisfied
        ) {
          offenders.push(
            `${c.id} — completeness ${c.completeness}, coverage ${satisfied}/${required} recomputes to ${recomputed}`,
          );
        }
      }
      return offenders.length === 0 ? null : offenders.join(' | ');
    },
  },
  {
    name: 'status_matches_pass_mark',
    describes: 'the Result is Pass exactly when overall ≥ the pass mark in force, and nothing else decides it',
    failed: (ctx) => {
      const offenders = ctx.evaluated.filter(
        (c) => c.status !== (c.overall >= ctx.passMark ? 'Pass' : 'Fail'),
      );
      return offenders.length === 0
        ? null
        : `pass mark ${ctx.passMark}: ${offenders
            .map((c) => `${c.id} (${c.overall} → ${c.status})`)
            .join(', ')}`;
    },
  },
  {
    name: 'grade_recomputes_from_overall',
    describes: 'every letter grade is the band its own overall falls in',
    failed: (ctx) => {
      const offenders = ctx.evaluated.filter((c) => c.grade !== gradeFor(c.overall));
      return offenders.length === 0
        ? null
        : offenders.map((c) => `${c.id} — overall ${c.overall} graded ${c.grade}`).join(' | ');
    },
  },
  {
    name: 'concept_coverage_partitions_required',
    describes: "each case's satisfied + missing concepts equal its required concepts, per kind",
    failed: (ctx) => {
      const offenders: string[] = [];
      for (const c of ctx.evaluated) {
        const mismatches = [
          coverageMismatch('mandatory', c.concepts.mandatory),
          coverageMismatch('expected', c.concepts.expected),
        ].filter((m): m is string => m !== null);
        if (mismatches.length > 0) offenders.push(`${c.id} — ${mismatches.join('; ')}`);
      }
      return offenders.length === 0 ? null : offenders.join(' | ');
    },
  },
  {
    name: 'mandatory_subset_of_expected',
    describes:
      'every mandatory concept is also an expected concept, so a must-have miss is visible in coverage',
    failed: (ctx) => {
      const offenders = ctx.evaluated.filter(
        (c) => !multisetSubset(c.concepts.mandatory.required, c.concepts.expected.required),
      );
      return offenders.length === 0
        ? null
        : `mandatory concepts absent from the expected set: ${offenders.map((c) => c.id).join(', ')}`;
    },
  },
  {
    name: 'mandatory_miss_is_reported',
    describes: 'a case missing a must-have concept carries the reported flag, and only such a case does',
    failed: (ctx) => {
      const offenders = ctx.evaluated.filter(
        (c) => c.mandatoryMissing !== c.concepts.mandatory.missing.length > 0,
      );
      return offenders.length === 0
        ? null
        : `mandatoryMissing flag disagrees with the concept block: ${offenders.map((c) => c.id).join(', ')}`;
    },
  },
  {
    name: 'speed_scores_match_timings',
    describes:
      'a speed score exists only where a timing does, names exactly the metrics measured, and recomputes from them',
    failed: (ctx) => {
      const offenders: string[] = [];
      for (const s of ctx.speed?.perCase ?? []) {
        const present = [s.ttft, s.total].filter((m) => m !== null);
        if (present.length === 0) {
          offenders.push(`${s.id} — speed score ${s.score} with neither timing recorded`);
          continue;
        }
        const expected = s.ttft && s.total ? 'combined' : s.ttft ? 'ttft_only' : 'total_only';
        if (s.basis !== expected) {
          offenders.push(`${s.id} — basis "${s.basis}" but the measured metrics say "${expected}"`);
          continue;
        }
        const weighted = present.reduce((sum, m) => sum + m.score * m.weight, 0);
        if (Math.abs(weighted - s.score) > SPEED_RECOMPUTE_TOLERANCE) {
          offenders.push(
            `${s.id} — speed score ${s.score} does not match its weighted metrics (${weighted})`,
          );
        }
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
