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
  round1,
  statusFromScore,
  WEIGHTS,
  type EvaluatedCase,
  type RateBlock,
  type ReportCaseInput,
} from './metrics';
import type { CaseScore } from './schemas';
import { DEFAULT_PASS_MARK, STRICT_PASS_MARK } from './scoring-config';
import { speedRating } from './speed-rules';

/**
 * B0-812 / B0-813 / B0-815 — pure-math scoring and the structural invariants that pin it.
 *
 * Three things these tests exist to defend:
 *
 * 1. **Completeness is computed, never judged.** It is the expected-concept coverage share, and a
 *    case with no expected concepts is Unable to Evaluate — never a guessed number.
 * 2. **Nothing moves the score or the Result but the arithmetic.** A missing must-have concept and a
 *    material issue are *reported* on the case; the overall is the weighted sum and the Result is
 *    the pass mark, full stop.
 * 3. **Concept phrases are regulated free text.** The fixtures carry real dilution ratios, contact
 *    times, ppm and EPA registration numbers, asserted back byte-for-byte.
 */

const CONCEPT = {
  dilution: 'Dilute 1:64 (2 oz/gal)',
  contactTime: '10 minutes contact time at 600 ppm active quat',
  epa: 'EPA Reg. No. 6836-140-4170',
  metric: 'Metric equivalent 15.6 mL/L',
} as const;

/** Judged sub-scores only — the grader no longer emits Completeness. */
function score(judged: number, partial: Partial<CaseScore> = {}): CaseScore {
  return {
    unableToEvaluate: false,
    uteReason: null,
    accuracy: judged,
    completeness: null,
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
 * Every expected concept satisfied → Completeness 100, so with equal judged sub-scores `j` the
 * overall is `0.7·j + 30` (e.g. 90 → 93, 50 → 65, 40 → 58).
 */
const FULL = concepts({ mandatoryRequired: [CONCEPT.dilution], bonusRequired: [CONCEPT.metric] });

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

describe('arithmetic primitives (B0-813 / B0-814)', () => {
  it('rounds half-up, in one place', () => {
    expect(roundScore(72.5)).toBe(73);
    expect(roundScore(73.5)).toBe(74);
    expect(roundScore(72.49)).toBe(72);
    expect(round1(78.95)).toBe(79);
    expect(round1(33.34)).toBe(33.3);
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

  it('decides the Result from the pass mark alone', () => {
    expect(statusFromScore(60)).toBe('Pass');
    expect(statusFromScore(59)).toBe('Fail');
    expect(statusFromScore(65, 70)).toBe('Fail');
    expect(statusFromScore(70, 70)).toBe('Pass');
    expect(DEFAULT_PASS_MARK).toBe(60);
    expect(STRICT_PASS_MARK).toBe(70);
  });
});

describe('computeReportMetrics — pure-math scoring (B0-813)', () => {
  it('scores 90 / — / 90 / 90 with 2 of 4 expected satisfied as 76, C, Pass — and reports the must-have miss', () => {
    const c = only([
      input('half', 90, {
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution, CONCEPT.contactTime],
          mandatoryMissing: [CONCEPT.contactTime],
          bonusRequired: [CONCEPT.metric, CONCEPT.epa],
          bonusMissing: [CONCEPT.epa],
        }),
      }),
    ]);

    expect(c.completeness).toBe(50);
    expect(c.coverage).toEqual({ satisfied: 2, required: 4 });
    // 0.4·90 + 0.3·50 + 0.2·90 + 0.1·90 = 78 — hmm: 36 + 15 + 18 + 9 = 78.
    expect(c.overall).toBe(78);
    expect(c.grade).toBe('C');
    expect(c.status).toBe('Pass');
    // The miss is a reported fact and changed nothing above.
    expect(c.mandatoryMissing).toBe(true);
    expect(c.concepts.mandatory.missing).toEqual([CONCEPT.contactTime]);
    expect(c.passesOnlyUnderCurrentMark).toBe(false);
  });

  it('never caps, floors or gates: a missing must-have on an otherwise strong answer still reads B / Pass', () => {
    const c = only([
      input('gated-before', 90, {
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution, CONCEPT.contactTime],
          mandatoryMissing: [CONCEPT.contactTime],
        }),
      }),
    ]);

    // Completeness 50 from 1 of 2 expected → 36 + 15 + 18 + 9 = 78.
    expect(c.completeness).toBe(50);
    expect(c.overall).toBe(78);
    expect(c.status).toBe('Pass');
    expect(c.mandatoryMissing).toBe(true);
  });

  it('scores 60 / — / 60 / 60 with full coverage as 72, C, Pass — no floor involved', () => {
    const c = only([input('full', 60)]);
    expect(c.completeness).toBe(100);
    expect(c.overall).toBe(72);
    expect(c.grade).toBe('C');
    expect(c.status).toBe('Pass');
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
    expect(metrics.overall.avg).toBe(93);
  });

  it('ignores a persisted judged Completeness entirely — coverage is the only source', () => {
    const c = only([input('legacy-judged', 90, { score: score(90, { completeness: 12 }) })]);
    expect(c.completeness).toBe(100);
    expect(c.overall).toBe(93);
  });

  it('reports a material issue on the case without touching the score', () => {
    const note = `Stated 4 oz/gal; the label says 2 oz/gal (${CONCEPT.dilution}).`;
    const c = only([
      input('material', 90, {
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution],
          materialIssue: true,
          materialIssueNote: note,
        }),
      }),
    ]);

    expect(c.materialIssue).toBe(true);
    expect(c.concepts.materialIssueNote).toBe(note);
    expect(c.overall).toBe(93);
    expect(c.status).toBe('Pass');
  });

  it('uses the pass mark it is given, and lists the cases that pass only under the current one', () => {
    // Overalls 93, 65 and 58.
    const inputs = [input('a', 90), input('b', 50), input('c', 40)];

    const at60 = computeReportMetrics(inputs);
    expect(at60.perCase.map((c) => c.overall)).toEqual([93, 65, 58]);
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
    const metrics = computeReportMetrics([input('flaky', 80, { score: score(80, { relevance: null }) })]);
    expect(metrics.warnings[0]).toContain('missing sub-score(s) relevance');
    // 0.4·80 + 0.3·100 + 0.2·0 + 0.1·80 = 70.
    expect(metrics.perCase[0]!.overall).toBe(70);
  });
});

describe('computeReportMetrics — rate blocks (B0-812)', () => {
  it('counts pass and fail only, from the Result, while avg and grade stay weighted', () => {
    // Overalls 89, 73 and 58.
    const metrics = computeReportMetrics([
      input('a', 84, { priorityRaw: 1, category: 'Dilution' }),
      input('b', 62, { priorityRaw: 2, category: 'Disinfection' }),
      input('c', 40, { priorityRaw: 2, category: 'Disinfection' }),
    ]);

    expect(metrics.perCase.map((c) => c.overall)).toEqual([89, 73, 58]);
    expect(metrics.overall).toEqual<RateBlock>({
      n: 3,
      avg: 73.3,
      grade: 'C',
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
    expect(tierTwo.avg).toBe(65.5);

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
          materialIssue: true,
          materialIssueNote: `Wrong registration number quoted: not "${CONCEPT.epa}".`,
        }),
      }),
    ]);

    expect(metrics.warnings).toHaveLength(1);
    expect(metrics.warnings[0]).toContain('material factual issue');
    expect(metrics.warnings[0]).toContain('Accuracy is 84');
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
    return input(id, judgedScore, {
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
    expect(c.overall).toBe(only([input('b', 90)]).overall);
  });

  it('reports the distributions, the two exception cells and the review queue', () => {
    const metrics = computeReportMetrics([
      judged('hi-fail', 40, 0.9, 55), // overall 58 Fail, similarity high → shape right, substance wrong
      judged('lo-pass', 90, 0.3, 95), // overall 93 Pass, similarity low → right by another route
      judged('mid', 70, 0.6, 72), // overall 79 Pass
      judged('lo-conf', 80, 0.8, 70), // overall 86 Pass, confidence at the line → queued
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
    expect(computeReportMetrics([input('a', 90), input('b', 50)]).judged).toBeNull();
  });
});

describe('report invariants (B0-714 / B0-815)', () => {
  const PASSING: EvaluatedCase = {
    id: 'ok',
    question: 'Q',
    tier: 'Tier 1',
    priorityRaw: 1,
    category: 'Dilution',
    accuracy: 90,
    completeness: 100,
    relevance: 90,
    clarity: 90,
    overall: 93,
    grade: 'A',
    status: 'Pass',
    coverage: { satisfied: 2, required: 2 },
    mandatoryMissing: false,
    materialIssue: false,
    passesOnlyUnderCurrentMark: false,
    concepts: FULL,
    similarity: 0.8,
    similarityNote: null,
    evalConfidence: 90,
    confidenceNote: null,
  };

  const BLOCK: RateBlock = {
    n: 1,
    avg: 93,
    grade: 'A',
    pass: 1,
    fail: 0,
    passPct: 100,
    failPct: 0,
  };

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
      ...overrides,
    };
  }

  /** Every corrupted context below must fail exactly the named check. */
  const CORRUPTIONS: Array<[string, ReportInvariantContext]> = [
    ['status_counts_sum_to_evaluated', context({ overall: { ...BLOCK, pass: 0, fail: 0 } })],
    ['evaluated_equals_total_minus_ute', context({ totalCases: 5 })],
    ['tier_counts_sum_to_evaluated', context({ tiers: [['Tier 1', { ...BLOCK, n: 7 }]] })],
    [
      'category_counts_sum_to_evaluated',
      context({ categories: [['Dilution', { ...BLOCK, n: 7 }]] }),
    ],
    [
      // A floor or a cap would show up exactly here: the sub-scores no longer reproduce the overall.
      'overall_recomputes_from_sub_scores',
      context({ evaluated: [{ ...PASSING, overall: 70 }] }),
    ],
    [
      // A judged Completeness that is not the coverage share.
      'completeness_equals_expected_coverage',
      context({ evaluated: [{ ...PASSING, completeness: 80, overall: 87, grade: 'B' }] }),
    ],
    [
      'status_matches_pass_mark',
      context({
        evaluated: [{ ...PASSING, status: 'Fail' }],
        overall: { ...BLOCK, pass: 0, fail: 1, passPct: 0, failPct: 100 },
        tiers: [['Tier 1', { ...BLOCK, pass: 0, fail: 1 }]],
        categories: [['Dilution', { ...BLOCK, pass: 0, fail: 1 }]],
      }),
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
      'mandatory_miss_is_reported',
      context({
        evaluated: [
          {
            ...PASSING,
            completeness: 50,
            overall: 78,
            grade: 'C',
            coverage: { satisfied: 1, required: 2 },
            mandatoryMissing: false,
            concepts: concepts({
              mandatoryRequired: [CONCEPT.dilution, CONCEPT.contactTime],
              mandatoryMissing: [CONCEPT.contactTime],
            }),
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
      // 0.7·74 + 30 = 82 → B; 0.7·90 + 30 = 93 → A.
      expect(metrics.perCase.map((c) => c.grade)).toEqual(['B', 'A']);
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
    expect(metrics.overall.avg).toBe(93);
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
    const withoutTimings = computeReportMetrics([input('a', 84), input('b', 62)]);
    const withTimings = computeReportMetrics([
      input('a', 84, { ttftSeconds: 1, latencySeconds: 3.2 }),
      input('b', 62, { latencySeconds: 30 }),
    ]);

    expect(withTimings.perCase).toEqual(withoutTimings.perCase);
    expect(withTimings.overall).toEqual(withoutTimings.overall);
    expect(withoutTimings.speed).toBeNull();
    expect(withTimings.speed).not.toBeNull();
  });
});
