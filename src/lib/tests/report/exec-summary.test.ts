import { describe, expect, it } from 'vitest';

import type { ReportDataReady, ReportEvaluatedCase } from './data-schemas';
import {
  categoryMarkerLegend,
  formatGradingConfig,
  formatRatingDistribution,
  gradeBandsAtPassMark,
  mandatoryMissingCountByCategory,
  plural,
  reportExecSummarySchema,
  resolveCaseIdMentions,
  scoringRulesSentence,
  toExecSummaryData,
  weightPercent,
} from './exec-summary';
import { DEFAULT_SCORING_RULES } from './scoring-config';

const CONCEPTS = {
  mandatory: { required: ['States the 1:64 ratio'], satisfied: ['States the 1:64 ratio'], missing: [] },
  expected: {
    required: ['States the 1:64 ratio', 'Names the 10-minute dwell'],
    satisfied: ['States the 1:64 ratio', 'Names the 10-minute dwell'],
    missing: [],
  },
  materialIssue: false,
  materialIssueNote: null,
};

function evaluated(overrides: Partial<ReportEvaluatedCase>): ReportEvaluatedCase {
  return {
    id: 'id',
    question: 'q',
    tier: 'Tier 1',
    priorityRaw: 1,
    category: 'Dilution',
    accuracy: 0,
    completeness: 100,
    relevance: 0,
    clarity: 0,
    overall: 0,
    grade: 'F',
    status: 'Fail',
    coverage: { satisfied: 2, required: 2 },
    // B0-835 — the concept-rule scoreline every evaluated case now carries.
    completenessJudged: 100,
    coveragePct: 100,
    coverageApplied: false,
    weighted: 0,
    floor: null,
    floorApplied: false,
    preGateScore: 0,
    preGateGrade: 'F',
    ceiling: null,
    ceilingApplied: false,
    rubricStatus: 'Fail',
    statusSource: 'rubric',
    ratingConstrained: false,
    gateBlockedAPass: false,
    autoPassTriggered: false,
    autoPassBlocked: false,
    conceptNote: null,
    mandatoryMissing: false,
    materialIssue: false,
    passesOnlyUnderCurrentMark: false,
    concepts: CONCEPTS,
    similarity: null,
    similarityNote: null,
    evalConfidence: null,
    confidenceNote: null,
    ...overrides,
  };
}

const ID_A = '0a1b2c3d-1111-4111-8111-111111111111';
const ID_B = 'f9e8d7c6-2222-4222-8222-222222222222';
/** Shares its 8-hex prefix with ID_B, so the shorthand is ambiguous between the two. */
const ID_B_TWIN = 'f9e8d7c6-3333-4333-8333-333333333333';

function readyFixture(): ReportDataReady {
  const perCase = [
    evaluated({ id: ID_A, category: 'Fundamentals', overall: 92, grade: 'A', status: 'Pass' }),
    evaluated({ id: ID_B, category: 'Accuracy Factors', mandatoryMissing: true }),
  ];
  return {
    ok: true,
    status: 'ready',
    runId: 'run-1',
    testId: 'test-1',
    testName: 'Dilution Control Top 20',
    intendedAgent: 'dilution',
    generatedAt: '2026-09-04T12:00:00.000Z',
    stale: false,
    config: null,
    metrics: {
      totalCases: 2,
      evaluated: 2,
      uteCount: 0,
      ute: [],
      overall: { n: 2, avg: 46, grade: 'F', pass: 1, fail: 1, passPct: 50, failPct: 50 },
      highest: [],
      lowest: [],
      perCase,
      tiers: [],
      categories: [],
      strongestCategory: 'Fundamentals',
      weakestCategory: 'Accuracy Factors',
      passMark: 60,
      strictPassMark: 70,
      passOnlyUnderCurrentMark: [],
      // B0-835 — the concept rules in force, and what each one did.
      scoringRules: DEFAULT_SCORING_RULES,
      gateFloor: {
        gateEnabled: true,
        floorEnabled: true,
        floorScore: 70,
        floorRespectsMaterialIssue: true,
        flooredIds: [],
        ceilingEnabled: true,
        ceilingScore: 59,
        cappedIds: [],
        coverageEnabled: true,
        coverageCappedIds: [],
      },
      speed: null,
      concepts: null,
      judged: null,
      consistency: null,
      warnings: [],
    },
    synthesis: {
      failurePatterns: [],
      strengths: [],
      weaknesses: [],
      top3: [
        { priority: 1, what: 'a', whyFirst: '', evidence: '', affected: '', change: '', impact: '' },
        { priority: 2, what: 'b', whyFirst: '', evidence: '', affected: '', change: '', impact: '' },
        { priority: 3, what: 'c', whyFirst: '', evidence: '', affected: '', change: '', impact: '' },
      ],
      exec: {
        strongestAreas: [],
        improvementAreas: [],
        mostSignificantFailure: '',
        majorRisk: '',
        readiness: '',
      },
    },
    cases: [
      // Only `id` matters here: the projection must drop the whole array, contents unseen.
      { id: ID_A } as unknown as ReportDataReady['cases'][number],
    ],
  };
}

describe('toExecSummaryData', () => {
  it('drops cases and passes everything else through by reference', () => {
    const ready = readyFixture();
    const summary = toExecSummaryData(ready);

    expect('cases' in summary).toBe(false);
    expect(summary.metrics).toBe(ready.metrics);
    expect(summary.synthesis).toBe(ready.synthesis);
    expect(summary.testName).toBe('Dilution Control Top 20');
    expect(reportExecSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('is what the schema describes — the schema rejects a payload that still carries cases', () => {
    // `omit` strips unknown keys on parse rather than rejecting them; `strict` is the assertion.
    const parsed = reportExecSummarySchema.strict().safeParse(readyFixture());
    expect(parsed.success).toBe(false);
  });
});

describe('mandatoryMissingCountByCategory', () => {
  it('counts only rows that reported a mandatory miss, keyed by ledger category', () => {
    const counts = mandatoryMissingCountByCategory({
      perCase: [
        evaluated({ id: '1', category: 'Accuracy Factors', mandatoryMissing: true }),
        evaluated({ id: '2', category: 'Accuracy Factors', mandatoryMissing: true }),
        evaluated({ id: '3', category: 'Accuracy Factors', mandatoryMissing: false }),
        evaluated({ id: '4', category: 'System Types', mandatoryMissing: true }),
        evaluated({ id: '5', category: 'Fundamentals', mandatoryMissing: false }),
      ],
    });
    expect(counts).toEqual({ 'Accuracy Factors': 2, 'System Types': 1 });
    expect('Fundamentals' in counts).toBe(false);
  });

  it('returns an empty record for an empty ledger', () => {
    expect(mandatoryMissingCountByCategory({ perCase: [] })).toEqual({});
  });
});

describe('resolveCaseIdMentions', () => {
  const known = [ID_A, ID_B];

  it('returns no segments for empty prose', () => {
    expect(resolveCaseIdMentions('', known)).toEqual([]);
  });

  it('links a full UUID and keeps the surrounding text byte-for-byte', () => {
    const text = `Case ${ID_A} omitted the dwell time; ${ID_B} did not.`;
    expect(resolveCaseIdMentions(text, known)).toEqual([
      { kind: 'text', text: 'Case ' },
      { kind: 'case', id: ID_A, display: ID_A },
      { kind: 'text', text: ' omitted the dwell time; ' },
      { kind: 'case', id: ID_B, display: ID_B },
      { kind: 'text', text: ' did not.' },
    ]);
  });

  it('links a full UUID even when it is not a known id (a UTE case has a ledger entry too)', () => {
    const unknown = '12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(resolveCaseIdMentions(`see ${unknown}.`, known)).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'case', id: unknown, display: unknown },
      { kind: 'text', text: '.' },
    ]);
  });

  it('resolves an 8-hex shorthand to the one known id with that prefix, preserving the written casing', () => {
    const segments = resolveCaseIdMentions('0A1B2C3D (20% coverage)', known);
    expect(segments).toEqual([
      { kind: 'case', id: ID_A, display: '0A1B2C3D' },
      { kind: 'text', text: ' (20% coverage)' },
    ]);
  });

  it('leaves an 8-hex token as text when it matches no known id — ordinary numbers are valid hex', () => {
    const text = 'Rounded $25 / 129 gal; 20260904 cases; ref 12345678.';
    expect(resolveCaseIdMentions(text, known)).toEqual([{ kind: 'text', text }]);
  });

  it('leaves an 8-hex token as text when it is the prefix of more than one known id', () => {
    const text = 'f9e8d7c6 failed.';
    expect(resolveCaseIdMentions(text, [ID_A, ID_B, ID_B_TWIN])).toEqual([
      { kind: 'text', text },
    ]);
    // The full id still resolves — only the shorthand is ambiguous.
    expect(resolveCaseIdMentions(ID_B_TWIN, [ID_B, ID_B_TWIN])).toEqual([
      { kind: 'case', id: ID_B_TWIN, display: ID_B_TWIN },
    ]);
  });

  it('does not match inside a longer hex run', () => {
    const text = '0a1b2c3d4e5f is not a citation';
    expect(resolveCaseIdMentions(text, known)).toEqual([{ kind: 'text', text }]);
  });

  it('passes regulated values in the prose through verbatim', () => {
    const text = `${ID_A} answered 2 oz/gal (1:64) at 10 minutes; the label states 4 oz/gal (1:32).`;
    const segments = resolveCaseIdMentions(text, known);
    expect(segments.map((s) => (s.kind === 'text' ? s.text : s.display)).join('')).toBe(text);
  });
});

describe('formatGradingConfig', () => {
  it('renders every part in render.ts order, plain text, rules included (B0-835)', () => {
    expect(
      formatGradingConfig(
        {
          model: 'claude-opus-5',
          effort: 'high',
          passes: 3,
          spreadThreshold: 10,
          passMark: 60,
          scoringRules: DEFAULT_SCORING_RULES,
          gradingPromptHash: 'abcdef0123456789abcdef',
          judgedThresholds: null,
        },
        70,
      ),
    ).toBe(
      'Graded by claude-opus-5 at high effort · 3 independent passes · pass mark 60 (strict 70) · ceiling 59 · floor 70 (withheld on material issue) · coverage cap on · gate on · grading prompt abcdef012345',
    );
  });

  it('omits the parts a legacy state does not carry, singularizes one pass, and marks default rules', () => {
    expect(
      formatGradingConfig(
        {
          model: 'gpt-4.1',
          effort: null,
          passes: 1,
          spreadThreshold: null,
          passMark: null,
          scoringRules: null,
          gradingPromptHash: null,
          judgedThresholds: null,
        },
        70,
      ),
    ).toBe(
      'Graded by gpt-4.1 · 1 independent pass · ceiling 59 · floor 70 (withheld on material issue) · coverage cap on · gate on (default)',
    );
  });
});

describe('categoryMarkerLegend (B0-835)', () => {
  it('states the cap, at the configured ceiling, when the gate and the ceiling are on', () => {
    expect(categoryMarkerLegend(DEFAULT_SCORING_RULES)).toBe(
      "the number of cases in that category capped at 59 (F, Fail) for missing a mandatory concept — each case's Pre-Gate Content Score is shown in the detailed report.",
    );
    expect(
      categoryMarkerLegend({
        ...DEFAULT_SCORING_RULES,
        minimalCeiling: { enabled: true, score: 49 },
      }),
    ).toContain('capped at 49 (F, Fail)');
  });

  it('never claims a cap when the ceiling is off', () => {
    expect(
      categoryMarkerLegend({
        ...DEFAULT_SCORING_RULES,
        minimalCeiling: { enabled: false, score: 59 },
      }),
    ).toBe(
      'the number of cases in that category rated Fail by the mandatory gate for missing a mandatory concept, whatever their score.',
    );
  });

  it('says reported only when the gate is off', () => {
    expect(
      categoryMarkerLegend({ ...DEFAULT_SCORING_RULES, minimalGate: { enabled: false } }),
    ).toBe(
      'the number of cases in that category that missed a mandatory concept — reported only; the mandatory gate is off for this report.',
    );
  });
});

describe('scoringRulesSentence (B0-835)', () => {
  const gateFloor = {
    gateEnabled: true,
    floorEnabled: true,
    floorScore: 70,
    floorRespectsMaterialIssue: true,
    flooredIds: [] as string[],
    ceilingEnabled: true,
    ceilingScore: 59,
    cappedIds: [] as string[],
    coverageEnabled: true,
    coverageCappedIds: [] as string[],
  };

  it('states every rule at the defaults, and that score, grade and Result agree', () => {
    expect(scoringRulesSentence(DEFAULT_SCORING_RULES, gateFloor)).toBe(
      'Scoring rules: a missing mandatory concept caps the score at 59 (F, Fail); full mandatory coverage floors the score at 70; Completeness is capped at expected-concept coverage. Score, grade and Result always agree.',
    );
  });

  it('counts the cases each rule actually moved', () => {
    expect(
      scoringRulesSentence(DEFAULT_SCORING_RULES, {
        ...gateFloor,
        flooredIds: ['a'],
        coverageCappedIds: ['b', 'c', 'd'],
      }),
    ).toBe(
      'Scoring rules: a missing mandatory concept caps the score at 59 (F, Fail); full mandatory coverage floors the score at 70 (raised 1 case); Completeness is capped at expected-concept coverage (lowered 3 cases). Score, grade and Result always agree.',
    );
  });

  it('says OFF for each disabled rule and drops the agreement claim without the ceiling', () => {
    expect(
      scoringRulesSentence(
        {
          minimalGate: { enabled: false },
          minimalFloor: { enabled: false, score: 70, respectMaterialIssue: true },
          minimalCeiling: { enabled: false, score: 59 },
          expectedCoverage: { enabled: false },
        },
        { ...gateFloor, gateEnabled: false, floorEnabled: false, ceilingEnabled: false, coverageEnabled: false },
      ),
    ).toBe(
      'Scoring rules: mandatory gate OFF; mandatory floor OFF; expected-coverage cap OFF.',
    );
    expect(
      scoringRulesSentence(
        { ...DEFAULT_SCORING_RULES, minimalCeiling: { enabled: false, score: 59 } },
        { ...gateFloor, ceilingEnabled: false },
      ),
    ).toBe(
      'Scoring rules: a missing mandatory concept rates the case Fail (score cap off); full mandatory coverage floors the score at 70; Completeness is capped at expected-concept coverage.',
    );
  });
});

describe('weightPercent', () => {
  it('prints configured weights without binary-float noise and without rounding', () => {
    expect(weightPercent(0.6)).toBe('60');
    expect(weightPercent(0.4)).toBe('40');
    expect(weightPercent(0.3)).toBe('30');
    expect(weightPercent(0.1)).toBe('10');
    expect(weightPercent(0.625)).toBe('62.5');
  });
});

describe('formatRatingDistribution', () => {
  it('lists only non-zero ratings, in the given order, lower-cased', () => {
    expect(
      formatRatingDistribution([
        { rating: 'Excellent', count: 6 },
        { rating: 'Good', count: 13 },
        { rating: 'Acceptable', count: 0 },
        { rating: 'Slow', count: 1 },
        { rating: 'Very slow', count: 0 },
      ]),
    ).toBe('6 excellent, 13 good, 1 slow');
  });

  it('is empty when every count is zero', () => {
    expect(formatRatingDistribution([{ rating: 'Good', count: 0 }])).toBe('');
  });
});

describe('gradeBandsAtPassMark', () => {
  it('splits the letters at the default mark: A/B/C/D pass, F fails', () => {
    expect(gradeBandsAtPassMark(60)).toEqual({ pass: ['A', 'B', 'C', 'D'], fail: ['F'] });
  });

  it('moves D to the failing side at the strict mark', () => {
    expect(gradeBandsAtPassMark(70)).toEqual({ pass: ['A', 'B', 'C'], fail: ['D', 'F'] });
  });

  it('returns null when the mark falls inside a band, rather than mislabelling it', () => {
    expect(gradeBandsAtPassMark(65)).toBeNull();
    expect(gradeBandsAtPassMark(59.5)).toBeNull();
  });
});

describe('plural', () => {
  it('singular at exactly one, plural otherwise', () => {
    expect(plural(1, 'case')).toBe('case');
    expect(plural(0, 'case')).toBe('cases');
    expect(plural(3, 'pass', 'passes')).toBe('passes');
  });
});
