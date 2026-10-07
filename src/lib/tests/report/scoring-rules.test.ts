import { describe, expect, it } from 'vitest';

import type { CaseConcepts, ConceptKindCoverage } from './case-concepts';
import {
  DEFAULT_PASS_MARK,
  DEFAULT_SCORING_RULES,
  SCORING_RULE_SETTING_KEYS,
  sanitizeScoringRules,
  scoringRulesSchema,
  type ScoringRules,
} from './scoring-config';
import {
  applyExpectedCoverage,
  applyMinimalCeiling,
  applyMinimalFloor,
  constraintNote,
  deriveCaseScoreline,
  deriveConceptFlags,
  expectedCoveragePct,
  finalStatus,
  minimalCeilingValue,
  minimalFloorValue,
} from './scoring-rules';

/**
 * B0-835 — the port of the reference skill's `concept_rules.py`, function by function.
 *
 * These are the *unit* tests for the rules themselves; `metrics.test.ts` covers what
 * `computeReportMetrics` does with them and `consolidate.test.ts` what each pass does. Every
 * expectation here is read off the Python, including the "no rule applies" returns of null and the
 * rule-disabled branches — a rule that silently fires where the reference returns None is exactly
 * the kind of divergence leadership reads as "not in parity".
 *
 * Concept phrases are regulated free text and are asserted back byte-for-byte.
 */

const CONCEPT = {
  dilution: 'Dilute 1:64 (2 oz/gal)',
  contactTime: '10 minutes contact time at 600 ppm active quat',
  epa: 'EPA Reg. No. 6836-140-4170',
  metric: 'Metric equivalent 15.6 mL/L',
} as const;

function coverage(required: string[], missing: string[]): ConceptKindCoverage {
  return { required, satisfied: required.filter((c) => !missing.includes(c)), missing };
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
    expected: coverage(
      [...params.mandatoryRequired, ...bonusRequired],
      [...mandatoryMissing, ...bonusMissing],
    ),
    materialIssue: params.materialIssue ?? false,
    materialIssueNote: params.materialIssueNote ?? null,
  };
}

const RULES = DEFAULT_SCORING_RULES;

/** Every must-have and every expected concept satisfied. */
const ALL_SATISFIED = concepts({
  mandatoryRequired: [CONCEPT.dilution],
  bonusRequired: [CONCEPT.metric],
});
/** One of two must-haves missed; the expected set is the same two phrases. */
const GATED = concepts({
  mandatoryRequired: [CONCEPT.dilution, CONCEPT.contactTime],
  mandatoryMissing: [CONCEPT.contactTime],
});
/** No must-haves at all, one of two expected concepts missed. */
const NO_MANDATORY = concepts({
  mandatoryRequired: [],
  bonusRequired: [CONCEPT.dilution, CONCEPT.metric],
  bonusMissing: [CONCEPT.metric],
});
/** Nothing specified either way — the backward-compatible blank-cell case. */
const BLANK: CaseConcepts = {
  mandatory: coverage([], []),
  expected: coverage([], []),
  materialIssue: false,
  materialIssueNote: null,
};

describe('the shipped configuration (concept_rules.SCORING_DEFAULTS)', () => {
  it('matches the reference defaults exactly', () => {
    expect(DEFAULT_SCORING_RULES).toEqual({
      minimalGate: { enabled: true },
      minimalFloor: { enabled: true, score: 70, respectMaterialIssue: true },
      minimalCeiling: { enabled: true, score: 59 },
      expectedCoverage: { enabled: true },
    });
    // The floor and the ceiling meet around the pass mark: full coverage clears it either way, a
    // miss fails under either line.
    expect(DEFAULT_SCORING_RULES.minimalFloor.score).toBeGreaterThan(DEFAULT_PASS_MARK);
    expect(DEFAULT_SCORING_RULES.minimalCeiling.score).toBeLessThan(DEFAULT_PASS_MARK);
    expect(scoringRulesSchema.safeParse(DEFAULT_SCORING_RULES).success).toBe(true);
  });

  it('names one settings row per knob, all REPORT_-prefixed (B0-638: no env vars)', () => {
    expect(Object.values(SCORING_RULE_SETTING_KEYS)).toEqual([
      'REPORT_MINIMAL_GATE_ENABLED',
      'REPORT_MINIMAL_FLOOR_ENABLED',
      'REPORT_MINIMAL_FLOOR_SCORE',
      'REPORT_MINIMAL_FLOOR_RESPECT_MATERIAL_ISSUE',
      'REPORT_MINIMAL_CEILING_ENABLED',
      'REPORT_MINIMAL_CEILING_SCORE',
      'REPORT_EXPECTED_COVERAGE_ENABLED',
    ]);
    expect(new Set(Object.values(SCORING_RULE_SETTING_KEYS)).size).toBe(7);
  });
});

describe('sanitizeScoringRules', () => {
  it('accepts a well-formed block unchanged', () => {
    const custom: ScoringRules = {
      minimalGate: { enabled: false },
      minimalFloor: { enabled: false, score: 0, respectMaterialIssue: false },
      minimalCeiling: { enabled: true, score: 100 },
      expectedCoverage: { enabled: false },
    };
    expect(sanitizeScoringRules(custom)).toEqual(custom);
  });

  it('falls back key by key, never dropping a whole rule for one bad value', () => {
    const repaired = sanitizeScoringRules({
      minimalGate: { enabled: 'yes' },
      minimalFloor: { enabled: false, score: 140, respectMaterialIssue: null },
      minimalCeiling: { enabled: true, score: Number.NaN },
      expectedCoverage: { enabled: false },
    });

    // The bad values reverted; the good ones survived.
    expect(repaired.minimalGate.enabled).toBe(true);
    expect(repaired.minimalFloor.enabled).toBe(false);
    expect(repaired.minimalFloor.score).toBe(70);
    expect(repaired.minimalFloor.respectMaterialIssue).toBe(true);
    expect(repaired.minimalCeiling.score).toBe(59);
    expect(repaired.expectedCoverage.enabled).toBe(false);
  });

  it('treats a score of 0 or 100 as in range, and anything outside as not', () => {
    expect(sanitizeScoringRules({ minimalFloor: { score: 0 } }).minimalFloor.score).toBe(0);
    expect(sanitizeScoringRules({ minimalCeiling: { score: 100 } }).minimalCeiling.score).toBe(100);
    expect(sanitizeScoringRules({ minimalFloor: { score: -1 } }).minimalFloor.score).toBe(70);
    expect(sanitizeScoringRules({ minimalCeiling: { score: Infinity } }).minimalCeiling.score).toBe(59);
  });

  it('returns the shipped defaults for anything that is not an object at all', () => {
    for (const raw of [null, undefined, 7, 'rules', [], { minimalGate: 'on' }]) {
      expect(sanitizeScoringRules(raw)).toEqual(DEFAULT_SCORING_RULES);
    }
  });
});

describe('deriveConceptFlags (derive_flags)', () => {
  it('reads full coverage as satisfied, qualified for the automatic Pass, not gated', () => {
    expect(deriveConceptFlags(ALL_SATISFIED)).toEqual({
      mandatorySpecified: true,
      expectedSpecified: true,
      allMandatorySatisfied: true,
      allExpectedSatisfied: true,
      autoPassQualified: true,
      autoPassBlocked: false,
      gated: false,
      autoPassTriggered: true,
      materialIssue: false,
    });
  });

  it('reads a must-have miss as gated, and never auto-passes it (Rule 1 outranks Rule 2)', () => {
    const flags = deriveConceptFlags(GATED);
    expect(flags.gated).toBe(true);
    expect(flags.allMandatorySatisfied).toBe(false);
    expect(flags.allExpectedSatisfied).toBe(false);
    expect(flags.autoPassTriggered).toBe(false);
  });

  it('blocks — never silently keeps — the automatic Pass on a material factual issue', () => {
    const flags = deriveConceptFlags(
      concepts({
        mandatoryRequired: [CONCEPT.dilution],
        bonusRequired: [CONCEPT.metric],
        materialIssue: true,
        materialIssueNote: 'Quoted 4 oz/gal; the label says 2 oz/gal.',
      }),
    );
    expect(flags.allExpectedSatisfied).toBe(true);
    expect(flags.autoPassQualified).toBe(false);
    expect(flags.autoPassBlocked).toBe(true);
    expect(flags.autoPassTriggered).toBe(false);
  });

  it('treats "all of nothing" as neither satisfied nor gated (blank cells are not failures)', () => {
    const flags = deriveConceptFlags(BLANK);
    expect(flags.mandatorySpecified).toBe(false);
    expect(flags.expectedSpecified).toBe(false);
    // Vacuously true, exactly as the reference: nothing was required, so nothing was missed…
    expect(flags.allMandatorySatisfied).toBe(true);
    // …but "every expected concept satisfied" requires there to have been some.
    expect(flags.allExpectedSatisfied).toBe(false);
    expect(flags.gated).toBe(false);
    expect(flags.autoPassQualified).toBe(false);
  });
});

describe('expectedCoveragePct / applyExpectedCoverage (Rule 3)', () => {
  it('is satisfied ÷ required as a percentage, rounded half-up', () => {
    expect(expectedCoveragePct(ALL_SATISFIED, RULES)).toBe(100);
    expect(expectedCoveragePct(GATED, RULES)).toBe(50);
    expect(
      expectedCoveragePct(
        concepts({
          mandatoryRequired: [CONCEPT.dilution],
          bonusRequired: [CONCEPT.metric, CONCEPT.epa],
          bonusMissing: [CONCEPT.epa],
        }),
        RULES,
      ),
      // 200/3 = 66.67 → 67 half-up, never the half-even the reference Python would give.
    ).toBe(67);
  });

  it('returns null — no constraint — when the rule is off or no expected concepts exist', () => {
    expect(expectedCoveragePct(ALL_SATISFIED, { ...RULES, expectedCoverage: { enabled: false } })).toBeNull();
    expect(expectedCoveragePct(BLANK, RULES)).toBeNull();
  });

  it('only ever lowers, and reports `applied` only where it actually bound', () => {
    expect(applyExpectedCoverage(90, GATED, RULES)).toEqual({
      completeness: 50,
      coveragePct: 50,
      applied: true,
    });
    // At the coverage share exactly: kept, and not labelled as capped.
    expect(applyExpectedCoverage(50, GATED, RULES)).toEqual({
      completeness: 50,
      coveragePct: 50,
      applied: false,
    });
    // Below it: the grader's own number stands — the cap never raises a value.
    expect(applyExpectedCoverage(10, GATED, RULES)).toEqual({
      completeness: 10,
      coveragePct: 50,
      applied: false,
    });
  });

  it('leaves the judged value alone with the rule off, and reports no coverage', () => {
    expect(applyExpectedCoverage(90, GATED, { ...RULES, expectedCoverage: { enabled: false } })).toEqual({
      completeness: 90,
      coveragePct: null,
      applied: false,
    });
  });
});

describe('minimalFloorValue / applyMinimalFloor (Rule 1b)', () => {
  const satisfied = deriveConceptFlags(ALL_SATISFIED);
  const gated = deriveConceptFlags(GATED);
  const noMandatory = deriveConceptFlags(NO_MANDATORY);
  const withIssue = deriveConceptFlags(
    concepts({
      mandatoryRequired: [CONCEPT.dilution],
      bonusRequired: [CONCEPT.metric],
      materialIssue: true,
    }),
  );

  it('is the configured score when every must-have is satisfied', () => {
    expect(minimalFloorValue(satisfied, RULES)).toBe(70);
    expect(minimalFloorValue(satisfied, { ...RULES, minimalFloor: { ...RULES.minimalFloor, score: 65 } })).toBe(65);
  });

  it('is null in every case the reference returns None for', () => {
    expect(minimalFloorValue(satisfied, { ...RULES, minimalFloor: { ...RULES.minimalFloor, enabled: false } })).toBeNull();
    // No must-haves specified — the floor says what full *mandatory* coverage is worth.
    expect(minimalFloorValue(noMandatory, RULES)).toBeNull();
    // A miss is the ceiling's business, never the floor's.
    expect(minimalFloorValue(gated, RULES)).toBeNull();
    // A wrong regulated value withdraws the protection.
    expect(minimalFloorValue(withIssue, RULES)).toBeNull();
  });

  it('honours respectMaterialIssue: false, which restores the floor over a material issue', () => {
    expect(
      minimalFloorValue(withIssue, {
        ...RULES,
        minimalFloor: { ...RULES.minimalFloor, respectMaterialIssue: false },
      }),
    ).toBe(70);
  });

  it('only ever raises, and reports `applied` only where it actually raised', () => {
    expect(applyMinimalFloor(62, satisfied, RULES)).toEqual({ overall: 70, bound: 70, applied: true });
    // At the floor exactly, and above it: untouched, and not labelled as floored.
    expect(applyMinimalFloor(70, satisfied, RULES)).toEqual({ overall: 70, bound: 70, applied: false });
    expect(applyMinimalFloor(93, satisfied, RULES)).toEqual({ overall: 93, bound: 70, applied: false });
    // No floor applies at all: no bound reported either.
    expect(applyMinimalFloor(20, gated, RULES)).toEqual({ overall: 20, bound: null, applied: false });
  });
});

describe('minimalCeilingValue / applyMinimalCeiling (Rule 1)', () => {
  const satisfied = deriveConceptFlags(ALL_SATISFIED);
  const gated = deriveConceptFlags(GATED);
  const noMandatory = deriveConceptFlags(NO_MANDATORY);

  it('is the configured score when a must-have is missing', () => {
    expect(minimalCeilingValue(gated, RULES)).toBe(59);
    expect(minimalCeilingValue(gated, { ...RULES, minimalCeiling: { enabled: true, score: 55 } })).toBe(55);
  });

  it('is null in every case the reference returns None for — including a disabled gate', () => {
    expect(minimalCeilingValue(gated, { ...RULES, minimalCeiling: { ...RULES.minimalCeiling, enabled: false } })).toBeNull();
    // The ceiling exists to express the gate's verdict in the score, so it must not fire where the
    // gate does not. This is the coupling most easily lost in a port.
    expect(minimalCeilingValue(gated, { ...RULES, minimalGate: { enabled: false } })).toBeNull();
    expect(minimalCeilingValue(noMandatory, RULES)).toBeNull();
    expect(minimalCeilingValue(satisfied, RULES)).toBeNull();
  });

  it('only ever lowers, and reports `applied` only where it actually lowered', () => {
    expect(applyMinimalCeiling(77, gated, RULES)).toEqual({ overall: 59, bound: 59, applied: true });
    // At the ceiling exactly, and below it: untouched, and not labelled as capped.
    expect(applyMinimalCeiling(59, gated, RULES)).toEqual({ overall: 59, bound: 59, applied: false });
    expect(applyMinimalCeiling(17, gated, RULES)).toEqual({ overall: 17, bound: 59, applied: false });
    expect(applyMinimalCeiling(93, satisfied, RULES)).toEqual({ overall: 93, bound: null, applied: false });
  });
});

describe('finalStatus (final_status)', () => {
  const satisfied = deriveConceptFlags(ALL_SATISFIED);
  const gated = deriveConceptFlags(GATED);
  const noMandatory = deriveConceptFlags(NO_MANDATORY);

  it('is the rubric alone when no rule has anything to say', () => {
    expect(finalStatus(78, noMandatory, RULES, 60, 78)).toEqual({
      status: 'Pass',
      source: 'rubric',
      ratingConstrained: false,
      gateBlockedAPass: false,
    });
    expect(finalStatus(40, noMandatory, RULES, 60, 40).status).toBe('Fail');
  });

  it('raises a failing rubric to Pass on full expected coverage, and names the source', () => {
    expect(finalStatus(62, satisfied, RULES, 75, 62)).toEqual({
      status: 'Pass',
      source: 'auto_pass',
      ratingConstrained: false,
      gateBlockedAPass: false,
    });
    // Already passing: the automatic Pass is not credited with a change it did not make.
    expect(finalStatus(90, satisfied, RULES, 60, 90).source).toBe('rubric');
  });

  it('fails a gated case whatever the score, and outranks the automatic Pass', () => {
    // Every expected concept present *and* a must-have missing is contradictory data, but the
    // precedence is the point: Rule 1 wins.
    const contradictory = { ...satisfied, gated: true, allMandatorySatisfied: false };
    expect(finalStatus(90, contradictory, RULES, 60, 90)).toEqual({
      status: 'Fail',
      source: 'minimal_gate',
      ratingConstrained: true,
      gateBlockedAPass: true,
    });
  });

  it('judges "did the gate take a Pass away?" on the PRE-GATE score, never the capped one', () => {
    // Capped to 59, pre-gate 77: a Pass was lost.
    expect(finalStatus(59, gated, RULES, 60, 77).gateBlockedAPass).toBe(true);
    // Capped to 17, pre-gate 17: it failed on the rubric as well, so nothing was taken.
    expect(finalStatus(17, gated, RULES, 60, 17).gateBlockedAPass).toBe(false);
    // Reading the capped score instead would answer "no" for every gated case and lose the count.
    expect(finalStatus(59, gated, RULES, 60, 59).gateBlockedAPass).toBe(false);
  });

  it('constrains nothing when the gate is off — a supported configuration', () => {
    expect(finalStatus(77, gated, { ...RULES, minimalGate: { enabled: false } }, 60, 77)).toEqual({
      status: 'Pass',
      source: 'rubric',
      ratingConstrained: false,
      gateBlockedAPass: false,
    });
  });
});

describe('constraintNote (constraint_note)', () => {
  const base = {
    overall: 59,
    preGate: 77,
    floorApplied: false,
    floor: null,
    coverageApplied: false,
    coveragePct: null,
    completenessJudged: null,
  };

  it('names the missing must-haves verbatim and quotes the Pre-Gate Content Score', () => {
    const note = constraintNote({
      ...base,
      concepts: GATED,
      flags: deriveConceptFlags(GATED),
      source: 'minimal_gate',
      constrained: true,
      blocked: true,
    });
    expect(note).toContain(`Failed on mandatory concepts: ${CONCEPT.contactTime}.`);
    expect(note).toContain('caps the score at 59/100 (grade F, Fail)');
    expect(note).toContain('Pre-Gate Content Score: 77/100');
  });

  it('says so plainly when the case failed on the rubric as well', () => {
    const note = constraintNote({
      ...base,
      overall: 17,
      preGate: 17,
      concepts: GATED,
      flags: deriveConceptFlags(GATED),
      source: 'minimal_gate',
      constrained: true,
      blocked: false,
    });
    expect(note).toBe(
      `Failed on mandatory concepts: ${CONCEPT.contactTime}. The response scored 17/100 on the rubric and failed there as well; the mandatory cap holds it at 17/100.`,
    );
  });

  it('falls back to a generic phrase rather than an empty list', () => {
    const noPhrases: CaseConcepts = {
      mandatory: { required: [CONCEPT.dilution], satisfied: [CONCEPT.dilution], missing: [] },
      expected: coverage([CONCEPT.dilution], []),
      materialIssue: false,
      materialIssueNote: null,
    };
    const note = constraintNote({
      ...base,
      concepts: noPhrases,
      flags: { ...deriveConceptFlags(noPhrases), gated: true },
      source: 'minimal_gate',
      constrained: true,
      blocked: false,
    });
    expect(note).toContain('Failed on mandatory concepts: a mandatory concept.');
  });

  it('explains an automatic Pass, and a blocked one with the grader’s own note', () => {
    expect(
      constraintNote({
        ...base,
        overall: 62,
        concepts: ALL_SATISFIED,
        flags: deriveConceptFlags(ALL_SATISFIED),
        source: 'auto_pass',
        constrained: false,
        blocked: false,
      }),
    ).toBe(
      'Automatic Pass: the response communicates all expected key concepts with no material factual issue (weighted score 62/100).',
    );

    const blockedBlock = concepts({
      mandatoryRequired: [CONCEPT.dilution],
      bonusRequired: [CONCEPT.metric],
      materialIssue: true,
      materialIssueNote: 'the stated dilution is 4 oz/gal where the label reads 2 oz/gal',
    });
    expect(
      constraintNote({
        ...base,
        overall: 62,
        concepts: blockedBlock,
        flags: deriveConceptFlags(blockedBlock),
        source: 'rubric',
        constrained: false,
        blocked: false,
      }),
    ).toBe(
      'Automatic Pass not applied: all expected concepts are present, but the stated dilution is 4 oz/gal where the label reads 2 oz/gal. The mandatory floor is also withheld for the same reason.',
    );
  });

  it('flags a firing floor as a disagreement to re-check, not a routine adjustment', () => {
    expect(
      constraintNote({
        ...base,
        overall: 70,
        preGate: 70,
        floorApplied: true,
        floor: 70,
        concepts: ALL_SATISFIED,
        flags: deriveConceptFlags(ALL_SATISFIED),
        source: 'rubric',
        constrained: false,
        blocked: false,
      }),
    ).toContain('the score was raised to the 70 floor');
  });

  it('shows both Completeness numbers where the coverage cap bound', () => {
    expect(
      constraintNote({
        ...base,
        overall: 75,
        preGate: 75,
        coverageApplied: true,
        coveragePct: 40,
        completenessJudged: 66,
        concepts: NO_MANDATORY,
        flags: deriveConceptFlags(NO_MANDATORY),
        source: 'rubric',
        constrained: false,
        blocked: false,
      }),
    ).toBe(
      "Completeness was set by expected-concept coverage (40%), which is below the grader's judged 66. Expected key concepts are part of the content grade: missing expected content reduces Completeness proportionally.",
    );
  });

  it('says nothing at all when no rule moved anything', () => {
    expect(
      constraintNote({
        ...base,
        overall: 93,
        preGate: 93,
        concepts: ALL_SATISFIED,
        flags: deriveConceptFlags(ALL_SATISFIED),
        source: 'rubric',
        constrained: false,
        blocked: false,
      }),
    ).toBeNull();
  });
});

describe('deriveCaseScoreline — the fixed order (methodology §2b Rule 4 step 7)', () => {
  function line(params: {
    accuracy: number;
    completenessJudged: number | null;
    relevance: number;
    clarity: number;
    concepts: CaseConcepts;
    rules?: ScoringRules;
    passMark?: number;
  }) {
    return deriveCaseScoreline({
      accuracy: params.accuracy,
      completenessJudged: params.completenessJudged,
      relevance: params.relevance,
      clarity: params.clarity,
      concepts: params.concepts,
      rules: params.rules ?? RULES,
      passMark: params.passMark ?? DEFAULT_PASS_MARK,
    });
  }

  it('returns null for a case with no expected concepts — the caller marks it unevaluable', () => {
    expect(
      line({ accuracy: 90, completenessJudged: 90, relevance: 90, clarity: 90, concepts: BLANK }),
    ).toBeNull();
  });

  it('runs cap → weight → floor → pre-gate → ceiling, and keeps every intermediate', () => {
    const c = line({
      accuracy: 90,
      completenessJudged: 90,
      relevance: 90,
      clarity: 80,
      concepts: GATED,
    })!;

    expect(c.completenessJudged).toBe(90);
    expect(c.coveragePct).toBe(50);
    expect(c.completeness).toBe(50);
    expect(c.coverageApplied).toBe(true);
    expect(c.weighted).toBe(77);
    expect(c.floor).toBeNull();
    expect(c.floorApplied).toBe(false);
    expect(c.preGateScore).toBe(77);
    expect(c.preGateGrade).toBe('C');
    expect(c.ceiling).toBe(59);
    expect(c.ceilingApplied).toBe(true);
    expect(c.overall).toBe(59);
    expect(c.grade).toBe('F');
    expect(c.rubricStatus).toBe('Fail');
    expect(c.status).toBe('Fail');
    expect(c.statusSource).toBe('minimal_gate');
    expect(c.ratingConstrained).toBe(true);
    expect(c.gateBlockedAPass).toBe(true);
    expect(c.flags.gated).toBe(true);
  });

  it('never lets the floor and the ceiling both fire — they need opposite verdicts', () => {
    const floored = line({
      accuracy: 62,
      completenessJudged: 62,
      relevance: 62,
      clarity: 62,
      concepts: ALL_SATISFIED,
    })!;
    expect(floored.floorApplied).toBe(true);
    expect(floored.ceilingApplied).toBe(false);

    const capped = line({
      accuracy: 90,
      completenessJudged: 90,
      relevance: 90,
      clarity: 80,
      concepts: GATED,
    })!;
    expect(capped.floorApplied).toBe(false);
    expect(capped.ceilingApplied).toBe(true);
  });

  it('takes Completeness from coverage — and does not call it capped — when none was judged', () => {
    const c = line({
      accuracy: 90,
      completenessJudged: null,
      relevance: 90,
      clarity: 90,
      concepts: GATED,
    })!;
    expect(c.completenessJudged).toBeNull();
    expect(c.completeness).toBe(50);
    expect(c.coverageApplied).toBe(false);
  });

  it('still uses coverage for Completeness with the cap disabled, when none was judged', () => {
    // The cap being off cannot conjure a judged value: coverage is the only Completeness data such
    // a pass carries, so it is used regardless.
    const c = line({
      accuracy: 90,
      completenessJudged: null,
      relevance: 90,
      clarity: 90,
      concepts: GATED,
      rules: { ...RULES, expectedCoverage: { enabled: false } },
    })!;
    expect(c.completeness).toBe(50);
    expect(c.coveragePct).toBe(50);
    expect(c.coverageApplied).toBe(false);
  });

  it('reports the coverage share even with the cap disabled, and leaves the judgment alone', () => {
    const c = line({
      accuracy: 90,
      completenessJudged: 90,
      relevance: 90,
      clarity: 90,
      concepts: GATED,
      rules: { ...RULES, expectedCoverage: { enabled: false } },
    })!;
    expect(c.coveragePct).toBe(50);
    expect(c.completeness).toBe(90);
    expect(c.coverageApplied).toBe(false);
    expect(c.weighted).toBe(90);
    // The gate is untouched by the coverage rule: still capped, still Fail.
    expect(c.overall).toBe(59);
    expect(c.status).toBe('Fail');
  });

  it('keeps every rule out of the way when all four are disabled', () => {
    const off: ScoringRules = {
      minimalGate: { enabled: false },
      minimalFloor: { enabled: false, score: 70, respectMaterialIssue: true },
      minimalCeiling: { enabled: false, score: 59 },
      expectedCoverage: { enabled: false },
    };
    const c = line({
      accuracy: 90,
      completenessJudged: 90,
      relevance: 90,
      clarity: 80,
      concepts: GATED,
      rules: off,
    })!;

    expect(c.completeness).toBe(90);
    // 0.4·90 + 0.3·90 + 0.2·90 + 0.1·80 = 89 — the plain rubric, untouched by any rule.
    expect(c.weighted).toBe(89);
    expect(c.overall).toBe(89);
    expect(c.floorApplied).toBe(false);
    expect(c.ceilingApplied).toBe(false);
    expect(c.status).toBe('Pass');
    expect(c.statusSource).toBe('rubric');
    expect(c.conceptNote).toBeNull();
  });

  it('lets a material issue through to the floor when respectMaterialIssue is false', () => {
    const block = concepts({
      mandatoryRequired: [CONCEPT.dilution],
      bonusRequired: [CONCEPT.metric],
      materialIssue: true,
      materialIssueNote: 'Contact time stated as 5 minutes; the label requires 10.',
    });
    const respected = line({
      accuracy: 62,
      completenessJudged: 62,
      relevance: 62,
      clarity: 62,
      concepts: block,
    })!;
    expect(respected.floorApplied).toBe(false);
    expect(respected.overall).toBe(62);

    const ignored = line({
      accuracy: 62,
      completenessJudged: 62,
      relevance: 62,
      clarity: 62,
      concepts: block,
      rules: { ...RULES, minimalFloor: { ...RULES.minimalFloor, respectMaterialIssue: false } },
    })!;
    expect(ignored.floorApplied).toBe(true);
    expect(ignored.overall).toBe(70);
    // The automatic Pass is still blocked — that rule reads the flag directly, not the floor's.
    expect(ignored.flags.autoPassBlocked).toBe(true);
    expect(ignored.statusSource).toBe('rubric');
  });

  it('honours the pass mark it is given for the rubric and the auto-Pass alike', () => {
    const at60 = line({
      accuracy: 62,
      completenessJudged: 62,
      relevance: 62,
      clarity: 62,
      concepts: NO_MANDATORY,
      passMark: 60,
    })!;
    // 0.4·62 + 0.3·50 + 0.2·62 + 0.1·62 = 24.8 + 15 + 12.4 + 6.2 = 58.4 → 58.
    expect(at60.overall).toBe(58);
    expect(at60.status).toBe('Fail');

    const at50 = line({
      accuracy: 62,
      completenessJudged: 62,
      relevance: 62,
      clarity: 62,
      concepts: NO_MANDATORY,
      passMark: 50,
    })!;
    expect(at50.overall).toBe(58);
    expect(at50.status).toBe('Pass');
  });

  it('rounds once, half-up, at each step the reference rounds', () => {
    // Coverage 2/3 → 66.67 → 67; weighted 0.4·84 + 0.3·67 + 0.2·84 + 0.1·84 = 78.9 → 79.
    const c = line({
      accuracy: 84,
      completenessJudged: null,
      relevance: 84,
      clarity: 84,
      concepts: concepts({
        mandatoryRequired: [CONCEPT.dilution],
        bonusRequired: [CONCEPT.metric, CONCEPT.epa],
        bonusMissing: [CONCEPT.epa],
      }),
    })!;
    expect(c.coveragePct).toBe(67);
    expect(c.weighted).toBe(79);
    expect(Number.isInteger(c.overall)).toBe(true);
    expect(Number.isInteger(c.preGateScore)).toBe(true);
  });
});
