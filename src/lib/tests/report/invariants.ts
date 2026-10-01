import { gradeFromScore } from './arithmetic';
import type { ConceptKindCoverage } from './case-concepts';
import type { EvaluatedCase, RateBlock, SpeedBlock, SubScoreWeights } from './metrics';
import type { ScoringRules } from './scoring-config';

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
 * B0-835 restored the concept rules, so the checks that pin them are back and are the bulk of this
 * list: the coverage cap only ever lowers Completeness, the floor only ever raises a score, the
 * ceiling only ever lowers one, the two never fire on the same case, the Pre-Gate Content Score
 * survives wherever the ceiling bound, a gated case Fails and grades F while the gate is on, a
 * triggered automatic Pass is a Pass and a blocked one never became one, and a Result only ever
 * departs from the pass mark through a *named* rule (`statusSource`). Every one of them is a port
 * of a `check(...)` in the reference `compute_metrics.py`.
 *
 * The checks that assert what a rule *did* read `ctx.scoringRules`, so a run with a rule switched
 * off — a supported configuration — still reconciles instead of failing on a rule that was never
 * meant to fire.
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
  /** The failing check's `name`, e.g. `completeness_never_exceeds_coverage`. */
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
  /**
   * B0-835 — the concept rules the metrics were computed under. Handed in for the same reason
   * `weights` is, and read by every check that asserts what the gate, the floor, the ceiling or
   * the coverage cap did: a report with a rule disabled must reconcile, not fail.
   */
  scoringRules: ScoringRules;
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

/** Every offender, or null when the check holds. Saves repeating the join at 20 call sites. */
function offendersOf(
  cases: readonly EvaluatedCase[],
  broken: (c: EvaluatedCase) => boolean,
  describe: (c: EvaluatedCase) => string,
): string | null {
  const offenders = cases.filter(broken).map(describe);
  return offenders.length === 0 ? null : offenders.join(' | ');
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
    name: 'weighted_recomputes_from_sub_scores',
    describes:
      'every weighted score is the weighted sum of its four sub-scores and nothing else — no floor, no cap, no speed, no judged metric',
    failed: (ctx) =>
      offendersOf(
        ctx.evaluated,
        (c) =>
          Math.round(
            ctx.weights.accuracy * c.accuracy +
              ctx.weights.completeness * c.completeness +
              ctx.weights.relevance * c.relevance +
              ctx.weights.clarity * c.clarity,
          ) !== c.weighted,
        (c) =>
          `${c.id} — weighted ${c.weighted}, sub-scores recompute to ${Math.round(
            ctx.weights.accuracy * c.accuracy +
              ctx.weights.completeness * c.completeness +
              ctx.weights.relevance * c.relevance +
              ctx.weights.clarity * c.clarity,
          )}`,
      ),
  },
  {
    name: 'overall_equals_weighted_or_floor_or_ceiling',
    describes:
      'the final score is the weighted score, or the floor or the ceiling wherever one of them applied — nothing else ever moved it',
    failed: (ctx) => {
      const expected = (c: EvaluatedCase): number => {
        let value = c.weighted;
        if (c.floorApplied && c.floor != null) value = c.floor;
        if (c.ceilingApplied && c.ceiling != null) value = c.ceiling;
        return Math.round(value);
      };
      return offendersOf(
        ctx.evaluated,
        (c) => c.overall !== expected(c),
        (c) => `${c.id} — overall ${c.overall}, the pipeline gives ${expected(c)}`,
      );
    },
  },
  {
    name: 'floor_and_ceiling_never_both',
    describes:
      'the mandatory floor and the mandatory ceiling never fired on one case — the floor needs full must-have coverage and the ceiling needs a miss',
    failed: (ctx) =>
      offendersOf(
        ctx.evaluated,
        (c) => c.floorApplied && c.ceilingApplied,
        (c) => `${c.id} — floored to ${c.floor} and capped at ${c.ceiling}`,
      ),
  },
  {
    name: 'floor_only_raised',
    describes: 'the mandatory floor only ever raised a score, never lowered one',
    failed: (ctx) =>
      offendersOf(
        ctx.evaluated,
        (c) => !c.ceilingApplied && c.overall < c.weighted,
        (c) => `${c.id} — weighted ${c.weighted} became ${c.overall} with no ceiling applied`,
      ),
  },
  {
    name: 'ceiling_only_lowered',
    describes: 'the mandatory ceiling only ever lowered a score',
    failed: (ctx) =>
      offendersOf(
        ctx.evaluated,
        (c) => c.ceilingApplied && c.overall >= c.weighted,
        (c) => `${c.id} — capped at ${c.overall} from a weighted ${c.weighted}`,
      ),
  },
  {
    name: 'pre_gate_preserved_where_capped',
    describes:
      'the Pre-Gate Content Score survives wherever the ceiling bound, so a near miss stays distinguishable from a total one',
    failed: (ctx) =>
      offendersOf(
        ctx.evaluated,
        (c) => c.ceilingApplied && !(Number.isFinite(c.preGateScore) && c.preGateScore >= c.overall),
        (c) => `${c.id} — capped to ${c.overall} but the pre-gate score reads ${c.preGateScore}`,
      ),
  },
  {
    name: 'completeness_never_exceeds_coverage',
    describes:
      "every evaluated case specifies at least one expected concept, its coverage counts are its own concept block's, `coveragePct` recomputes from them, and (while the cap is on) Completeness never exceeds that share",
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
        if (c.coverage.required !== required || c.coverage.satisfied !== satisfied) {
          offenders.push(
            `${c.id} — coverage ${c.coverage.satisfied}/${c.coverage.required}, concept block says ${satisfied}/${required}`,
          );
          continue;
        }
        if (c.coveragePct !== recomputed) {
          offenders.push(
            `${c.id} — coveragePct ${c.coveragePct}, ${satisfied}/${required} recomputes to ${recomputed}`,
          );
          continue;
        }
        if (ctx.scoringRules.expectedCoverage.enabled && c.completeness > c.coveragePct) {
          offenders.push(
            `${c.id} — completeness ${c.completeness} exceeds coverage ${c.coveragePct}`,
          );
        }
      }
      return offenders.length === 0 ? null : offenders.join(' | ');
    },
  },
  {
    name: 'coverage_cap_only_lowered_completeness',
    describes:
      "the expected-coverage cap only ever lowered the grader's judged Completeness, never raised it",
    failed: (ctx) =>
      offendersOf(
        ctx.evaluated,
        (c) => c.completenessJudged != null && c.completeness > c.completenessJudged,
        (c) => `${c.id} — completeness ${c.completeness} above the judged ${c.completenessJudged}`,
      ),
  },
  {
    name: 'completeness_is_judged_where_cap_unbound',
    describes:
      "Completeness is the grader's judged value wherever the coverage cap did not bind, and the coverage share wherever the grader emitted none",
    failed: (ctx) =>
      offendersOf(
        ctx.evaluated,
        (c) =>
          c.completenessJudged == null
            ? c.completeness !== c.coveragePct
            : !c.coverageApplied && c.completeness !== c.completenessJudged,
        (c) =>
          `${c.id} — completeness ${c.completeness}, judged ${c.completenessJudged}, coverage ${c.coveragePct}, capped ${c.coverageApplied}`,
      ),
  },
  {
    name: 'no_floor_on_gated_case',
    describes: 'no mandatory floor was applied to a case missing a mandatory concept',
    failed: (ctx) =>
      offendersOf(
        ctx.evaluated,
        (c) => c.floorApplied && c.mandatoryMissing,
        (c) => `${c.id} — floored to ${c.floor} while missing a must-have concept`,
      ),
  },
  {
    name: 'no_floor_on_material_issue',
    describes:
      'no mandatory floor was applied to a case flagged with a material issue, while the floor respects one',
    failed: (ctx) =>
      ctx.scoringRules.minimalFloor.respectMaterialIssue
        ? offendersOf(
            ctx.evaluated,
            (c) => c.floorApplied && c.materialIssue,
            (c) => `${c.id} — floored to ${c.floor} with a material factual issue flagged`,
          )
        : null,
  },
  {
    name: 'status_matches_pass_mark_except_concept_rule',
    describes:
      'every Result sits on the pass mark in force, except where a *named* concept rule moved it — the automatic Pass or the mandatory gate',
    failed: (ctx) => {
      const offenders = ctx.evaluated.filter(
        (c) => c.status !== c.rubricStatus && c.statusSource === 'rubric',
      );
      return offenders.length === 0
        ? null
        : `pass mark ${ctx.passMark}: ${offenders
            .map((c) => `${c.id} (${c.overall} → ${c.status}, rubric ${c.rubricStatus})`)
            .join(', ')}`;
    },
  },
  {
    name: 'rubric_status_recomputes_from_pass_mark',
    describes: "every case's rubric Result is Pass exactly when its final score ≥ the pass mark",
    failed: (ctx) =>
      offendersOf(
        ctx.evaluated,
        (c) => c.rubricStatus !== (c.overall >= ctx.passMark ? 'Pass' : 'Fail'),
        (c) => `${c.id} — overall ${c.overall}, rubric status ${c.rubricStatus}`,
      ),
  },
  {
    name: 'score_grade_result_agree_except_auto_pass',
    describes:
      'no row can read "B / Fail": the number, the letter and the Result are three views of one score, and the only sanctioned departure is a named automatic Pass',
    failed: (ctx) =>
      offendersOf(
        ctx.evaluated,
        (c) =>
          (c.status === 'Pass') !== c.overall >= ctx.passMark && c.statusSource !== 'auto_pass',
        (c) => `${c.id} — ${c.overall}/100 grade ${c.grade} reads ${c.status}`,
      ),
  },
  {
    name: 'gated_cases_fail_when_gate_on',
    describes: 'every case missing a mandatory concept is rated Fail while the gate is on',
    failed: (ctx) =>
      ctx.scoringRules.minimalGate.enabled
        ? offendersOf(
            ctx.evaluated,
            (c) => c.mandatoryMissing && c.status !== 'Fail',
            (c) => `${c.id} — missing a must-have concept and rated ${c.status}`,
          )
        : null,
  },
  {
    name: 'gated_cases_capped_and_F_when_ceiling_on',
    describes:
      "the gate's verdict is visible in the number: while the ceiling is on, every gated case scores at or below it and grades F",
    failed: (ctx) =>
      ctx.scoringRules.minimalGate.enabled && ctx.scoringRules.minimalCeiling.enabled
        ? offendersOf(
            ctx.evaluated,
            (c) =>
              c.mandatoryMissing &&
              (c.overall > ctx.scoringRules.minimalCeiling.score || c.grade !== 'F'),
            (c) => `${c.id} — gated but scores ${c.overall}, grade ${c.grade}`,
          )
        : null,
  },
  {
    name: 'auto_pass_triggered_is_pass',
    describes: 'every triggered automatic Pass is rated Pass',
    failed: (ctx) =>
      offendersOf(
        ctx.evaluated,
        (c) => c.autoPassTriggered && c.status !== 'Pass',
        (c) => `${c.id} — automatic Pass triggered but rated ${c.status}`,
      ),
  },
  {
    name: 'auto_pass_blocked_never_auto_passed',
    describes:
      'no automatic Pass blocked by a material factual issue was nonetheless the source of a Pass',
    failed: (ctx) =>
      offendersOf(
        ctx.evaluated,
        (c) => c.autoPassBlocked && c.statusSource === 'auto_pass',
        (c) => `${c.id} — blocked automatic Pass recorded as the Result's source`,
      ),
  },
  {
    name: 'prevented_le_gated',
    describes:
      'the gate cannot have removed more Passes than there are gated cases — the prevented set is a subset of the gated set',
    failed: (ctx) => {
      const gated = ctx.evaluated.filter((c) => c.mandatoryMissing).length;
      const prevented = ctx.evaluated.filter((c) => c.gateBlockedAPass).length;
      const strays = ctx.evaluated.filter((c) => c.gateBlockedAPass && !c.mandatoryMissing);
      if (prevented <= gated && strays.length === 0) return null;
      return `prevented ${prevented} of ${gated} gated${
        strays.length > 0 ? `; not gated: ${strays.map((c) => c.id).join(', ')}` : ''
      }`;
    },
  },
  {
    name: 'grade_recomputes_from_overall',
    describes: 'every letter grade is the band its own overall falls in',
    failed: (ctx) =>
      offendersOf(
        ctx.evaluated,
        (c) => c.grade !== gradeFromScore(c.overall),
        (c) => `${c.id} — overall ${c.overall} graded ${c.grade}`,
      ),
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
    describes:
      'a case missing a must-have concept carries the flag the gate and the ceiling are keyed off, and only such a case does',
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
    name: 'judged_metrics_in_range',
    describes:
      'every judged similarity sits in 0–1 and every evaluator confidence in 0–100 — and neither appears in any content score (asserted by weighted_recomputes_from_sub_scores)',
    failed: (ctx) => {
      const offenders = ctx.evaluated.filter(
        (c) =>
          (c.similarity != null && (c.similarity < 0 || c.similarity > 1)) ||
          (c.evalConfidence != null && (c.evalConfidence < 0 || c.evalConfidence > 100)),
      );
      return offenders.length === 0
        ? null
        : offenders
            .map((c) => `${c.id} — similarity ${c.similarity}, confidence ${c.evalConfidence}`)
            .join(' | ');
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
