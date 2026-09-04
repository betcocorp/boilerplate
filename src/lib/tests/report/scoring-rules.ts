import {
  gradeFromScore,
  roundScore,
  statusFromScore,
  WEIGHTS,
  type CaseStatus,
  type Grade,
} from './arithmetic';
import type { CaseConcepts } from './case-concepts';
import type { ScoringRules } from './scoring-config';

/**
 * B0-835 — the deterministic concept scoring rules, a function-for-function port of the reference
 * agent-evaluation skill's `scripts/concept_rules.py` (`derive_flags`, `minimal_floor_value` /
 * `apply_minimal_floor`, `expected_coverage_pct` / `apply_expected_coverage`,
 * `minimal_ceiling_value` / `apply_minimal_ceiling`, `rubric_status`, `final_status`,
 * `constraint_note`), documented the way `./case-concepts` documents its own port.
 *
 * **The division of labour is the skill's, unchanged.** The grader decides *semantically* whether
 * each concept phrase is communicated by the answer and authors those verdicts onto the case
 * (`CaseConcepts`, `./schemas`). Nothing in this module reads a response, and nothing here does
 * keyword matching: it is the arithmetic on top of the grader's judgments.
 *
 * **The model, in three sentences** (methodology §2b):
 *
 * - Miss any mandatory concept and the answer is capped at 59 — grade F, Result Fail. The uncapped
 *   arithmetic survives as the Pre-Gate Content Score, a per-case diagnostic that never enters an
 *   average or a rollup, so a near miss (pre-gate 77) stays distinguishable from a total one (17).
 * - Satisfy every mandatory concept and it scores at least 70 (a C), because the must-have content
 *   was delivered — unless a material factual issue is flagged, which withdraws that protection.
 * - Completeness is capped at the share of expected concepts the answer actually covers, so missing
 *   expected content reduces the grade proportionally instead of sitting beside it as a note.
 *
 * **The order is fixed** (methodology §2b Rule 4 step 7) and lives in exactly one place,
 * `deriveCaseScoreline`, so no consumer can run it differently:
 *
 *   coverage cap on Completeness → weight → mandatory floor → Pre-Gate Content Score →
 *   mandatory ceiling → round → Result (rubric, then auto-Pass, then gate).
 *
 * The gate runs last and outranks the automatic Pass. B0-835 (Tom Bird, 2026-09-04) reverses the
 * B0-813 decision to drop all four rules; `./scoring-config` carries that decision record.
 *
 * Regulated-data rule: concept phrases are regulated free text. Every phrase this module touches is
 * copied by reference and re-emitted verbatim — counted, never parsed, rounded, unit-converted or
 * re-cased. Every rounding goes through `roundScore` (half-up, B0-814), never `Math.round`.
 */

/**
 * The deterministic booleans derived from one case's concept verdicts — the port of
 * `derive_flags`. Never authored by the grader, always derived here.
 */
export type ConceptFlags = {
  /** The case lists at least one mandatory concept. A blank column is not a failure. */
  mandatorySpecified: boolean;
  expectedSpecified: boolean;
  /** True when no mandatory concept is missing — vacuously true when none are specified. */
  allMandatorySatisfied: boolean;
  /** Requires the expected column to be specified: "all of nothing" is not full coverage. */
  allExpectedSatisfied: boolean;
  /** Full expected coverage with no material factual issue — the automatic Pass's precondition. */
  autoPassQualified: boolean;
  /** Full expected coverage, but a material issue withheld the automatic Pass. */
  autoPassBlocked: boolean;
  /** A mandatory concept was specified and missed. */
  gated: boolean;
  /** Qualified and not gated: Rule 1 outranks Rule 2. */
  autoPassTriggered: boolean;
  materialIssue: boolean;
};

/** Port of `derive_flags`. Pure: it returns the flags rather than mutating the concept block. */
export function deriveConceptFlags(concepts: CaseConcepts): ConceptFlags {
  const mandatorySpecified = concepts.mandatory.required.length > 0;
  const expectedSpecified = concepts.expected.required.length > 0;
  const allMandatorySatisfied = !mandatorySpecified || concepts.mandatory.missing.length === 0;
  const allExpectedSatisfied = expectedSpecified && concepts.expected.missing.length === 0;
  const materialIssue = concepts.materialIssue;
  const autoPassQualified = allExpectedSatisfied && !materialIssue;
  const autoPassBlocked = allExpectedSatisfied && materialIssue;
  const gated = mandatorySpecified && !allMandatorySatisfied;
  return {
    mandatorySpecified,
    expectedSpecified,
    allMandatorySatisfied,
    allExpectedSatisfied,
    autoPassQualified,
    autoPassBlocked,
    gated,
    autoPassTriggered: autoPassQualified && !gated,
    materialIssue,
  };
}

/**
 * The share of expected concepts the answer covers, 0–100, or **null when no coverage constraint
 * applies**: the rule is disabled, or the case specifies no expected concepts (a blank cell is not
 * a failure). Port of `expected_coverage_pct`, rounded half-up per B0-814.
 */
export function expectedCoveragePct(
  concepts: CaseConcepts,
  rules: ScoringRules,
): number | null {
  if (!rules.expectedCoverage.enabled) return null;
  const required = concepts.expected.required.length;
  if (required <= 0) return null;
  return roundScore((100 * concepts.expected.satisfied.length) / required);
}

/** What `applyExpectedCoverage` decided. `applied` is true only where the cap actually bound. */
export type CoverageOutcome = {
  completeness: number;
  coveragePct: number | null;
  applied: boolean;
};

/**
 * Caps Completeness at the expected coverage achieved (Rule 3). Port of
 * `apply_expected_coverage`: the cap only ever **lowers** a value, so a grader who already scored
 * Completeness at or below the coverage share keeps their number, and `applied` is true only where
 * the cap moved it — a case at exactly the coverage share is not mislabelled as capped.
 */
export function applyExpectedCoverage(
  judged: number,
  concepts: CaseConcepts,
  rules: ScoringRules,
): CoverageOutcome {
  const pct = expectedCoveragePct(concepts, rules);
  if (pct === null) return { completeness: judged, coveragePct: null, applied: false };
  if (judged <= pct) return { completeness: judged, coveragePct: pct, applied: false };
  return { completeness: pct, coveragePct: pct, applied: true };
}

/**
 * The score floor full mandatory coverage earns, or **null when no floor applies**: the floor is
 * disabled, the case specifies no mandatory concepts, one or more are missing (the ceiling handles
 * that), or a material factual issue is flagged and the floor respects it. Port of
 * `minimal_floor_value`.
 */
export function minimalFloorValue(flags: ConceptFlags, rules: ScoringRules): number | null {
  if (!rules.minimalFloor.enabled) return null;
  if (!flags.mandatorySpecified) return null;
  if (!flags.allMandatorySatisfied) return null;
  if (rules.minimalFloor.respectMaterialIssue && flags.materialIssue) return null;
  return rules.minimalFloor.score;
}

/** What a floor or ceiling did to a score. `applied` is true only where the bound actually moved it. */
export type BoundOutcome = {
  overall: number;
  /** The bound's value whenever one applied at all, even if the score was already past it. */
  bound: number | null;
  applied: boolean;
};

/**
 * Raises a weighted score to the mandatory floor when full coverage earns it (Rule 1b). Port of
 * `apply_minimal_floor`. The floor **only ever raises** a score, and `applied` is true only when it
 * actually did — a case already above it is never mislabelled as floored.
 *
 * In a healthy run the floor binds nothing: an answer that delivered every must-have normally
 * scores in the 80s or 90s on its own. `computeReportMetrics` therefore warns wherever it fires,
 * because full coverage scoring below a C means the sub-scores and the concept judgments disagree.
 */
export function applyMinimalFloor(
  overall: number,
  flags: ConceptFlags,
  rules: ScoringRules,
): BoundOutcome {
  const floor = minimalFloorValue(flags, rules);
  if (floor === null) return { overall, bound: null, applied: false };
  if (overall >= floor) return { overall, bound: floor, applied: false };
  return { overall: floor, bound: floor, applied: true };
}

/**
 * The ceiling a missing mandatory concept imposes, or **null when no ceiling applies**: the ceiling
 * is disabled, **the gate itself is disabled** (the ceiling exists to express the gate's verdict in
 * the score, so it must not fire where the gate does not), the case specifies no mandatory
 * concepts, or every mandatory concept is satisfied. Port of `minimal_ceiling_value`.
 */
export function minimalCeilingValue(flags: ConceptFlags, rules: ScoringRules): number | null {
  if (!rules.minimalCeiling.enabled) return null;
  if (!rules.minimalGate.enabled) return null;
  if (!flags.mandatorySpecified) return null;
  if (flags.allMandatorySatisfied) return null;
  return rules.minimalCeiling.score;
}

/**
 * Caps a score at the mandatory ceiling when a must-have concept is missing (Rule 1). Port of
 * `apply_minimal_ceiling`, and the mirror image of the floor: it **only ever lowers** a score.
 *
 * This is what keeps the number, the letter and the Result in agreement. Without it a case could
 * read "80/100, grade B — Fail", which is two true statements about different things and
 * unreadable to anyone who has not memorised the rulebook. The uncapped arithmetic is never
 * destroyed — the caller reports it as the Pre-Gate Content Score.
 */
export function applyMinimalCeiling(
  overall: number,
  flags: ConceptFlags,
  rules: ScoringRules,
): BoundOutcome {
  const ceiling = minimalCeilingValue(flags, rules);
  if (ceiling === null) return { overall, bound: null, applied: false };
  if (overall <= ceiling) return { overall, bound: ceiling, applied: false };
  return { overall: ceiling, bound: ceiling, applied: true };
}

/**
 * Where a case's Result came from. `rubric` is the pass mark alone; the other two are the named
 * concept rules that may depart from it, and both are reported so neither can move a Result
 * silently.
 */
export type StatusSource = 'rubric' | 'auto_pass' | 'minimal_gate';

export type FinalStatus = {
  status: CaseStatus;
  source: StatusSource;
  /** True for **every** gated case — the rating was constrained, whether or not a Pass was lost. */
  ratingConstrained: boolean;
  /** The narrower fact that the gate actually took a Pass away, judged on the pre-gate score. */
  gateBlockedAPass: boolean;
};

/**
 * Port of `final_status`. Three steps, deliberately small:
 *
 * 1. the weighted rubric gives the baseline Result,
 * 2. full expected coverage with no material issue can **raise** it to Pass (Rule 2),
 * 3. a missing mandatory concept rates the case **Fail** — applied last, so the safety rule
 *    outranks everything, the automatic Pass included (Rule 1).
 *
 * `preGate` is what "did the gate actually take a Pass away?" is judged against: once the ceiling
 * has capped `overall` to an F the rubric already says Fail, and asking the question of the capped
 * score would silently answer "no" for every gated case and lose the bookkeeping.
 */
export function finalStatus(
  overall: number,
  flags: ConceptFlags,
  rules: ScoringRules,
  passMark: number,
  preGate: number,
): FinalStatus {
  const base = statusFromScore(overall, passMark);
  let status: CaseStatus = base;
  let source: StatusSource = 'rubric';

  if (flags.autoPassQualified && base !== 'Pass') {
    status = 'Pass';
    source = 'auto_pass';
  }

  let ratingConstrained = false;
  let gateBlockedAPass = false;
  if (flags.gated && rules.minimalGate.enabled) {
    ratingConstrained = true;
    gateBlockedAPass = statusFromScore(preGate, passMark) !== 'Fail';
    status = 'Fail';
    source = 'minimal_gate';
  }

  return { status, source, ratingConstrained, gateBlockedAPass };
}

/**
 * One human-readable sentence explaining the concept-driven rating outcome, or null when no rule
 * had anything to say. Port of `constraint_note`, sentence for sentence; every number in it is
 * rounded through this folder's helpers rather than Python's.
 */
export function constraintNote(params: {
  concepts: CaseConcepts;
  flags: ConceptFlags;
  source: StatusSource;
  constrained: boolean;
  blocked: boolean;
  overall: number;
  preGate: number;
  floorApplied: boolean;
  floor: number | null;
  coverageApplied: boolean;
  coveragePct: number | null;
  completenessJudged: number | null;
}): string | null {
  const { concepts, flags, overall, preGate } = params;

  if (params.constrained) {
    // Verbatim, in dataset order — the missing phrases are regulated free text.
    const missing = concepts.mandatory.missing.join(', ') || 'a mandatory concept';
    const head = `Failed on mandatory concepts: ${missing}.`;
    if (params.blocked) {
      return (
        `${head} A missing mandatory concept caps the score at ${overall}/100 ` +
        `(grade ${gradeFromScore(overall)}, Fail). Pre-Gate Content Score: ` +
        `${roundScore(preGate)}/100 — the rubric arithmetic before the cap, shown as a ` +
        'diagnostic so a near miss stays distinguishable from a total one.'
      );
    }
    return (
      `${head} The response scored ${roundScore(preGate)}/100 on the rubric and failed there ` +
      `as well; the mandatory cap holds it at ${overall}/100.`
    );
  }

  if (params.source === 'auto_pass') {
    return (
      'Automatic Pass: the response communicates all expected key concepts ' +
      `with no material factual issue (weighted score ${overall}/100).`
    );
  }

  if (flags.autoPassBlocked) {
    const note = concepts.materialIssueNote || 'a material factual issue was found';
    return (
      `Automatic Pass not applied: all expected concepts are present, but ${note}. ` +
      'The mandatory floor is also withheld for the same reason.'
    );
  }

  if (params.floorApplied && params.floor !== null) {
    return (
      `All mandatory concepts satisfied, so the score was raised to the ${params.floor} ` +
      'floor. NOTE: the sub-scores placed this below a C despite full mandatory ' +
      'coverage — worth re-checking the sub-scores or the concept judgments.'
    );
  }

  if (params.coverageApplied && params.coveragePct !== null) {
    return (
      `Completeness was set by expected-concept coverage (${params.coveragePct}%), which is ` +
      `below the grader's judged ${params.completenessJudged}. Expected key concepts are part ` +
      'of the content grade: missing expected content reduces Completeness proportionally.'
    );
  }

  return null;
}

/**
 * Every derived number for one case, in the fixed order of methodology §2b Rule 4 step 7.
 *
 * This is the single shape every consumer reads — `computeReportMetrics` per case, and
 * `consolidateCasePasses` per pass — so per-pass overalls and the headline sit on one scale, as
 * `consolidate_runs.py` and `compute_metrics.py` do in the reference.
 */
export type CaseScoreline = {
  /**
   * The grader's judged Completeness, or **null when the grader emitted none** — the passes graded
   * between the B0-813 rewrite (2026-09-03) and B0-835 (2026-09-04). Completeness is then the
   * coverage share, which is the only Completeness data such a pass has.
   */
  completenessJudged: number | null;
  /** The expected-concept coverage share, always computable (an evaluated case has expected concepts). */
  coveragePct: number;
  /** The Completeness that fed the weighted score: `min(judged, coverage)`, or the coverage share. */
  completeness: number;
  /** True only where the coverage cap actually lowered the grader's judged Completeness. */
  coverageApplied: boolean;
  /** `0.40·A + 0.30·C + 0.20·R + 0.10·Cl`, rounded once. Before floor and ceiling. */
  weighted: number;
  /** The floor's value, **only when it actually raised the score**; null otherwise. */
  floor: number | null;
  floorApplied: boolean;
  /**
   * The Pre-Gate Content Score: the arithmetic that survives the floor, before the ceiling. A
   * **diagnostic only** — never the final score, never averaged, never rolled up.
   */
  preGateScore: number;
  preGateGrade: Grade;
  /** The ceiling's value, **only when it actually lowered the score**; null otherwise. */
  ceiling: number | null;
  ceilingApplied: boolean;
  /** The final content score: weighted, then floor, then ceiling, rounded once. */
  overall: number;
  grade: Grade;
  /** The Result the pass mark alone gives `overall`. */
  rubricStatus: CaseStatus;
  /** The final Result, after the automatic Pass and the mandatory gate. */
  status: CaseStatus;
  statusSource: StatusSource;
  ratingConstrained: boolean;
  gateBlockedAPass: boolean;
  flags: ConceptFlags;
  conceptNote: string | null;
};

export type CaseScorelineInput = {
  accuracy: number;
  /** Null for a pass whose grader emitted no Completeness; coverage is then the only source. */
  completenessJudged: number | null;
  relevance: number;
  clarity: number;
  concepts: CaseConcepts;
  rules: ScoringRules;
  passMark: number;
};

/**
 * The whole per-case pipeline, in one place so it exists exactly once.
 *
 * Returns **null when the case specifies no expected concepts** — the caller marks it Unable to
 * Evaluate (Tom Bird's standing rule: a concept-less case is never graded holistically). Mandatory
 * ⊆ expected is guaranteed upstream by the grader's `requiredConcepts`, and asserted structurally
 * by `./invariants`, so a case with mandatory concepts always has expected ones too.
 */
export function deriveCaseScoreline(input: CaseScorelineInput): CaseScoreline | null {
  const { concepts, rules, passMark } = input;
  const required = concepts.expected.required.length;
  if (required === 0) return null;

  const flags = deriveConceptFlags(concepts);
  // Always computable and always reported, whether or not the cap is enabled: the reader needs the
  // coverage share beside Completeness to see where the number came from.
  const coveragePct = roundScore((100 * concepts.expected.satisfied.length) / required);

  // Step 1 (Rule 3) — cap Completeness at the coverage achieved. With no judged value there is
  // nothing to cap: coverage IS the Completeness, and `coverageApplied` stays false because no
  // grader judgment was moved.
  let completeness: number;
  let coverageApplied = false;
  if (input.completenessJudged === null) {
    completeness = coveragePct;
  } else {
    const capped = applyExpectedCoverage(input.completenessJudged, concepts, rules);
    completeness = capped.completeness;
    coverageApplied = capped.applied;
  }

  // Step 2 — weight the four sub-scores.
  const weighted = roundScore(
    WEIGHTS.accuracy * input.accuracy +
      WEIGHTS.completeness * completeness +
      WEIGHTS.relevance * input.relevance +
      WEIGHTS.clarity * input.clarity,
  );

  // Step 3 (Rule 1b) — full mandatory coverage is worth at least a C.
  const floored = applyMinimalFloor(weighted, flags, rules);
  // Step 4 — the Pre-Gate Content Score, captured before the cap so a near miss and a total miss
  // stay distinguishable. The same reference point `consolidateCasePasses` uses for its bands.
  const preGateScore = roundScore(floored.overall);
  // Step 5 (Rule 1) — the ceiling runs last and outranks the floor.
  const capped = applyMinimalCeiling(floored.overall, flags, rules);
  const overall = roundScore(capped.overall);

  const rubricStatus = statusFromScore(overall, passMark);
  const final = finalStatus(overall, flags, rules, passMark, preGateScore);

  return {
    completenessJudged: input.completenessJudged,
    coveragePct,
    completeness,
    coverageApplied,
    weighted,
    floor: floored.applied ? floored.bound : null,
    floorApplied: floored.applied,
    preGateScore,
    preGateGrade: gradeFromScore(preGateScore),
    ceiling: capped.applied ? capped.bound : null,
    ceilingApplied: capped.applied,
    overall,
    grade: gradeFromScore(overall),
    rubricStatus,
    status: final.status,
    statusSource: final.source,
    ratingConstrained: final.ratingConstrained,
    gateBlockedAPass: final.gateBlockedAPass,
    flags,
    conceptNote: constraintNote({
      concepts,
      flags,
      source: final.source,
      constrained: final.ratingConstrained,
      blocked: final.gateBlockedAPass,
      overall,
      preGate: preGateScore,
      floorApplied: floored.applied,
      floor: floored.applied ? floored.bound : null,
      coverageApplied,
      coveragePct,
      completenessJudged: input.completenessJudged,
    }),
  };
}
