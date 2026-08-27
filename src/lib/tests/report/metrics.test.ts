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
  applyConceptRules,
  computeReportMetrics,
  WEIGHTS,
  type EvaluatedCase,
  type RateBlock,
  type ReportCaseInput,
} from './metrics';
import type { CaseScore } from './schemas';
import { speedRating } from './speed-rules';

/**
 * B0-712 / B0-714 — the concept rating rules and the structural invariants.
 *
 * Two things these tests exist to pin down:
 *
 * 1. **The grade never moves.** Every rule below can change a case's Result and nothing else. If a
 *    test ever has to update an `accuracy`/`overall`/`grade` expectation because a concept rule
 *    changed, the rule is wrong, not the test.
 * 2. **Concept phrases are regulated free text.** The fixtures carry real dilution ratios, contact
 *    times, ppm and EPA registration numbers, and are asserted back byte-for-byte — so any
 *    parsing, rounding, unit conversion or re-punctuation shows up here as a failure.
 */

const CONCEPT = {
  dilution: 'Dilute 1:64 (2 oz/gal)',
  contactTime: '10 minutes contact time at 600 ppm active quat',
  epa: 'EPA Reg. No. 6836-140-4170',
  metric: 'Metric equivalent 15.6 mL/L',
} as const;

function score(overall: number, partial: Partial<CaseScore> = {}): CaseScore {
  // Equal sub-scores make the weighted roll-up equal to `overall` exactly (0.4+0.3+0.2+0.1 = 1).
  return {
    unableToEvaluate: false,
    uteReason: null,
    accuracy: overall,
    completeness: overall,
    relevance: overall,
    clarity: overall,
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
    // Mandatory ⊆ expected by construction, exactly as `deriveCaseConcepts` builds it.
    expected: coverage(
      [...params.mandatoryRequired, ...bonusRequired],
      [...mandatoryMissing, ...bonusMissing],
    ),
    materialIssue: params.materialIssue ?? false,
    materialIssueNote: params.materialIssueNote ?? null,
  };
}

function input(
  id: string,
  overall: number,
  extra: Partial<ReportCaseInput> = {},
): ReportCaseInput {
  return {
    testItemId: id,
    question: `Question ${id}`,
    priorityRaw: 1,
    category: 'Dilution',
    score: score(overall),
    latencySeconds: null,
    ttftSeconds: null,
    ...extra,
  };
}

function only(inputs: ReportCaseInput[]): EvaluatedCase {
  const metrics = computeReportMetrics(inputs);
  expect(metrics.perCase).toHaveLength(1);
  return metrics.perCase[0]!;
}

describe('computeReportMetrics — concept rating rules (B0-712)', () => {
  it('caps a scored-84 case to Partial Pass when a mandatory concept is missing, keeping grade B', () => {
    const c = only([
      input('gated', 84, {
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution, CONCEPT.contactTime],
          mandatoryMissing: [CONCEPT.contactTime],
        }),
      }),
    ]);

    expect(c.overall).toBe(84);
    expect(c.grade).toBe('B');
    expect(c.rubricStatus).toBe('Pass');
    expect(c.status).toBe('Partial Pass');
    expect(c.statusSource).toBe('minimal_gate');
    expect(c.ratingConstrained).toBe(true);
    expect(c.gateBlockedAPass).toBe(true);
    // The concept phrase survives verbatim — no parsing of "600 ppm", no re-punctuation.
    expect(c.concepts!.mandatory.missing).toEqual([CONCEPT.contactTime]);
  });

  it('raises a scored-74 case to Pass on full expected coverage, keeping grade C', () => {
    const c = only([
      input('raised', 74, {
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution],
          bonusRequired: [CONCEPT.metric],
        }),
      }),
    ]);

    expect(c.overall).toBe(74);
    expect(c.grade).toBe('C');
    expect(c.rubricStatus).toBe('Partial Pass');
    expect(c.status).toBe('Pass');
    expect(c.statusSource).toBe('auto_pass');
    expect(c.autoPassTriggered).toBe(true);
    expect(c.autoPassBlocked).toBe(false);
    expect(c.ratingConstrained).toBe(false);
  });

  it('applies the gate last, so it wins over an automatic Pass', () => {
    /**
     * Deliberately contradictory coverage — full expected coverage *and* a missing mandatory
     * concept — which real data cannot produce (mandatory ⊆ expected). Exercised through the pure
     * rule function because `computeReportMetrics` refuses such a case outright: B0-714's
     * `auto_pass_is_rated_pass` invariant is exactly the detector for this contradiction (asserted
     * separately below). What matters here is the ordering: the cap runs after the raise.
     */
    const ruled = applyConceptRules('Partial Pass', {
      mandatory: coverage([CONCEPT.contactTime], [CONCEPT.contactTime]),
      expected: coverage([CONCEPT.contactTime], []),
      materialIssue: false,
      materialIssueNote: null,
    });

    expect(ruled.autoPassTriggered).toBe(true);
    expect(ruled.status).toBe('Partial Pass');
    expect(ruled.statusSource).toBe('minimal_gate');
    expect(ruled.gateBlockedAPass).toBe(true);
    expect(ruled.ratingConstrained).toBe(true);
  });

  it('withholds the automatic Pass when a material factual issue is on the record', () => {
    const note = `Exact-match check failed on a regulated value: "${CONCEPT.epa}".`;
    const c = only([
      input('material', 74, {
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution],
          bonusRequired: [CONCEPT.epa],
          materialIssue: true,
          materialIssueNote: note,
        }),
      }),
    ]);

    expect(c.status).toBe('Partial Pass');
    expect(c.statusSource).toBe('rubric');
    expect(c.autoPassTriggered).toBe(false);
    expect(c.autoPassBlocked).toBe(true);
    expect(c.concepts!.materialIssueNote).toBe(note);
  });

  it('marks every gated case as ratingConstrained, including one already below Pass', () => {
    const c = only([
      input('already-failing', 42, {
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution],
          mandatoryMissing: [CONCEPT.dilution],
        }),
      }),
    ]);

    expect(c.rubricStatus).toBe('Fail');
    expect(c.status).toBe('Fail');
    // The gate touched the case (constrained), but it did not cost a Pass (blocked) — different
    // questions, and neither answer may stand in for the other.
    expect(c.ratingConstrained).toBe(true);
    expect(c.gateBlockedAPass).toBe(false);
    expect(c.statusSource).toBe('rubric');
  });

  it('leaves a case with no concept block exactly as it was before the concept rules existed', () => {
    const c = only([input('legacy', 84)]);

    expect(c.concepts).toBeNull();
    expect(c.rubricStatus).toBe('Pass');
    expect(c.status).toBe('Pass');
    expect(c.statusSource).toBe('rubric');
    expect(c.ratingConstrained).toBe(false);
    expect(c.gateBlockedAPass).toBe(false);
    expect(c.autoPassTriggered).toBe(false);
    expect(c.autoPassBlocked).toBe(false);
  });

  it('never lets a concept rule touch the sub-scores, the roll-up or the grade', () => {
    const plain = only([input('plain', 84)]);
    const gated = only([
      input('gated', 84, {
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution],
          mandatoryMissing: [CONCEPT.dilution],
        }),
      }),
    ]);

    for (const key of ['accuracy', 'completeness', 'relevance', 'clarity', 'overall', 'grade'] as const) {
      expect(gated[key], `${key} must be untouched by the gate`).toEqual(plain[key]);
    }
    expect(gated.status).not.toBe(plain.status);
  });
});

describe('computeReportMetrics — rate blocks count by final status (B0-712)', () => {
  it('counts pass/partial/fail from the final status while avg and grade stay weighted', () => {
    const metrics = computeReportMetrics([
      // Scores 84 (Pass on the rubric) but gated down to Partial Pass.
      input('a', 84, {
        priorityRaw: 1,
        category: 'Dilution',
        concepts: concepts({
          mandatoryRequired: [CONCEPT.contactTime],
          mandatoryMissing: [CONCEPT.contactTime],
        }),
      }),
      // Scores 74 (Partial Pass on the rubric) but raised to Pass on full expected coverage.
      input('b', 74, {
        priorityRaw: 2,
        category: 'Disinfection',
        concepts: concepts({ mandatoryRequired: [CONCEPT.dilution] }),
      }),
    ]);

    expect(metrics.overall.pass).toBe(1);
    expect(metrics.overall.partial).toBe(1);
    expect(metrics.overall.fail).toBe(0);
    // (84 + 74) / 2 = 79 — from the scores, not the statuses.
    expect(metrics.overall.avg).toBe(79);
    expect(metrics.overall.grade).toBe('C');

    const tierOne = metrics.tiers.find(([name]) => name === 'Tier 1')![1];
    const tierTwo = metrics.tiers.find(([name]) => name === 'Tier 2')![1];
    expect(tierOne.pass).toBe(0);
    expect(tierOne.partial).toBe(1);
    expect(tierOne.avg).toBe(84);
    expect(tierTwo.pass).toBe(1);
    expect(tierTwo.avg).toBe(74);

    const dilution = metrics.categories.find(([name]) => name === 'Dilution')![1];
    const disinfection = metrics.categories.find(([name]) => name === 'Disinfection')![1];
    expect(dilution.pass).toBe(0);
    expect(dilution.partial).toBe(1);
    expect(dilution.passPct).toBe(0);
    expect(disinfection.pass).toBe(1);
    expect(disinfection.passPct).toBe(100);
  });
});

describe('computeReportMetrics — advisory notes stay advisory (B0-714)', () => {
  it('warns when a material issue is recorded but Accuracy is still ≥ 80', () => {
    const metrics = computeReportMetrics([
      input('sharp', 84, {
        concepts: concepts({
          mandatoryRequired: [CONCEPT.dilution],
          materialIssue: true,
          materialIssueNote: `Exact-match check failed on a regulated value: "${CONCEPT.epa}".`,
        }),
      }),
    ]);

    expect(metrics.warnings).toHaveLength(1);
    expect(metrics.warnings[0]).toContain('material factual issue');
    expect(metrics.warnings[0]).toContain('Accuracy is 84');
  });

  it('keeps the missing sub-score note advisory rather than refusing the report', () => {
    const metrics = computeReportMetrics([
      input('flaky', 0, { score: score(80, { relevance: null }) }),
    ]);

    expect(metrics.warnings[0]).toContain('missing sub-score(s) relevance');
    expect(metrics.evaluated).toBe(1);
    // Relevance coerced to 0: 0.4*80 + 0.3*80 + 0.2*0 + 0.1*80 = 64.
    expect(metrics.perCase[0]!.overall).toBe(64);
  });
});

describe('computeReportMetrics — concept rollup (B0-713)', () => {
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
      }),
    }),
    input('no-concepts', 90),
  ];

  it('uses cases that specify concepts as the denominator, never the whole run', () => {
    const rollup = computeReportMetrics(RUN).concepts!;

    expect(rollup.casesWithConcepts).toBe(3);
    expect(rollup.mandatory.casesSpecifying).toBe(3);
    expect(rollup.mandatory.casesSatisfyingAll).toBe(1);
    expect(rollup.mandatory.pct).toBe(33.3);
    expect(rollup.expected.casesSpecifying).toBe(3);
    expect(rollup.expected.casesSatisfyingAll).toBe(1);
  });

  it('separates the cases the gate touched from the Passes it actually cost', () => {
    const rollup = computeReportMetrics(RUN).concepts!;

    expect(rollup.missingMandatory.map((entry) => entry.id)).toEqual([
      'missing-mandatory',
      'also-missing',
    ]);
    // Both were constrained; only the 84 had a Pass to lose.
    expect(rollup.gateBlockedPasses).toBe(1);
    expect(rollup.autoPassed.map((entry) => entry.id)).toEqual(['full-coverage']);
    expect(rollup.autoPassBlocked).toEqual([]);
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

  it('returns no rollup at all for a run with no concept data', () => {
    expect(computeReportMetrics([input('a', 90), input('b', 50)]).concepts).toBeNull();
  });
});

describe('report invariants (B0-714)', () => {
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
    rubricStatus: 'Pass',
    status: 'Pass',
    statusSource: 'rubric',
    ratingConstrained: false,
    gateBlockedAPass: false,
    autoPassTriggered: false,
    autoPassBlocked: false,
    concepts: null,
  };

  const BLOCK: RateBlock = {
    n: 1,
    avg: 90,
    grade: 'A',
    pass: 1,
    partial: 0,
    fail: 0,
    passPct: 100,
    partialPct: 0,
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
      ...overrides,
    };
  }

  /** Every corrupted context below must fail exactly the named check. */
  const CORRUPTIONS: Array<[string, ReportInvariantContext]> = [
    [
      'status_counts_sum_to_evaluated',
      context({ overall: { ...BLOCK, pass: 0, partial: 0, fail: 0 } }),
    ],
    ['evaluated_equals_total_minus_ute', context({ totalCases: 5 })],
    ['tier_counts_sum_to_evaluated', context({ tiers: [['Tier 1', { ...BLOCK, n: 7 }]] })],
    [
      'category_counts_sum_to_evaluated',
      context({ categories: [['Dilution', { ...BLOCK, n: 7 }]] }),
    ],
    [
      'mandatory_concept_missing_not_passed',
      context({
        evaluated: [
          {
            ...PASSING,
            status: 'Pass',
            concepts: concepts({
              mandatoryRequired: [CONCEPT.contactTime],
              mandatoryMissing: [CONCEPT.contactTime],
            }),
          },
        ],
      }),
    ],
    [
      'auto_pass_is_rated_pass',
      context({
        evaluated: [{ ...PASSING, autoPassTriggered: true, status: 'Partial Pass' }],
        overall: { ...BLOCK, pass: 0, partial: 1 },
        tiers: [['Tier 1', { ...BLOCK, pass: 0, partial: 1 }]],
        categories: [['Dilution', { ...BLOCK, pass: 0, partial: 1 }]],
      }),
    ],
    [
      'blocked_auto_pass_not_auto_passed',
      context({
        evaluated: [{ ...PASSING, autoPassBlocked: true, statusSource: 'auto_pass' }],
      }),
    ],
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
      // B0-717 — the reverse leak: a speed score that no timing supports. `basis` claims both
      // metrics while only one was measured, which is how an imputed timing would look.
      'grade_isolated_from_speed',
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

  it('refuses to compute metrics when the two concept sets contradict each other', () => {
    expect(() =>
      computeReportMetrics([
        input('contradictory', 74, {
          concepts: {
            // Full expected coverage *and* a missing must-have — impossible for real data.
            mandatory: coverage([CONCEPT.contactTime], [CONCEPT.contactTime]),
            expected: coverage([CONCEPT.contactTime], []),
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
          mandatory: coverage([CONCEPT.contactTime], [CONCEPT.contactTime]),
          expected: coverage([CONCEPT.contactTime], []),
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
      expect(invariantWarnings[0]).toContain('auto_pass_is_rated_pass');
    });

    it('keeps the report readable — scores and grades still present alongside the warning', () => {
      const metrics = computeReportMetrics(
        [contradictory(), input('clean', 90)],
        { invariantSeverity: 'warn' },
      );
      expect(metrics.overall.n).toBe(2);
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

    it("still throws under the default severity, so generation is unaffected", () => {
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
