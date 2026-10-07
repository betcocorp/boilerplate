import type { TestItemRecord, TestRecord, TestResultRecord } from '~/lib/tests/types';

import type { ReportCase } from './data-schemas';
import { completenessFromCoverage, NO_EXPECTED_CONCEPTS_UTE_REASON, tierLabel } from './metrics';
import type { CaseScore, ReportState } from './schemas';
import { DEFAULT_PASS_MARK, DEFAULT_SCORING_RULES, type ScoringRules } from './scoring-config';

/**
 * B0-854 — the agent-evaluation skill's per-pass `eval_run{n}.json` shape, as one pure function.
 *
 * Extracted verbatim from `scripts/export-eval-json.ts` (B0-823 / B0-835) so a second producer —
 * `scripts/grade-with-bex-prompt.ts`, which re-grades a run outside the report pipeline — writes
 * the same bytes for the same judgments. The exporter's output is unchanged: every key, in the same
 * order, from the same sources. Bex is the spec; nothing here re-derives a number.
 */

/** The case fields the shape reads off an assembled `ReportCase`. */
export type EvalRunCaseSource = Pick<
  ReportCase,
  | 'id'
  | 'question'
  | 'priorityRaw'
  | 'tier'
  | 'category'
  | 'idealResponse'
  | 'actual'
  | 'ttftSeconds'
  | 'latencySeconds'
>;

/** The skill's `concepts` block, field for field, phrases copied by reference (regulated text). */
export function conceptsBlock(concepts: NonNullable<CaseScore['concepts']>) {
  return {
    minimal_required: concepts.mandatory.required,
    minimal_satisfied: concepts.mandatory.satisfied,
    minimal_missing: concepts.mandatory.missing,
    expected_required: concepts.expected.required,
    expected_satisfied: concepts.expected.satisfied,
    expected_missing: concepts.expected.missing,
    material_issue: concepts.materialIssue,
    material_issue_note: concepts.materialIssueNote,
  };
}

/** Bex's synthesis, when the report finished; the skill's keys are snake_case. Omitted otherwise. */
export function synthesisBlock(state: Pick<ReportState, 'synthesis'>) {
  const s = state.synthesis;
  if (!s) return {};
  return {
    failure_patterns: s.failurePatterns,
    strengths: s.strengths,
    weaknesses: s.weaknesses,
    top3: s.top3.map((r) => ({
      priority: r.priority,
      what: r.what,
      why_first: r.whyFirst,
      evidence: r.evidence,
      affected: r.affected,
      change: r.change,
      impact: r.impact,
    })),
    exec: {
      strongest_areas: s.exec.strongestAreas,
      improvement_areas: s.exec.improvementAreas,
      most_significant_failure: s.exec.mostSignificantFailure,
      major_risk: s.exec.majorRisk,
      readiness: s.exec.readiness,
    },
  };
}

/**
 * B0-835 — `scoring_config` in the skill's `concept_rules.py` `SCORING_DEFAULTS` shape, key for
 * key, from the rules this run was actually scored under. Every rule is declared, on or off, so the
 * skill's per-run overalls are computed under the rulebook these grades were produced by.
 */
export function toSkillScoringConfig(rules: ScoringRules, passMark: number) {
  return {
    pass_mark: { score: passMark },
    minimal_gate: { enabled: rules.minimalGate.enabled },
    minimal_floor: {
      enabled: rules.minimalFloor.enabled,
      score: rules.minimalFloor.score,
      respect_material_issue: rules.minimalFloor.respectMaterialIssue,
    },
    minimal_ceiling: { enabled: rules.minimalCeiling.enabled, score: rules.minimalCeiling.score },
    expected_coverage: { enabled: rules.expectedCoverage.enabled },
  };
}

/**
 * One case on one pass, in the skill's case shape. Evaluability is Bex's rule for THIS pass: the
 * grader said so, or the pass has no expected concepts — a concept-less case is never graded
 * holistically (B0-826 / B0-835). `completeness` is the judged value, uncapped; a pass graded in
 * the B0-813 window emitted none and falls back to the coverage share, as `deriveCaseScoreline` does.
 */
export function buildEvalRunCase(rc: EvalRunCaseSource, pass: CaseScore) {
  const coverage = pass.unableToEvaluate ? null : completenessFromCoverage(pass.concepts);
  const unableToEvaluate = pass.unableToEvaluate || coverage == null;
  const completeness = unableToEvaluate ? null : (pass.completeness ?? coverage);
  const uteReason = pass.unableToEvaluate
    ? (pass.uteReason ?? 'unspecified')
    : unableToEvaluate
      ? NO_EXPECTED_CONCEPTS_UTE_REASON
      : null;

  return {
    id: rc.id,
    question: rc.question,
    priority_raw: rc.priorityRaw,
    tier: rc.tier,
    category: rc.category,
    expected: rc.idealResponse,
    actual: rc.actual,
    ...(unableToEvaluate
      ? {}
      : {
          accuracy: pass.accuracy,
          completeness,
          relevance: pass.relevance,
          clarity: pass.clarity,
          explanation: pass.explanation,
          missed: pass.missed,
          incorrect: pass.incorrect,
          improvement: pass.improvement,
        }),
    ...(rc.ttftSeconds != null ? { ttft_seconds: rc.ttftSeconds } : {}),
    ...(rc.latencySeconds != null ? { latency_seconds: rc.latencySeconds } : {}),
    ...(pass.concepts ? { concepts: conceptsBlock(pass.concepts) } : {}),
    unable_to_evaluate: unableToEvaluate,
    ute_reason: uteReason,
    ...(pass.similarity != null ? { similarity: pass.similarity } : {}),
    ...(pass.similarityNote != null ? { similarity_note: pass.similarityNote } : {}),
    ...(pass.evalConfidence != null ? { eval_confidence: pass.evalConfidence } : {}),
    ...(pass.confidenceNote != null ? { confidence_note: pass.confidenceNote } : {}),
  };
}

export const EXPORT_EVAL_JSON_COMMENT =
  'Exported from Bex (scripts/export-eval-json.ts, B0-823 / B0-835). Bex’s grader judges all ' +
  'four sub-scores — Accuracy, Completeness, Relevance, Clarity — plus the per-concept verdicts. ' +
  '`completeness` is the judged value, UNCAPPED: apply `scoring_config` (expected-coverage cap, ' +
  'weights 40/30/20/10, mandatory floor, mandatory ceiling, automatic Pass, mandatory gate) to ' +
  'reproduce Bex’s numbers. A pass graded between 2026-09-03 and 2026-09-04 (the B0-813 window) ' +
  'carries no judged Completeness; its `completeness` is the expected-concept coverage share ' +
  '(100 × expected_satisfied / expected_required, half-up), exactly as Bex scores such a pass. ' +
  'A pass with no expected concepts is unable_to_evaluate under Bex’s rules and is exported as ' +
  'such. Bex is the spec.';

export type EvalRunDocumentInput = {
  test: Pick<TestRecord, 'id' | 'name' | 'intended_agent'>;
  run: Pick<TestResultRecord, 'id' | 'app_version'>;
  /** Dataset order; a case is emitted only when it has a score on this pass. */
  items: readonly Pick<TestItemRecord, 'id' | 'priority'>[];
  state: Pick<
    ReportState,
    | 'passes'
    | 'passMark'
    | 'spreadThreshold'
    | 'gradingPromptHash'
    | 'judgedThresholds'
    | 'scoringRules'
    | 'model'
    | 'gradingEffort'
    | 'synthesis'
  >;
  /** The assembled cases (question, golden, response, timings) keyed by `items[].id`. */
  cases: readonly EvalRunCaseSource[];
  /** Per-pass scores keyed by `test_items.id` — `report_state.casePassScores`, or a re-grade's. */
  passScores: Readonly<Record<string, readonly CaseScore[] | undefined>>;
  passIndex: number;
  exportedAt: string;
  /**
   * Overrides for a producer other than the exporter. Both absent → the exporter's bytes exactly:
   * `comment` replaces `meta.$comment`; `extra` is spread into `meta` after `bex`.
   */
  meta?: { comment?: string; extra?: Record<string, unknown> };
};

export function buildEvalRunDocument(input: EvalRunDocumentInput) {
  const { test, run, items, state, passIndex, exportedAt } = input;
  const caseById = new Map(input.cases.map((c) => [c.id, c]));
  const passMark = state.passMark ?? DEFAULT_PASS_MARK;

  const cases = [];
  for (const item of items) {
    const pass = input.passScores[item.id]?.[passIndex];
    if (!pass) continue;
    const rc = caseById.get(item.id);
    if (!rc) throw new Error(`assembly produced no case for item ${item.id}`);
    cases.push(buildEvalRunCase(rc, pass));
  }

  // Priority → tier, from the priorities this dataset actually uses, in dataset order.
  const tierLabels: Record<string, string> = {};
  for (const item of items) {
    if (item.priority != null) tierLabels[tierLabel(item.priority)] = String(item.priority);
  }

  return {
    meta: {
      workbook: test.name,
      ...(test.intended_agent ? { workflow: test.intended_agent } : {}),
      prepared_for: 'Betco / Bex',
      run_url: `/admin/tests/${test.id}/runs/${run.id}`,
      $comment: input.meta?.comment ?? EXPORT_EVAL_JSON_COMMENT,
      bex: {
        run_id: run.id,
        test_id: test.id,
        app_version: run.app_version,
        pass: passIndex + 1,
        passes: state.passes,
        grading: {
          model: state.model,
          effort: state.gradingEffort,
          pass_mark: passMark,
          spread_threshold: state.spreadThreshold,
          grading_prompt_hash: state.gradingPromptHash,
          judged_thresholds: state.judgedThresholds,
          // B0-835 — Bex's own record of the rules; null on a report_state that predates the field.
          scoring_rules: state.scoringRules,
        },
        exported_at: exportedAt,
      },
      ...(input.meta?.extra ?? {}),
    },
    tier_labels: tierLabels,
    // B0-835 — the concept rules these grades were actually scored under, declared explicitly
    // (never left to the skill's defaults). A report_state persisted before the field existed was
    // produced under the shipped defaults, which is what the read path applies to it too.
    scoring_config: toSkillScoringConfig(state.scoringRules ?? DEFAULT_SCORING_RULES, passMark),
    cases,
    ...synthesisBlock(state),
  };
}

export type EvalRunDocument = ReturnType<typeof buildEvalRunDocument>;
