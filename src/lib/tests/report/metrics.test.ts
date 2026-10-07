import { describe, expect, it } from 'vitest';

import type { CaseConcepts, ConceptKindCoverage } from './case-concepts';
import {
  assertReportInvariants,
  collectInvariantFailures,
  ReportInvariantError,
  REPORT_INVARIANTS,
  type ReportInvariantContext,
} from './invariants';
import {
  completenessFromCoverage,
  computeOverall,
  computeReportMetrics,
  NO_EXPECTED_CONCEPTS_UTE_REASON,
  roundScore,
  roundTo,
  round1,
  round2,
  statusFromScore,
  WEIGHTS,
  type EvaluatedCase,
  type RateBlock,
  type ReportCaseInput,
} from './metrics';
import type { CaseScore } from './schemas';
import {
  DEFAULT_PASS_MARK,
  DEFAULT_SCORING_RULES,
  STRICT_PASS_MARK,
  type ScoringRules,
} from './scoring-config';
import { speedRating } from './speed-rules';

/**
 * B0-812 / B0-835 / B0-815 — the reference skill's concept scoring rules, and the structural
 * invariants that pin them.
 *
 * Four things these tests exist to defend:
 *
 * 1. **The order is fixed** (methodology §2b Rule 4 step 7): coverage cap on Completeness → weight
 *    → mandatory floor → Pre-Gate Content Score → mandatory ceiling → round → Result. Each worked
 *    example below is the skill's own, so a Bex report and a desktop report agree.
 * 2. **The number, the letter and the Result always agree.** A must-have miss lowers the score
 *    itself (ceiling 59 → F → Fail), so no row can read "B / Fail"; the one sanctioned departure is
 *    a named automatic Pass, which is warned about so it can never happen silently.
 * 3. **A case with no expected concepts is Unable to Evaluate** — never graded on three sub-scores
 *    out of four, and never a guessed number.
 * 4. **Concept phrases are regulated free text.** The fixtures carry real dilution ratios, contact
 *    times, ppm and EPA registration numbers, asserted back byte-for-byte.
 */

const CONCEPT = {
  dilution: 'Dilute 1:64 (2 oz/gal)',
  contactTime: '10 minutes contact time at 600 ppm active quat',
  epa: 'EPA Reg. No. 6836-140-4170',
  metric: 'Metric equivalent 15.6 mL/L',
} as const;

/**
 * All four judged sub-scores set to `judged` — B0-835 restored the grader's judged Completeness,
 * which the coverage cap then bounds. Pass `{ completeness: null }` for a pass graded in the
 * B0-813 window, where the coverage share is the only Completeness there is.
 */
function score(judged: number, partial: Partial<CaseScore> = {}): CaseScore {
  return {
    unableToEvaluate: false,
    uteReason: null,
    accuracy: judged,
    completeness: judged,
    relevance: judged,
    clarity: judged,
    explanation: '',
    missed: '',
    incorrect: '',
    improvement: '',
    ...partial,
  };
}

function coverage(required: string[], missing: string[]): ConceptKindCoverage {
  return {
    required,
    satisfied: required.filter((concept) => !missing.includes(concept)),
    missing,
  };
}

function concepts(params: {
  mandatoryRequired: string[];
  mandatoryMissing?: string[];
  bonusRequired?: string[];
  bonusMissing?: string[];
  materialIssue?: boolean;
  materialIssueNote?: string | null;
}): CaseConcepts {
  const mandatoryMissing = params.mandatoryMissing ?? [];
  const bonusRequired = params.bonusRequired ?? [];
  const bonusMissing = params.bonusMissing ?? [];
  return {
    mandatory: coverage(params.mandatoryRequired, mandatoryMissing),
    // Mandatory ⊆ expected — the golden columns are authored that way and B0-815 asserts it.
    expected: coverage(
      [...params.mandatoryRequired, ...bonusRequired],
      [...mandatoryMissing, ...bonusMissing],
    ),
    materialIssue: params.materialIssue ?? false,
    materialIssueNote: params.materialIssueNote ?? null,
  };
}

/**
 * Every expected concept satisfied, one of them mandatory. Under the B0-835 rules that means the
 * coverage cap never binds (coverage is 100%), the mandatory floor raises anything below 70, and
 * the automatic Pass qualifies — so with equal judged sub-scores `j` the overall is `max(j, 70)`
 * and the Result is always Pass. The fixture for the floor and the automatic Pass.
 */
const FULL = concepts({ mandatoryRequired: [CONCEPT.dilution], bonusRequired: [CONCEPT.metric] });

/**
 * No mandatory concepts, and one of two expected concepts missing: no gate, no ceiling, no floor
 * and no automatic Pass, so the rubric arithmetic alone decides the Result. The fixture for
 * anything that needs a Fail to be reachable. Completeness is capped at the 50% coverage, so with
 * equal judged sub-scores `j` the overall is `0.7·j + 0.3·min(j, 50)` (90 → 78, 80 → 71, 70 → 64,
 * 62 → 58, 40 → 40).
 */
const RUBRIC_ONLY = concepts({
  mandatoryRequired: [],
  bonusRequired: [CONCEPT.dilution, CONCEPT.metric],
  bonusMissing: [CONCEPT.metric],
});

function input(
  id: string,
  judged: number,
  extra: Partial<ReportCaseInput> = {},
): ReportCaseInput {
  return {
    testItemId: id,
    question: `Question ${id}`,
    priorityRaw: 1,
    category: 'Dilution',
    score: score(judged),
    latencySeconds: null,
    ttftSeconds: null,
    concepts: FULL,
    ...extra,
  };
}

function only(inputs: ReportCaseInput[]): EvaluatedCase {
  const metrics = computeReportMetrics(inputs);
  expect(metrics.perCase).toHaveLength(1);
  return metrics.perCase[0]!;
}

describe('arithmetic primitives (B0-814 / B0-835)', () => {
  it('rounds half-up, in one place', () => {
    expect(roundScore(72.5)).toBe(73);
    expect(roundScore(73.5)).toBe(74);
    expect(roundScore(72.49)).toBe(72);
    expect(round1(78.95)).toBe(79);
    expect(round1(33.34)).toBe(33.3);
    // One-decimal halves go up too — never the half-even 2.45 → 2.4 the reference Python produced.
    expect(round1(2.45)).toBe(2.5);
    expect(round1(2.55)).toBe(2.6);
    expect(round1(66.65)).toBe(66.7);
    expect(round1(99.95)).toBe(100);
  });

  it('rounds two decimals half-up on the scaled double, and the named helpers share one primitive', () => {
    // Every input here was checked in Node and against `Decimal(str(x * 100)).quantize(1,
    // ROUND_HALF_UP) / 100` — the Python form the helper's doc comment prescribes.
    expect(round2(0.665)).toBe(0.67);
    expect(round2(0.675)).toBe(0.68);
    expect(round2(0.125)).toBe(0.13);
    expect(round2(0.625)).toBe(0.63);
    expect(round2(0.995)).toBe(1);
    expect(round2(3 / 7)).toBe(0.43);
    expect(round2(0.4)).toBe(0.4);
    // The float caveat, pinned so nobody "fixes" it with an epsilon: 1.005 × 100 is
    // 100.49999999999999 in IEEE-754, so the half-up rounding of the scaled double is 1.00.
    expect(round2(1.005)).toBe(1);
    expect(roundTo(72.5, 0)).toBe(73);
    expect(roundTo(2.45, 1)).toBe(2.5);
    expect(roundTo(0.665, 2)).toBe(0.67);
  });

  it('rounds a negative half toward +∞, as Math.round does — only Pearson r can get here', () => {
    expect(round2(-0.125)).toBe(-0.12);
    expect(round2(-0.375)).toBe(-0.37);
    expect(roundScore(-1.5)).toBe(-1);
    expect(round1(-0.15)).toBe(-0.1);
  });

  it('weights the four sub-scores 40/30/20/10 and nothing else', () => {
    expect(computeOverall({ accuracy: 90, completeness: 50, relevance: 90, clarity: 90 })).toBe(78);
    expect(computeOverall({ accuracy: 100, completeness: 0, relevance: 0, clarity: 0 })).toBe(40);
    expect(WEIGHTS.accuracy + WEIGHTS.completeness + WEIGHTS.relevance + WEIGHTS.clarity).toBeCloseTo(1, 12);
  });

  it('computes Completeness as the expected-concept coverage share, rounded once', () => {
    expect(
      completenessFromCoverage(
        concepts({ mandatoryRequired: [CONCEPT.dilution], bonusRequired: [CONCEPT.metric, CONCEPT.epa] }),
      ),
    ).toBe(100);
    expect(
      completenessFromCoverage(
        concepts({
          mandatoryRequired: [CONCEPT.dilution],
          bonusRequired: [CONCEPT.metric, CONCEPT.epa],
          bonusMissing: [CONCEPT.epa],
        }),
      ),
    ).toBe(67);
    // No expected concepts → no data → null, never 0 or 100.
    expect(completenessFromCoverage(undefined)).toBeNull();
    expect(
      completenessFromCoverage({
        mandatory: coverage([], []),
        expected: coverage([], []),
        materialIssue: false,
        materialIssueNote: null,
      }),
    ).toBeNull();
  });

  it('decides the rubric Result from the pass mark alone', () => {
    expect(statusFromScore(60)).toBe('Pass');
    expect(statusFromScore(59)).toBe('Fail');
    expect(statusFromScore(65, 70)).toBe('Fail');
    expect(statusFromScore(70, 70)).toBe('Pass');
    expect(DEFAULT_PASS_MARK).toBe(60);
    expect(STRICT_PASS_MARK).toBe(70);
  });
});

describe('computeReportMetrics — concept rules (B0-835)', () => {
  /**
   * The skill's own worked example: pre-gate 77 with one of two mandatory concepts missing. The
   * arithmetic is kept and reported, the ceiling makes the number an F, and the Result is Fail —
   * all three agreeing, which is the whole point of moving the score rather than the letter.
   */
  it('caps a pre-gate 77 with a must-have miss at 59 — F, Fail, and the lost Pass recorded', () => {
    const c = only([
      input('near-miss', 90, {
        score: score(90, { clarity: 80 }),
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution, CONCEPT.contactTime],
          mandatoryMissing: [CONCEPT.contactTime],
        }),
      }),
    ]);

    // Completeness: judged 90, capped at the 50% coverage (1 of 2 expected satisfied).
    expect(c.completenessJudged).toBe(90);
    expect(c.coveragePct).toBe(50);
    expect(c.completeness).toBe(50);
    expect(c.coverageApplied).toBe(true);
    // 0.4·90 + 0.3·50 + 0.2·90 + 0.1·80 = 36 + 15 + 18 + 8 = 77.
    expect(c.weighted).toBe(77);
    // The floor is withheld from a gated case; the ceiling runs last and outranks everything.
    expect(c.floorApplied).toBe(false);
    expect(c.preGateScore).toBe(77);
    expect(c.preGateGrade).toBe('C');
    expect(c.ceilingApplied).toBe(true);
    expect(c.ceiling).toBe(59);
    expect(c.overall).toBe(59);
    expect(c.grade).toBe('F');
    expect(c.rubricStatus).toBe('Fail');
    expect(c.status).toBe('Fail');
    expect(c.statusSource).toBe('minimal_gate');
    expect(c.ratingConstrained).toBe(true);
    // Judged against the PRE-GATE score: 77 would have passed, so the gate took a Pass away.
    expect(c.gateBlockedAPass).toBe(true);
    expect(c.conceptNote).toBe(
      `Failed on mandatory concepts: ${CONCEPT.contactTime}. A missing mandatory concept caps the score at 59/100 (grade F, Fail). Pre-Gate Content Score: 77/100 — the rubric arithmetic before the cap, shown as a diagnostic so a near miss stays distinguishable from a total one.`,
    );
  });

  it('leaves a pre-gate 17 where it is — constrained, but no Pass was taken away', () => {
    const c = only([
      input('total-miss', 20, {
        score: score(20, { completeness: 10, clarity: 20 }),
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution, CONCEPT.contactTime],
          mandatoryMissing: [CONCEPT.contactTime],
        }),
      }),
    ]);

    // Judged 10 already sits below the 50% coverage, so the cap does not bind.
    expect(c.completeness).toBe(10);
    expect(c.coverageApplied).toBe(false);
    // 0.4·20 + 0.3·10 + 0.2·20 + 0.1·20 = 8 + 3 + 4 + 2 = 17.
    expect(c.weighted).toBe(17);
    expect(c.preGateScore).toBe(17);
    // The ceiling applies to the case but never bound: 17 is already below 59.
    expect(c.ceilingApplied).toBe(false);
    expect(c.ceiling).toBeNull();
    expect(c.overall).toBe(17);
    expect(c.status).toBe('Fail');
    expect(c.statusSource).toBe('minimal_gate');
    expect(c.ratingConstrained).toBe(true);
    expect(c.gateBlockedAPass).toBe(false);
    expect(c.conceptNote).toBe(
      `Failed on mandatory concepts: ${CONCEPT.contactTime}. The response scored 17/100 on the rubric and failed there as well; the mandatory cap holds it at 17/100.`,
    );
  });

  it('floors a fully-covered answer weighting 62 up to 70, and says so on the run', () => {
    const metrics = computeReportMetrics([input('floored', 62)]);
    const c = metrics.perCase[0]!;

    expect(c.completeness).toBe(62);
    expect(c.weighted).toBe(62);
    expect(c.floorApplied).toBe(true);
    expect(c.floor).toBe(70);
    expect(c.overall).toBe(70);
    expect(c.grade).toBe('C');
    expect(c.preGateScore).toBe(70);
    expect(c.ceilingApplied).toBe(false);
    expect(c.status).toBe('Pass');
    // The rubric already passed at 70, so the automatic Pass had nothing to raise.
    expect(c.statusSource).toBe('rubric');
    expect(c.conceptNote).toBe(
      'All mandatory concepts satisfied, so the score was raised to the 70 floor. NOTE: the sub-scores placed this below a C despite full mandatory coverage — worth re-checking the sub-scores or the concept judgments.',
    );
    // A firing floor is a review signal, never a routine adjustment.
    expect(metrics.warnings).toHaveLength(1);
    expect(metrics.warnings[0]).toContain('below the 70 floor');
    expect(metrics.gateFloor.flooredIds).toEqual(['floored']);
  });

  it('withholds the floor when a material factual issue is flagged, and names it', () => {
    const note = `Stated 4 oz/gal; the label says 2 oz/gal (${CONCEPT.dilution}).`;
    const c = only([
      input('material', 62, {
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution],
          bonusRequired: [CONCEPT.metric],
          materialIssue: true,
          materialIssueNote: note,
        }),
      }),
    ]);

    expect(c.floorApplied).toBe(false);
    expect(c.floor).toBeNull();
    expect(c.overall).toBe(62);
    expect(c.grade).toBe('D');
    // Full expected coverage, but the material issue blocks the automatic Pass too.
    expect(c.autoPassTriggered).toBe(false);
    expect(c.autoPassBlocked).toBe(true);
    expect(c.statusSource).toBe('rubric');
    expect(c.materialIssue).toBe(true);
    expect(c.conceptNote).toBe(
      `Automatic Pass not applied: all expected concepts are present, but ${note}. The mandatory floor is also withheld for the same reason.`,
    );
  });

  it('caps a judged Completeness of 66 at the 40% coverage it earned, and shows both numbers', () => {
    const c = only([
      input('partial', 90, {
        score: score(90, { completeness: 66 }),
        concepts: concepts({
          mandatoryRequired: [],
          bonusRequired: [
            CONCEPT.dilution,
            CONCEPT.contactTime,
            CONCEPT.epa,
            CONCEPT.metric,
            'Rinse not required on food-contact surfaces',
          ],
          bonusMissing: [CONCEPT.epa, CONCEPT.metric, 'Rinse not required on food-contact surfaces'],
        }),
      }),
    ]);

    expect(c.coverage).toEqual({ satisfied: 2, required: 5 });
    expect(c.coveragePct).toBe(40);
    expect(c.completenessJudged).toBe(66);
    expect(c.completeness).toBe(40);
    expect(c.coverageApplied).toBe(true);
    // 0.4·90 + 0.3·40 + 0.2·90 + 0.1·90 = 36 + 12 + 18 + 9 = 75.
    expect(c.weighted).toBe(75);
    expect(c.overall).toBe(75);
    expect(c.conceptNote).toBe(
      "Completeness was set by expected-concept coverage (40%), which is below the grader's judged 66. Expected key concepts are part of the content grade: missing expected content reduces Completeness proportionally.",
    );
  });

  it('falls back to the coverage share for a pass whose grader emitted no Completeness', () => {
    const c = only([
      input('b0813-window', 90, {
        score: score(90, { completeness: null }),
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution],
          bonusRequired: [CONCEPT.metric, CONCEPT.epa],
          bonusMissing: [CONCEPT.epa],
        }),
      }),
    ]);

    expect(c.completenessJudged).toBeNull();
    expect(c.coveragePct).toBe(67);
    expect(c.completeness).toBe(67);
    // No judged value was moved, so this is not a capped case.
    expect(c.coverageApplied).toBe(false);
    // 0.4·90 + 0.3·67 + 0.2·90 + 0.1·90 = 36 + 20.1 + 18 + 9 = 83.1 → 83.
    expect(c.overall).toBe(83);
    expect(c.conceptNote).toBeNull();
  });

  it('raises a Result to Pass on full expected coverage, and warns that it did', () => {
    // The automatic Pass can only ever bite where the pass mark sits above the floor, or the floor
    // is off — otherwise full mandatory coverage has already lifted the score past the mark.
    const rules: ScoringRules = {
      ...DEFAULT_SCORING_RULES,
      minimalFloor: { ...DEFAULT_SCORING_RULES.minimalFloor, enabled: false },
    };
    const metrics = computeReportMetrics([input('auto', 62)], { passMark: 75, scoringRules: rules });
    const c = metrics.perCase[0]!;

    expect(c.floorApplied).toBe(false);
    expect(c.overall).toBe(62);
    expect(c.grade).toBe('D');
    expect(c.rubricStatus).toBe('Fail');
    expect(c.status).toBe('Pass');
    expect(c.statusSource).toBe('auto_pass');
    expect(c.autoPassTriggered).toBe(true);
    expect(c.conceptNote).toBe(
      'Automatic Pass: the response communicates all expected key concepts with no material factual issue (weighted score 62/100).',
    );
    expect(metrics.warnings).toHaveLength(1);
    expect(metrics.warnings[0]).toContain('automatic Pass');
    expect(metrics.concepts?.autoPassIds).toEqual(['auto']);
    expect(metrics.concepts?.autoPassChangedIds).toEqual(['auto']);
    // Rule 1 outranks Rule 2 either way: a gated case is never auto-passed.
    expect(metrics.concepts?.gatedIds).toEqual([]);
  });

  it('drops the ceiling with the gate: disabling one disables the other', () => {
    const rules: ScoringRules = {
      ...DEFAULT_SCORING_RULES,
      minimalGate: { enabled: false },
    };
    const metrics = computeReportMetrics(
      [
        input('gate-off', 90, {
          score: score(90, { clarity: 80 }),
          concepts: concepts({
            mandatoryRequired: [CONCEPT.dilution, CONCEPT.contactTime],
            mandatoryMissing: [CONCEPT.contactTime],
          }),
        }),
      ],
      { scoringRules: rules },
    );
    const c = metrics.perCase[0]!;

    expect(c.weighted).toBe(77);
    expect(c.ceilingApplied).toBe(false);
    expect(c.ceiling).toBeNull();
    expect(c.overall).toBe(77);
    expect(c.grade).toBe('C');
    expect(c.status).toBe('Pass');
    expect(c.statusSource).toBe('rubric');
    expect(c.ratingConstrained).toBe(false);
    expect(c.gateBlockedAPass).toBe(false);
    // Still reported on the case, and the report says the rules were not the defaults.
    expect(c.mandatoryMissing).toBe(true);
    expect(metrics.gateFloor.gateEnabled).toBe(false);
    expect(metrics.gateFloor.cappedIds).toEqual([]);
    expect(metrics.concepts?.gatedIds).toEqual(['gate-off']);
    expect(metrics.concepts?.preventedIds).toEqual([]);
  });

  it('turns the coverage cap off without touching the judged Completeness', () => {
    const rules: ScoringRules = {
      ...DEFAULT_SCORING_RULES,
      expectedCoverage: { enabled: false },
    };
    const metrics = computeReportMetrics(
      [
        input('holistic', 90, {
          score: score(90, { completeness: 66 }),
          concepts: RUBRIC_ONLY,
        }),
      ],
      { scoringRules: rules },
    );
    const c = metrics.perCase[0]!;

    expect(c.coveragePct).toBe(50);
    expect(c.completeness).toBe(66);
    expect(c.coverageApplied).toBe(false);
    // 0.4·90 + 0.3·66 + 0.2·90 + 0.1·90 = 36 + 19.8 + 18 + 9 = 82.8 → 83.
    expect(c.overall).toBe(83);
    expect(metrics.gateFloor.coverageEnabled).toBe(false);
    expect(metrics.gateFloor.coverageCappedIds).toEqual([]);
  });

  it('reports the rules in force and what each one actually did', () => {
    const metrics = computeReportMetrics([
      input('floored', 62),
      input('capped', 90, {
        score: score(90, { clarity: 80 }),
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution, CONCEPT.contactTime],
          mandatoryMissing: [CONCEPT.contactTime],
        }),
      }),
    ]);

    expect(metrics.scoringRules).toEqual(DEFAULT_SCORING_RULES);
    expect(metrics.gateFloor).toEqual({
      gateEnabled: true,
      floorEnabled: true,
      floorScore: 70,
      floorRespectsMaterialIssue: true,
      flooredIds: ['floored'],
      ceilingEnabled: true,
      ceilingScore: 59,
      cappedIds: ['capped'],
      coverageEnabled: true,
      coverageCappedIds: ['capped'],
    });
    expect(metrics.concepts?.gatedIds).toEqual(['capped']);
    expect(metrics.concepts?.preventedIds).toEqual(['capped']);
    expect(metrics.concepts?.autoPassIds).toEqual(['floored']);
    expect(metrics.concepts?.autoPassChangedIds).toEqual([]);
    expect(metrics.concepts?.autoPassBlockedIds).toEqual([]);
  });

  it('keeps the Pre-Gate Content Score out of every average, rate and rollup', () => {
    const metrics = computeReportMetrics([
      input('capped', 90, {
        score: score(90, { clarity: 80 }),
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution, CONCEPT.contactTime],
          mandatoryMissing: [CONCEPT.contactTime],
        }),
      }),
    ]);

    expect(metrics.perCase[0]!.preGateScore).toBe(77);
    // Every aggregate reads the FINAL 59, never the 77 diagnostic.
    expect(metrics.overall).toEqual<RateBlock>({
      n: 1,
      avg: 59,
      grade: 'F',
      pass: 0,
      fail: 1,
      passPct: 0,
      failPct: 100,
    });
    expect(metrics.highest).toEqual([{ id: 'capped', question: 'Question capped', overall: 59 }]);
    expect(metrics.lowest).toEqual([{ id: 'capped', question: 'Question capped', overall: 59 }]);
    expect(metrics.tiers[0]![1].avg).toBe(59);
    expect(metrics.categories[0]![1].avg).toBe(59);
  });

  it('marks a case with no expected concepts Unable to Evaluate, with the reason, rather than guessing', () => {
    const metrics = computeReportMetrics([
      input('no-concepts', 90, { concepts: undefined }),
      input('blank-cell', 90, {
        concepts: {
          mandatory: coverage([], []),
          expected: coverage([], []),
          materialIssue: false,
          materialIssueNote: null,
        },
      }),
      input('scored', 90),
    ]);

    expect(metrics.evaluated).toBe(1);
    expect(metrics.uteCount).toBe(2);
    expect(metrics.ute.map((u) => u.id)).toEqual(['no-concepts', 'blank-cell']);
    expect(metrics.ute[0]!.reason).toBe(NO_EXPECTED_CONCEPTS_UTE_REASON);
    // Excluded from every average — not folded in as a 0 or a 100.
    expect(metrics.overall.n).toBe(1);
    expect(metrics.overall.avg).toBe(90);
  });

  it('uses the pass mark it is given, and lists the cases that pass only under the current one', () => {
    // Rubric-only concepts, so the Pass/Fail line is the only thing deciding: overalls 78, 64, 40.
    const inputs = [
      input('a', 90, { concepts: RUBRIC_ONLY }),
      input('b', 70, { concepts: RUBRIC_ONLY }),
      input('c', 40, { concepts: RUBRIC_ONLY }),
    ];

    const at60 = computeReportMetrics(inputs);
    expect(at60.perCase.map((c) => c.overall)).toEqual([78, 64, 40]);
    expect(at60.passMark).toBe(60);
    expect(at60.strictPassMark).toBe(70);
    expect(at60.perCase.map((c) => c.status)).toEqual(['Pass', 'Pass', 'Fail']);
    expect(at60.passOnlyUnderCurrentMark).toEqual(['b']);
    expect(at60.perCase[1]!.passesOnlyUnderCurrentMark).toBe(true);

    const at70 = computeReportMetrics(inputs, { passMark: 70 });
    expect(at70.passMark).toBe(70);
    expect(at70.perCase.map((c) => c.status)).toEqual(['Pass', 'Fail', 'Fail']);
    expect(at70.passOnlyUnderCurrentMark).toEqual([]);
  });

  it('coerces a missing judged sub-score to 0 with a warning, never refusing the report', () => {
    const metrics = computeReportMetrics([
      input('flaky', 80, { score: score(80, { relevance: null }), concepts: RUBRIC_ONLY }),
    ]);
    expect(metrics.warnings[0]).toContain('missing sub-score(s) relevance');
    // 0.4·80 + 0.3·50 + 0.2·0 + 0.1·80 = 32 + 15 + 0 + 8 = 55.
    expect(metrics.perCase[0]!.overall).toBe(55);
  });
});

describe('computeReportMetrics — rate blocks (B0-812)', () => {
  it('counts pass and fail from the final Result, while avg and grade stay weighted', () => {
    // Rubric-only concepts throughout, so nothing but the arithmetic decides: 0.7·j + 0.3·min(j,50)
    // gives 74, 64 and 40.
    const metrics = computeReportMetrics([
      input('a', 84, { priorityRaw: 1, category: 'Dilution', concepts: RUBRIC_ONLY }),
      input('b', 70, { priorityRaw: 2, category: 'Disinfection', concepts: RUBRIC_ONLY }),
      input('c', 40, { priorityRaw: 2, category: 'Disinfection', concepts: RUBRIC_ONLY }),
    ]);

    expect(metrics.perCase.map((c) => c.overall)).toEqual([74, 64, 40]);
    expect(metrics.overall).toEqual<RateBlock>({
      n: 3,
      avg: 59.3,
      grade: 'F',
      pass: 2,
      fail: 1,
      passPct: 66.7,
      failPct: 33.3,
    });

    const tierOne = metrics.tiers.find(([name]) => name === 'Tier 1')![1];
    const tierTwo = metrics.tiers.find(([name]) => name === 'Tier 2')![1];
    expect(tierOne.pass).toBe(1);
    expect(tierTwo.pass).toBe(1);
    expect(tierTwo.fail).toBe(1);
    expect(tierTwo.avg).toBe(52);

    const disinfection = metrics.categories.find(([name]) => name === 'Disinfection')![1];
    expect(disinfection.passPct).toBe(50);
    expect(metrics.strongestCategory).toBe('Dilution');
    expect(metrics.weakestCategory).toBe('Disinfection');
  });
});

describe('computeReportMetrics — advisory notes stay advisory (B0-714)', () => {
  it('warns when a material issue is recorded but Accuracy is still ≥ 80', () => {
    const metrics = computeReportMetrics([
      input('sharp', 84, {
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution],
          bonusRequired: [CONCEPT.metric],
          materialIssue: true,
          materialIssueNote: `Wrong registration number quoted: not "${CONCEPT.epa}".`,
        }),
      }),
    ]);

    expect(metrics.warnings).toHaveLength(1);
    expect(metrics.warnings[0]).toContain('material factual issue');
    expect(metrics.warnings[0]).toContain('Accuracy is 84');
    // Advisory only — the floor was withheld, but the report still rendered.
    expect(metrics.perCase[0]!.floorApplied).toBe(false);
  });
});

describe('computeReportMetrics — concept rollup (B0-713 / B0-813)', () => {
  const RUN = [
    input('missing-mandatory', 84, {
      concepts: concepts({
        mandatoryRequired: [CONCEPT.dilution, CONCEPT.contactTime],
        mandatoryMissing: [CONCEPT.contactTime],
      }),
    }),
    input('full-coverage', 74, {
      concepts: concepts({
        mandatoryRequired: [CONCEPT.dilution],
        bonusRequired: [CONCEPT.metric],
      }),
    }),
    input('also-missing', 55, {
      concepts: concepts({
        mandatoryRequired: [CONCEPT.contactTime],
        mandatoryMissing: [CONCEPT.contactTime],
        bonusRequired: [CONCEPT.metric],
        bonusMissing: [CONCEPT.metric],
        materialIssue: true,
        materialIssueNote: 'Contact time stated as 5 minutes; the label requires 10.',
      }),
    }),
    input('no-concepts', 90, { concepts: undefined }),
  ];

  it('uses evaluated cases as the denominator — a concept-less case is UTE, not a zero', () => {
    const metrics = computeReportMetrics(RUN);
    const rollup = metrics.concepts!;

    expect(metrics.uteCount).toBe(1);
    expect(rollup.casesWithConcepts).toBe(3);
    expect(rollup.mandatory.casesSpecifying).toBe(3);
    expect(rollup.mandatory.casesSatisfyingAll).toBe(1);
    expect(rollup.mandatory.pct).toBe(33.3);
    expect(rollup.expected.casesSpecifying).toBe(3);
    expect(rollup.expected.casesSatisfyingAll).toBe(1);
  });

  it('reports the must-have misses and the material issues by case, verbatim', () => {
    const rollup = computeReportMetrics(RUN).concepts!;

    expect(rollup.missingMandatory.map((entry) => entry.id)).toEqual([
      'missing-mandatory',
      'also-missing',
    ]);
    expect(rollup.missingMandatory[0]!.missing).toEqual([CONCEPT.contactTime]);
    expect(rollup.materialIssues).toEqual([
      {
        id: 'also-missing',
        question: 'Question also-missing',
        note: 'Contact time stated as 5 minutes; the label requires 10.',
      },
    ]);
  });

  it('names the gated, prevented and automatic-Pass populations by id (B0-835)', () => {
    const rollup = computeReportMetrics(RUN).concepts!;

    // A must-have miss is the gated condition, so these are the same two cases.
    expect(rollup.gatedIds).toEqual(['missing-mandatory', 'also-missing']);
    // 'missing-mandatory' weighted 74 before the cap, so the gate took a Pass from it;
    // 'also-missing' weighted 39 and failed on the rubric as well.
    expect(rollup.preventedIds).toEqual(['missing-mandatory']);
    // Only 'full-coverage' has every expected concept and no material issue.
    expect(rollup.autoPassIds).toEqual(['full-coverage']);
    // Its rubric already passed at 74, so the automatic Pass changed nothing.
    expect(rollup.autoPassChangedIds).toEqual([]);
    expect(rollup.autoPassBlockedIds).toEqual([]);
  });

  it('names recurring missing concepts verbatim with the cases they span', () => {
    const rollup = computeReportMetrics(RUN).concepts!;

    expect(rollup.recurringMissing).toEqual([
      {
        concept: CONCEPT.contactTime,
        count: 2,
        caseIds: ['missing-mandatory', 'also-missing'],
      },
    ]);
  });

  it('returns no rollup at all when nothing could be evaluated', () => {
    expect(
      computeReportMetrics([
        input('a', 90, { concepts: undefined }),
        input('b', 50, { concepts: undefined }),
      ]).concepts,
    ).toBeNull();
  });
});

describe('computeReportMetrics — judged metrics rollup (B0-811)', () => {
  function judged(
    id: string,
    judgedScore: number,
    similarity: number | null,
    evalConfidence: number | null,
  ): ReportCaseInput {
    // Rubric-only concepts, so a Fail stays reachable: no gate, no floor, no automatic Pass.
    return input(id, judgedScore, {
      concepts: RUBRIC_ONLY,
      score: score(judgedScore, {
        similarity,
        similarityNote: similarity == null ? null : `sim note ${id}`,
        evalConfidence,
        confidenceNote: evalConfidence == null ? null : `conf note ${id}`,
      }),
    });
  }

  it('carries the judged metrics onto the case and never into the score', () => {
    const c = only([judged('a', 90, 0.42, 65)]);
    expect(c.similarity).toBe(0.42);
    expect(c.similarityNote).toBe('sim note a');
    expect(c.evalConfidence).toBe(65);
    expect(c.confidenceNote).toBe('conf note a');
    // Same overall as the same judged sub-scores with no judged metrics at all.
    expect(c.overall).toBe(only([input('b', 90, { concepts: RUBRIC_ONLY })]).overall);
  });

  it('reports the distributions, the two exception cells and the review queue', () => {
    const metrics = computeReportMetrics([
      judged('hi-fail', 40, 0.9, 55), // overall 40 Fail, similarity high → shape right, substance wrong
      judged('lo-pass', 90, 0.3, 95), // overall 78 Pass, similarity low → right by another route
      judged('mid', 70, 0.6, 72), // overall 64 Pass
      judged('lo-conf', 80, 0.8, 70), // overall 71 Pass, confidence at the line → queued
      judged('no-judged', 80, null, null),
    ]);
    const j = metrics.judged!;

    expect(j.nWithSimilarity).toBe(4);
    expect(j.nWithConfidence).toBe(4);
    expect(j.similarity).toEqual({ n: 4, avg: 0.65, median: 0.7, min: 0.3, max: 0.9 });
    expect(j.similarityBands).toEqual({ high: 2, mid: 1, low: 1 });
    // Below the reference's 5-case floor, no correlation is reported.
    expect(j.similarityScoreCorrelation).toBeNull();
    expect(j.highSimilarityFailures.map((c) => c.id)).toEqual(['hi-fail']);
    expect(j.lowSimilarityPasses.map((c) => c.id)).toEqual(['lo-pass']);
    expect(j.evalConfidence).toEqual({ n: 4, avg: 73, median: 71, min: 55, max: 95 });
    // Least confident first; at the line counts.
    expect(j.reviewQueue.map((c) => [c.id, c.evalConfidence, c.status])).toEqual([
      ['hi-fail', 55, 'Fail'],
      ['lo-conf', 70, 'Pass'],
    ]);
    expect(j.thresholds).toEqual({
      simHigh: 0.75,
      simLow: 0.4,
      lowConfidence: 70,
      highSimFail: 0.6,
      lowSimPass: 0.5,
      corrMinN: 5,
    });
  });

  it('reports the similarity-vs-score correlation once the sample is large enough', () => {
    const metrics = computeReportMetrics([
      judged('a', 40, 0.2, 80),
      judged('b', 50, 0.4, 80),
      judged('c', 60, 0.5, 80),
      judged('d', 70, 0.7, 80),
      judged('e', 90, 0.9, 80),
    ]);
    const r = metrics.judged!.similarityScoreCorrelation;
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(0.95);
  });

  it('honours the thresholds it is given', () => {
    const metrics = computeReportMetrics([judged('a', 80, 0.55, 75)], {
      judgedThresholds: { simHigh: 0.5, simLow: 0.2, lowConfidence: 80, highSimFail: 0.9, lowSimPass: 0.6, corrMinN: 2 },
    });
    const j = metrics.judged!;
    expect(j.similarityBands).toEqual({ high: 1, mid: 0, low: 0 });
    expect(j.lowSimilarityPasses.map((c) => c.id)).toEqual(['a']);
    expect(j.reviewQueue.map((c) => c.id)).toEqual(['a']);
  });

  it('omits the rollup when no case carries either metric', () => {
    expect(
      computeReportMetrics([
        input('a', 90, { concepts: RUBRIC_ONLY }),
        input('b', 50, { concepts: RUBRIC_ONLY }),
      ]).judged,
    ).toBeNull();
  });
});

describe('report invariants (B0-714 / B0-815 / B0-835)', () => {
  /** A clean case under the default rules: full coverage, nothing capped, nothing floored. */
  const PASSING: EvaluatedCase = {
    id: 'ok',
    question: 'Q',
    tier: 'Tier 1',
    priorityRaw: 1,
    category: 'Dilution',
    accuracy: 90,
    completeness: 90,
    relevance: 90,
    clarity: 90,
    overall: 90,
    grade: 'A',
    status: 'Pass',
    coverage: { satisfied: 2, required: 2 },
    completenessJudged: 90,
    coveragePct: 100,
    coverageApplied: false,
    weighted: 90,
    floor: null,
    floorApplied: false,
    preGateScore: 90,
    preGateGrade: 'A',
    ceiling: null,
    ceilingApplied: false,
    rubricStatus: 'Pass',
    statusSource: 'rubric',
    ratingConstrained: false,
    gateBlockedAPass: false,
    autoPassTriggered: true,
    autoPassBlocked: false,
    conceptNote: null,
    mandatoryMissing: false,
    materialIssue: false,
    passesOnlyUnderCurrentMark: false,
    concepts: FULL,
    similarity: 0.8,
    similarityNote: null,
    evalConfidence: 90,
    confidenceNote: null,
  };

  /** A gated case, correctly capped: 1 of 2 expected covered, weighted 78, ceiling 59, F / Fail. */
  const GATED_CONCEPTS = concepts({
    mandatoryRequired: [CONCEPT.dilution, CONCEPT.contactTime],
    mandatoryMissing: [CONCEPT.contactTime],
  });
  const GATED: EvaluatedCase = {
    ...PASSING,
    id: 'gated',
    completeness: 50,
    coverage: { satisfied: 1, required: 2 },
    coveragePct: 50,
    coverageApplied: true,
    weighted: 78,
    preGateScore: 78,
    preGateGrade: 'C',
    ceiling: 59,
    ceilingApplied: true,
    overall: 59,
    grade: 'F',
    rubricStatus: 'Fail',
    status: 'Fail',
    statusSource: 'minimal_gate',
    ratingConstrained: true,
    gateBlockedAPass: true,
    autoPassTriggered: false,
    mandatoryMissing: true,
    concepts: GATED_CONCEPTS,
  };

  const BLOCK: RateBlock = {
    n: 1,
    avg: 90,
    grade: 'A',
    pass: 1,
    fail: 0,
    passPct: 100,
    failPct: 0,
  };

  /** The same block with the one case failing, for corruptions that flip a Result. */
  const FAILING_BLOCK: RateBlock = { ...BLOCK, pass: 0, fail: 1, passPct: 0, failPct: 100 };

  function context(overrides: Partial<ReportInvariantContext> = {}): ReportInvariantContext {
    return {
      totalCases: 1,
      uteCount: 0,
      evaluated: [PASSING],
      overall: BLOCK,
      tiers: [['Tier 1', BLOCK]],
      categories: [['Dilution', BLOCK]],
      speed: null,
      weights: WEIGHTS,
      passMark: DEFAULT_PASS_MARK,
      scoringRules: DEFAULT_SCORING_RULES,
      ...overrides,
    };
  }

  /** One evaluated case, with the rate blocks moved to match a failing Result. */
  function failing(overrides: Partial<EvaluatedCase>): ReportInvariantContext {
    return context({
      evaluated: [{ ...PASSING, ...overrides }],
      overall: FAILING_BLOCK,
      tiers: [['Tier 1', FAILING_BLOCK]],
      categories: [['Dilution', FAILING_BLOCK]],
    });
  }

  /**
   * Every corrupted context below must fail **exactly** the named check, and fail it before any
   * other — `assertReportInvariants` stops at the first violation, so a corruption that also trips
   * an earlier check would silently test the wrong thing.
   */
  const CORRUPTIONS: Array<[string, ReportInvariantContext]> = [
    ['status_counts_sum_to_evaluated', context({ overall: { ...BLOCK, pass: 0, fail: 0 } })],
    ['evaluated_equals_total_minus_ute', context({ totalCases: 5 })],
    ['tier_counts_sum_to_evaluated', context({ tiers: [['Tier 1', { ...BLOCK, n: 7 }]] })],
    [
      'category_counts_sum_to_evaluated',
      context({ categories: [['Dilution', { ...BLOCK, n: 7 }]] }),
    ],
    [
      // Speed, a judged metric or a stray adjustment reaching the roll-up would land exactly here.
      'weighted_recomputes_from_sub_scores',
      context({ evaluated: [{ ...PASSING, weighted: 80 }] }),
    ],
    [
      // A score that is neither the weighted value nor a bound that fired.
      'overall_equals_weighted_or_floor_or_ceiling',
      context({ evaluated: [{ ...PASSING, overall: 80 }] }),
    ],
    [
      // The floor needs full must-have coverage and the ceiling needs a miss, so both is impossible.
      'floor_and_ceiling_never_both',
      context({
        evaluated: [
          {
            ...PASSING,
            floorApplied: true,
            floor: 95,
            ceilingApplied: true,
            ceiling: 59,
            overall: 59,
            grade: 'F',
            preGateScore: 95,
            preGateGrade: 'A',
            rubricStatus: 'Fail',
            status: 'Fail',
            statusSource: 'minimal_gate',
          },
        ],
        overall: FAILING_BLOCK,
        tiers: [['Tier 1', FAILING_BLOCK]],
        categories: [['Dilution', FAILING_BLOCK]],
      }),
    ],
    [
      // A "floor" below the weighted score, i.e. one that lowered it.
      'floor_only_raised',
      context({
        evaluated: [
          {
            ...PASSING,
            floorApplied: true,
            floor: 70,
            overall: 70,
            grade: 'C',
            preGateScore: 70,
            preGateGrade: 'C',
          },
        ],
      }),
    ],
    [
      // A "ceiling" above the weighted score, i.e. one that raised it.
      'ceiling_only_lowered',
      context({
        evaluated: [
          {
            ...PASSING,
            ceilingApplied: true,
            ceiling: 95,
            overall: 95,
            grade: 'A',
            preGateScore: 90,
            mandatoryMissing: true,
            concepts: GATED_CONCEPTS,
            completeness: 50,
            weighted: 78,
            coverage: { satisfied: 1, required: 2 },
            coveragePct: 50,
            coverageApplied: true,
          },
        ],
      }),
    ],
    [
      // The diagnostic lost: a capped case whose pre-gate score reads below the capped one.
      'pre_gate_preserved_where_capped',
      failing({ ...GATED, preGateScore: 50, preGateGrade: 'F' }),
    ],
    [
      // Coverage counts that are not the case's own concept block.
      'completeness_never_exceeds_coverage',
      context({ evaluated: [{ ...PASSING, coverage: { satisfied: 1, required: 2 } }] }),
    ],
    [
      // The cap raising a judged Completeness instead of lowering it.
      'coverage_cap_only_lowered_completeness',
      context({ evaluated: [{ ...PASSING, completenessJudged: 80 }] }),
    ],
    [
      // Completeness moved without the cap binding.
      'completeness_is_judged_where_cap_unbound',
      context({ evaluated: [{ ...PASSING, completenessJudged: 100 }] }),
    ],
    [
      // The floor protecting a case that missed a must-have concept.
      'no_floor_on_gated_case',
      context({
        evaluated: [
          {
            ...PASSING,
            accuracy: 40,
            relevance: 40,
            clarity: 40,
            completeness: 50,
            completenessJudged: 90,
            coverage: { satisfied: 1, required: 2 },
            coveragePct: 50,
            coverageApplied: true,
            weighted: 43,
            floorApplied: true,
            floor: 70,
            overall: 70,
            grade: 'C',
            preGateScore: 70,
            preGateGrade: 'C',
            mandatoryMissing: true,
            autoPassTriggered: false,
            concepts: GATED_CONCEPTS,
          },
        ],
      }),
    ],
    [
      // The floor protecting a wrong regulated value.
      'no_floor_on_material_issue',
      context({
        evaluated: [
          {
            ...PASSING,
            accuracy: 40,
            completeness: 40,
            completenessJudged: 40,
            relevance: 40,
            clarity: 40,
            weighted: 40,
            floorApplied: true,
            floor: 70,
            overall: 70,
            grade: 'C',
            preGateScore: 70,
            preGateGrade: 'C',
            materialIssue: true,
            autoPassTriggered: false,
            autoPassBlocked: true,
          },
        ],
      }),
    ],
    [
      // A Result off the pass mark with no named rule behind it.
      'status_matches_pass_mark_except_concept_rule',
      failing({ status: 'Fail' }),
    ],
    [
      // The rubric Result not recomputing from the score it was taken on.
      'rubric_status_recomputes_from_pass_mark',
      failing({ status: 'Fail', rubricStatus: 'Fail' }),
    ],
    [
      // The "B / Fail" row the whole model exists to make impossible.
      'score_grade_result_agree_except_auto_pass',
      failing({ status: 'Fail', statusSource: 'minimal_gate', ratingConstrained: true }),
    ],
    [
      // The pre-B0-835 behaviour: a must-have miss reported beside a Pass.
      'gated_cases_fail_when_gate_on',
      context({
        evaluated: [
          {
            ...GATED,
            overall: 78,
            grade: 'C',
            ceiling: null,
            ceilingApplied: false,
            rubricStatus: 'Pass',
            status: 'Pass',
            statusSource: 'rubric',
            ratingConstrained: false,
            gateBlockedAPass: false,
          },
        ],
      }),
    ],
    [
      // Gated and failing, but the letter does not say so.
      'gated_cases_capped_and_F_when_ceiling_on',
      failing({ ...GATED, grade: 'D' }),
    ],
    [
      // A qualified automatic Pass that did not produce a Pass.
      'auto_pass_triggered_is_pass',
      failing({
        accuracy: 40,
        completeness: 40,
        completenessJudged: 40,
        relevance: 40,
        clarity: 40,
        weighted: 40,
        overall: 40,
        grade: 'F',
        preGateScore: 40,
        preGateGrade: 'F',
        rubricStatus: 'Fail',
        status: 'Fail',
      }),
    ],
    [
      // A material issue blocked the automatic Pass, and it fired anyway.
      'auto_pass_blocked_never_auto_passed',
      context({
        evaluated: [
          {
            ...PASSING,
            materialIssue: true,
            autoPassTriggered: false,
            autoPassBlocked: true,
            statusSource: 'auto_pass',
          },
        ],
      }),
    ],
    [
      // The gate credited with removing a Pass from a case it never gated.
      'prevented_le_gated',
      context({ evaluated: [{ ...PASSING, gateBlockedAPass: true }] }),
    ],
    ['grade_recomputes_from_overall', context({ evaluated: [{ ...PASSING, grade: 'B' }] })],
    [
      'concept_coverage_partitions_required',
      context({
        evaluated: [
          {
            ...PASSING,
            concepts: {
              mandatory: {
                required: [CONCEPT.dilution, CONCEPT.contactTime],
                satisfied: [CONCEPT.dilution],
                missing: [],
              },
              expected: coverage([CONCEPT.dilution, CONCEPT.contactTime], []),
              materialIssue: false,
              materialIssueNote: null,
            },
          },
        ],
      }),
    ],
    [
      'mandatory_subset_of_expected',
      context({
        evaluated: [
          {
            ...PASSING,
            concepts: {
              mandatory: coverage([CONCEPT.epa], []),
              expected: coverage([CONCEPT.dilution, CONCEPT.metric], []),
              materialIssue: false,
              materialIssueNote: null,
            },
          },
        ],
      }),
    ],
    [
      // The flag the gate and the ceiling are keyed off, out of step with the concept block.
      'mandatory_miss_is_reported',
      context({
        evaluated: [
          {
            ...GATED,
            mandatoryMissing: false,
            overall: 78,
            grade: 'C',
            ceiling: null,
            ceilingApplied: false,
            rubricStatus: 'Pass',
            status: 'Pass',
            statusSource: 'rubric',
            ratingConstrained: false,
            gateBlockedAPass: false,
          },
        ],
      }),
    ],
    [
      'judged_metrics_in_range',
      context({ evaluated: [{ ...PASSING, similarity: 1.2 }] }),
    ],
    [
      // B0-717 — the reverse leak: a speed score that no timing supports. `basis` claims both
      // metrics while only one was measured, which is how an imputed timing would look.
      'speed_scores_match_timings',
      context({
        speed: {
          unit: 's',
          n: 1,
          metrics: { ttft: null, total: null },
          avgScore: 90,
          medianScore: 90,
          rating: 'Excellent',
          ratingDistribution: [],
          basisCounts: { combined: 1, ttftOnly: 0, totalOnly: 0 },
          weights: { ttft: 0.6, total: 0.4 },
          perCase: [
            {
              id: 'invented',
              ttft: null,
              total: { metric: 'total', seconds: 3.2, score: 95, band: 'good', weight: 1 },
              score: 95,
              rating: 'Excellent',
              basis: 'combined',
            },
          ],
        },
      }),
    ],
  ];

  it('covers every declared invariant with a corrupted input', () => {
    expect(CORRUPTIONS.map(([name]) => name).sort()).toEqual(
      REPORT_INVARIANTS.map((invariant) => invariant.name).sort(),
    );
  });

  it.each(CORRUPTIONS)('throws a named ReportInvariantError for %s', (name, corrupted) => {
    let thrown: unknown;
    try {
      assertReportInvariants(corrupted);
    } catch (error) {
      thrown = error;
    }

    expect(thrown, `${name} should have thrown`).toBeInstanceOf(ReportInvariantError);
    const error = thrown as ReportInvariantError;
    expect(error.check).toBe(name);
    // The stable prefix the report UI branches on to tell this apart from a transport failure.
    expect(error.message.startsWith('INVARIANT:')).toBe(true);
    expect(error.message).toContain(name);
  });

  it('passes a well-formed context', () => {
    expect(() => assertReportInvariants(context())).not.toThrow();
  });

  it('B0-1128 — mandatory_subset_of_expected compares phrases under normConcept identity', () => {
    // `requiredConcepts` dedups the expected union by normalized text, so a mandatory phrase that
    // differs from its expected twin only by punctuation/case is never appended to expected. The
    // invariant must use the same identity or every report for that item is refused
    // (test item f225e2d8, 2026-09-30).
    const punctuated = `${CONCEPT.dilution.toUpperCase()},`;
    expect(() =>
      assertReportInvariants(
        context({
          evaluated: [
            {
              ...PASSING,
              concepts: {
                mandatory: coverage([punctuated], []),
                expected: coverage([CONCEPT.dilution, CONCEPT.metric], []),
                materialIssue: false,
                materialIssueNote: null,
              },
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('passes a correctly gated, correctly capped case', () => {
    expect(() =>
      assertReportInvariants(
        context({
          evaluated: [GATED],
          overall: FAILING_BLOCK,
          tiers: [['Tier 1', FAILING_BLOCK]],
          categories: [['Dilution', FAILING_BLOCK]],
        }),
      ),
    ).not.toThrow();
  });

  it('lets a run with the gate switched off reconcile — a supported configuration', () => {
    const rules: ScoringRules = { ...DEFAULT_SCORING_RULES, minimalGate: { enabled: false } };
    // Gate off ⇒ ceiling off, so the gated case keeps its 78 and its Pass.
    const uncapped: EvaluatedCase = {
      ...GATED,
      overall: 78,
      grade: 'C',
      ceiling: null,
      ceilingApplied: false,
      rubricStatus: 'Pass',
      status: 'Pass',
      statusSource: 'rubric',
      ratingConstrained: false,
      gateBlockedAPass: false,
    };
    expect(() =>
      assertReportInvariants(context({ evaluated: [uncapped], scoringRules: rules })),
    ).not.toThrow();
  });

  it('refuses to compute metrics when a mandatory concept is not also an expected one', () => {
    expect(() =>
      computeReportMetrics([
        input('contradictory', 74, {
          concepts: {
            mandatory: coverage([CONCEPT.contactTime], []),
            expected: coverage([CONCEPT.dilution], []),
            materialIssue: false,
            materialIssueNote: null,
          },
        }),
      ]),
    ).toThrow(ReportInvariantError);
  });

  /**
   * The read path's severity. Generation refuses to *persist* numbers that contradict each other;
   * a report already stored is a historical record, and `loadReportData` re-derives it on every
   * page load. Throwing there would leave a stored report permanently unopenable behind a bare 500
   * (the read path has no catch, and the invariant panel reads `report_state.error`, which only
   * the generation path writes). So it degrades: render, and name the violation loudly.
   */
  describe("invariantSeverity: 'warn' (the read path)", () => {
    const contradictory = () =>
      input('contradictory', 74, {
        concepts: {
          mandatory: coverage([CONCEPT.contactTime], []),
          expected: coverage([CONCEPT.dilution], []),
          materialIssue: false,
          materialIssueNote: null,
        },
      });

    it('returns metrics instead of throwing, with the failing check named', () => {
      const metrics = computeReportMetrics([contradictory()], { invariantSeverity: 'warn' });

      expect(metrics.evaluated).toBe(1);
      expect(metrics.perCase).toHaveLength(1);
      const invariantWarnings = metrics.warnings.filter((w) => w.startsWith('INVARIANT:'));
      expect(invariantWarnings).toHaveLength(1);
      expect(invariantWarnings[0]).toContain('mandatory_subset_of_expected');
    });

    it('keeps the report readable — scores and grades still present alongside the warning', () => {
      const metrics = computeReportMetrics(
        [contradictory(), input('clean', 90)],
        { invariantSeverity: 'warn' },
      );
      expect(metrics.overall.n).toBe(2);
      // Both have full coverage, so Completeness is the judged value: 74 → C, 90 → A.
      expect(metrics.perCase.map((c) => c.grade)).toEqual(['C', 'A']);
      expect(metrics.warnings.some((w) => w.startsWith('INVARIANT:'))).toBe(true);
    });

    it('collects every violation, not just the first', () => {
      // Asserted against `collectInvariantFailures` directly: `computeReportMetrics` derives its
      // own rate blocks, so a context broken in two independent ways cannot be reached through it.
      // `assertReportInvariants` stops at the first failure — the read path must not, or a reader
      // fixes one contradiction and only discovers the next on the following page load.
      const broken: ReportInvariantContext = {
        ...context(),
        overall: { ...context().overall, pass: 99 },
        tiers: [['Tier 1', { ...context().overall, n: 99 }]],
      };
      const failures = collectInvariantFailures(broken);

      expect(failures.length).toBeGreaterThanOrEqual(2);
      expect(failures.join(' ')).toContain('status_counts_sum_to_evaluated');
      expect(failures.join(' ')).toContain('tier_counts_sum_to_evaluated');
      expect(failures.every((f) => f.startsWith('INVARIANT:'))).toBe(true);
    });

    it('still throws under the default severity, so generation is unaffected', () => {
      expect(() => computeReportMetrics([contradictory()])).toThrow(ReportInvariantError);
      expect(() =>
        computeReportMetrics([contradictory()], { invariantSeverity: 'throw' }),
      ).toThrow(ReportInvariantError);
    });

    it('adds no invariant warnings to a well-formed run', () => {
      const metrics = computeReportMetrics([input('clean', 90)], { invariantSeverity: 'warn' });
      expect(metrics.warnings.filter((w) => w.startsWith('INVARIANT:'))).toEqual([]);
    });
  });
});

/**
 * B0-717 — the speed aggregates.
 *
 * Two properties every test below is really defending: a missing timing is never imputed (no
 * zero, no average stood in for it), and nothing here can move a content score. The numeric
 * expectations are derived from `./speed-rules`'s published anchors, not from observed output.
 */
describe('computeReportMetrics — speed aggregates (B0-717)', () => {
  function timed(
    id: string,
    timings: { ttftSeconds?: number | null; latencySeconds?: number | null },
  ): ReportCaseInput {
    return input(id, 90, {
      ttftSeconds: timings.ttftSeconds ?? null,
      latencySeconds: timings.latencySeconds ?? null,
    });
  }

  it('scores a case from both timings and names the basis "combined"', () => {
    // ttft 1 s sits half way between the 0 s (100) and 2 s (90) anchors → 95.
    // total 3.2 s sits 3.2/5 of the way between 0 s (100) and 5 s (90) → 93.6.
    // Weighted 0.6/0.4 → 94.44, rounded once for display.
    const speed = computeReportMetrics([timed('both', { ttftSeconds: 1, latencySeconds: 3.2 })])
      .speed!;

    expect(speed.n).toBe(1);
    const c = speed.perCase[0];
    expect(c.basis).toBe('combined');
    expect(c.ttft).toEqual({ metric: 'ttft', seconds: 1, score: 95, band: 'good', weight: 0.6 });
    expect(c.total).toEqual({
      metric: 'total',
      seconds: 3.2,
      score: 93.6,
      band: 'good',
      weight: 0.4,
    });
    expect(c.score).toBe(94.4);
    expect(c.rating).toBe('Excellent');
    expect(speed.basisCounts).toEqual({ combined: 1, ttftOnly: 0, totalOnly: 0 });
  });

  it('renormalizes to the one metric measured rather than imputing the other', () => {
    const ttftOnly = computeReportMetrics([timed('ttft', { ttftSeconds: 1 })]).speed!.perCase[0];
    expect(ttftOnly.basis).toBe('ttft_only');
    expect(ttftOnly.total).toBeNull();
    // Weight renormalized to 1, so the score is the metric's own — not 0.6 of it, and not
    // dragged toward "Very slow" by a zero-filled total.
    expect(ttftOnly.ttft?.weight).toBe(1);
    expect(ttftOnly.score).toBe(95);
    expect(ttftOnly.rating).toBe('Excellent');

    const totalOnly = computeReportMetrics([timed('total', { latencySeconds: 3.2 })])
      .speed!.perCase[0];
    expect(totalOnly.basis).toBe('total_only');
    expect(totalOnly.ttft).toBeNull();
    expect(totalOnly.total?.weight).toBe(1);
    expect(totalOnly.score).toBe(93.6);
  });

  it('reports no speed block at all when neither timing was recorded', () => {
    const metrics = computeReportMetrics([input('untimed', 90)]);
    expect(metrics.speed).toBeNull();
    // …and the content side is untouched.
    expect(metrics.overall.avg).toBe(90);
    expect(metrics.perCase[0].grade).toBe('A');
  });

  it('suppresses P90 below the minimum sample size and reports it at the threshold', () => {
    const four = computeReportMetrics(
      [1, 2, 3, 4].map((s) => timed(`c${s}`, { latencySeconds: s })),
    ).speed!.metrics.total!;
    expect(four.n).toBe(4);
    expect(four.p90Seconds).toBeNull();
    expect(four.p90Label).toBe('n/a');

    const five = computeReportMetrics(
      [1, 2, 3, 4, 5].map((s) => timed(`c${s}`, { latencySeconds: s })),
    ).speed!.metrics.total!;
    expect(five.n).toBe(5);
    // Linear interpolation between ranks 3 and 4 at position 0.9 * (5 - 1) = 3.6.
    expect(five.p90Seconds).toBe(4.6);
    expect(five.p90Label).toBe('4.6s');
  });

  it('keeps a timed Unable-to-Evaluate case in the speed aggregates', () => {
    const ute: ReportCaseInput = {
      ...timed('ute', { ttftSeconds: 1, latencySeconds: 3.2 }),
      score: {
        ...score(0),
        unableToEvaluate: true,
        uteReason: 'No result recorded for this item in this run.',
      },
    };
    const metrics = computeReportMetrics([ute, timed('graded', { latencySeconds: 3.2 })]);

    // Excluded from every content number…
    expect(metrics.evaluated).toBe(1);
    expect(metrics.uteCount).toBe(1);
    expect(metrics.overall.n).toBe(1);
    // …and still present in the speed ones: the two flags are independent in both directions.
    expect(metrics.speed!.n).toBe(2);
    expect(metrics.speed!.perCase.map((c) => c.id)).toEqual(['ute', 'graded']);
    expect(metrics.speed!.metrics.total!.n).toBe(2);
    expect(metrics.speed!.metrics.ttft!.n).toBe(1);
  });

  it('aggregates per metric, with the thresholds actually in force', () => {
    const speed = computeReportMetrics([
      timed('fast', { ttftSeconds: 1, latencySeconds: 3.2 }),
      timed('mid', { ttftSeconds: 4, latencySeconds: 8 }),
      timed('slow', { ttftSeconds: 12, latencySeconds: 25 }),
    ]).speed!;

    const total = speed.metrics.total!;
    expect(total.label).toBe('Total response time');
    expect(total.minSeconds).toBe(3.2);
    expect(total.maxSeconds).toBe(25);
    expect(total.medianSeconds).toBe(8);
    expect(total.bands).toEqual({ good: 1, acceptable: 1, slow: 1 });
    // Straight off SPEED_THRESHOLDS — the report prints the numbers it graded with.
    expect(total.thresholds).toEqual({ good: 5, acceptable: 10, poor: 20, floor: 40 });
    expect(total.fastest[0]).toEqual({ id: 'fast', seconds: 3.2 });
    expect(total.slowest[0]).toEqual({ id: 'slow', seconds: 25 });

    expect(speed.metrics.ttft!.bands).toEqual({ good: 1, acceptable: 1, slow: 1 });
    expect(speed.ratingDistribution.map((r) => r.rating)).toEqual([
      'Excellent',
      'Good',
      'Acceptable',
      'Slow',
      'Very slow',
    ]);
    expect(speed.ratingDistribution.reduce((sum, r) => sum + r.count, 0)).toBe(3);
    expect(speed.rating).toBe(speedRating(speed.avgScore));
  });

  it('raises the implausible-seconds advisory with the case id, and still scores the value', () => {
    const metrics = computeReportMetrics([timed('unit-bug', { latencySeconds: 1826 })], {
      invariantSeverity: 'warn',
    });

    const advisory = metrics.warnings.find((w) => w.includes('plausibility ceiling'));
    expect(advisory).toBeDefined();
    expect(advisory!.startsWith('unit-bug: ')).toBe(true);
    // Names the likely-correct converted value so the reader can confirm the unit mix-up.
    expect(advisory).toContain('1826 ms = 1.8s');
    // Scored as given — this module never rewrites a measurement it was handed.
    expect(metrics.speed!.perCase[0].total?.seconds).toBe(1826);
    expect(metrics.speed!.perCase[0].score).toBe(0);
  });

  it('leaves every content score identical whether or not timings are present', () => {
    const withoutTimings = computeReportMetrics([
      input('a', 84, { concepts: RUBRIC_ONLY }),
      input('b', 62, { concepts: RUBRIC_ONLY }),
    ]);
    const withTimings = computeReportMetrics([
      input('a', 84, { concepts: RUBRIC_ONLY, ttftSeconds: 1, latencySeconds: 3.2 }),
      input('b', 62, { concepts: RUBRIC_ONLY, latencySeconds: 30 }),
    ]);

    expect(withTimings.perCase).toEqual(withoutTimings.perCase);
    expect(withTimings.overall).toEqual(withoutTimings.overall);
    expect(withoutTimings.speed).toBeNull();
    expect(withTimings.speed).not.toBeNull();
  });
});
