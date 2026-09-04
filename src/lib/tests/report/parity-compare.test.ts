import { describe, expect, it } from 'vitest';

import { NO_EXPECTED_CONCEPTS_UTE_REASON } from './metrics';
import {
  applyScoringOverrides,
  compareEvalRuns,
  DEFAULT_SPREAD_THRESHOLD,
  describeScoringRules,
  formatSideRules,
  parseEvalFile,
  PROPOSED_TARGET_NOTE,
  renderParityMarkdown,
  resolveScoringConfig,
  type EvalFile,
} from './parity-compare';
import { DEFAULT_SCORING_RULES } from './scoring-config';

/**
 * B0-824 / B0-835 — Bex vs desktop parity comparison, pinned against two hand-scored synthetic
 * eval.json fixtures (the same data as the scratchpad pair the CLI is smoke-tested on).
 *
 * Every expected number below is computed by hand through the B0-835 pipeline, in its fixed order:
 * Completeness = min(judged, expected coverage) — the coverage share alone where the file carries
 * no judged value; overall = 0.40·A + 0.30·C + 0.20·R + 0.10·Cl rounded half-up; full mandatory
 * coverage raises the score to the 70 floor; the Pre-Gate Content Score is captured there; a
 * missing mandatory concept caps it at 59 and rates the case Fail; Pass at ≥ 60.
 *
 * Per case (A = "Bex" side, B = "Desktop" side):
 *   C1 identical                 → 93 / 93, both fully covered
 *   C2 sub-score-only difference  → A judged Completeness 40 (below the 75 coverage, so it stands)
 *                                   → 68 weighted → raised to the 70 floor; B has no judged value
 *                                   → coverage 75 → 74.5 → 75 (B also carries derived
 *                                   overall/grade/status that must be ignored)
 *   C3 concept disagreement       → A 4/4 expected → 86; B 2/4 → 71; Δ 15 = spread, explained
 *   C4 UTE on one side            → A 82.5→83 (blank mandatory column: no floor, no ceiling);
 *                                   B unable_to_evaluate
 *   C5 review-queue case          → 84 / 84; A eval_confidence 55 (queued), B 71 (not)
 *   C6 mandatory miss on BOTH     → A 57 (already under the ceiling); B 61 capped to 59; both
 *                                   gated → Fail; material-issue disagreement; both queued
 *   C7 no expected concepts on A  → A UTE, B 93
 *   C8 only in B                  → unmatched
 *   C9 Pass/Fail flip             → blank mandatory column, so nothing but the rubric decides:
 *                                   A 57 Fail / B 61 Pass
 */

const conceptsC1 = {
  minimal_required: ['Dilute 2 oz per gallon'],
  minimal_satisfied: ['Dilute 2 oz per gallon'],
  minimal_missing: [],
  expected_required: ['Dilute 2 oz per gallon', '10 minute contact time', 'No rinse required', 'Use cold water'],
  expected_satisfied: ['Dilute 2 oz per gallon', '10 minute contact time', 'No rinse required', 'Use cold water'],
  expected_missing: [],
  material_issue: false,
};

const conceptsC2 = {
  minimal_required: ['Wear gloves'],
  minimal_satisfied: ['Wear gloves'],
  minimal_missing: [],
  expected_required: ['Wear gloves', 'Ventilate the area', 'Do not mix with bleach', 'Store below 100 F'],
  expected_satisfied: ['Wear gloves', 'Ventilate the area', 'Do not mix with bleach'],
  expected_missing: ['Store below 100 F'],
  material_issue: false,
};

const conceptsC5 = {
  minimal_required: ['Name a Betco product'],
  minimal_satisfied: ['Name a Betco product'],
  minimal_missing: [],
  expected_required: [
    'Name a Betco product',
    'State the dilution',
    'State the surface',
    'Mention safety data sheet',
    'Mention contact time',
  ],
  expected_satisfied: ['Name a Betco product', 'State the dilution', 'State the surface', 'Mention safety data sheet'],
  expected_missing: ['Mention contact time'],
  material_issue: false,
};

const conceptsC6 = (materialIssue: boolean) => ({
  minimal_required: ['Do not use on wood'],
  minimal_satisfied: [],
  minimal_missing: ['Do not use on wood'],
  expected_required: ['Do not use on wood', 'Name a Betco product', 'State the dilution', 'State the surface'],
  expected_satisfied: ['Name a Betco product', 'State the dilution'],
  expected_missing: ['Do not use on wood', 'State the surface'],
  material_issue: materialIssue,
});

/** No mandatory column at all, so neither the floor nor the ceiling can fire — the rubric alone. */
const conceptsC9 = {
  minimal_required: [],
  minimal_satisfied: [],
  minimal_missing: [],
  expected_required: ['Name the surface', 'State the dwell time', 'Warn about dilution', 'Mention PPE'],
  expected_satisfied: ['Name the surface', 'State the dwell time'],
  expected_missing: ['Warn about dilution', 'Mention PPE'],
  material_issue: false,
};

const bexJson: unknown = {
  meta: { workbook: 'synthetic-fixture.xlsx', run_url: 'https://example.invalid/admin/tests/run-a' },
  cases: [
    {
      id: 'C1',
      question: 'How do I dilute Fixture Cleaner A for daily mopping?',
      tier: 'Tier 1 (High)',
      category: 'Dilution',
      accuracy: 90,
      relevance: 90,
      clarity: 90,
      concepts: conceptsC1,
      unable_to_evaluate: false,
      ute_reason: null,
      similarity: 0.9,
      eval_confidence: 90,
    },
    {
      id: 'C2',
      question: 'What precautions apply when using Fixture Cleaner B?',
      tier: 'Tier 1 (High)',
      category: 'Dilution',
      accuracy: 80,
      completeness: 40,
      relevance: 80,
      clarity: 80,
      concepts: conceptsC2,
      unable_to_evaluate: false,
      eval_confidence: 85,
    },
    {
      id: 'C3',
      question: 'How is Fixture Finish C applied to a VCT floor?',
      tier: 'Tier 1 (High)',
      category: 'Application and Use',
      accuracy: 80,
      relevance: 80,
      clarity: 80,
      concepts: {
        minimal_required: ['Apply with a mop'],
        minimal_satisfied: ['Apply with a mop'],
        minimal_missing: [],
        expected_required: ['Apply with a mop', 'Allow to dry', 'Two coats', 'Wait 30 minutes between coats'],
        expected_satisfied: ['Apply with a mop', 'Allow to dry', 'Two coats', 'Wait 30 minutes between coats'],
        expected_missing: [],
        material_issue: false,
      },
      unable_to_evaluate: false,
      eval_confidence: 80,
    },
    {
      id: 'C4',
      question: 'Which neutral cleaner suits a school hallway?',
      tier: 'Tier 2 (Med)',
      category: 'Product Recommendation',
      accuracy: 75,
      relevance: 75,
      clarity: 75,
      concepts: {
        minimal_required: [],
        minimal_satisfied: [],
        minimal_missing: [],
        expected_required: ['Recommend a neutral cleaner', 'Name a Betco product', 'State the surface'],
        expected_satisfied: ['Recommend a neutral cleaner', 'Name a Betco product', 'State the surface'],
        expected_missing: [],
        material_issue: false,
      },
      unable_to_evaluate: false,
      eval_confidence: 80,
    },
    {
      id: 'C5',
      question: 'What should I use on a restaurant kitchen floor?',
      tier: 'Tier 2 (Med)',
      category: 'Product Recommendation',
      accuracy: 85,
      relevance: 85,
      clarity: 85,
      concepts: conceptsC5,
      unable_to_evaluate: false,
      eval_confidence: 55,
    },
    {
      id: 'C6',
      question: 'Can Fixture Cleaner D go on a hardwood gym floor?',
      tier: 'Tier 2 (Med)',
      category: 'Product Recommendation',
      accuracy: 60,
      relevance: 60,
      clarity: 60,
      concepts: { ...conceptsC6(true), material_issue_note: 'Recommended the product for wood.' },
      unable_to_evaluate: false,
      eval_confidence: 70,
    },
    {
      id: 'C7',
      question: 'How much Fixture Degreaser E per gallon for heavy soil?',
      tier: 'Tier 1 (High)',
      category: 'Dilution',
      accuracy: 90,
      relevance: 90,
      clarity: 90,
      concepts: {
        minimal_required: ['Dilute 4 oz per gallon'],
        minimal_satisfied: ['Dilute 4 oz per gallon'],
        minimal_missing: [],
        expected_required: [],
        expected_satisfied: [],
        expected_missing: [],
        material_issue: false,
      },
      unable_to_evaluate: false,
      eval_confidence: 88,
    },
    {
      id: 'C9',
      question: 'Is Fixture Sanitizer F safe on food-contact surfaces?',
      tier: 'Tier 3 (Low)',
      category: 'Safety',
      accuracy: 60,
      relevance: 60,
      clarity: 60,
      concepts: conceptsC9,
      unable_to_evaluate: false,
      eval_confidence: 90,
    },
  ],
};

const desktopJson: unknown = {
  meta: { workbook: 'synthetic-fixture.xlsx' },
  cases: [
    {
      id: 'C1',
      question: 'How do I dilute Fixture Cleaner A for daily mopping?',
      tier: 'Tier 1 (High)',
      category: 'Dilution',
      accuracy: 90,
      relevance: 90,
      clarity: 90,
      concepts: conceptsC1,
      unable_to_evaluate: false,
      eval_confidence: 90,
    },
    {
      id: 'C2',
      question: 'What precautions apply when using Fixture Cleaner B?',
      tier: 'Tier 1 (High)',
      category: 'Dilution',
      accuracy: 70,
      relevance: 80,
      clarity: 80,
      // Derived numbers a desktop file may carry — must be ignored, Bex recomputes.
      overall: 10,
      grade: 'F',
      status: 'Fail',
      concepts: conceptsC2,
      unable_to_evaluate: false,
      eval_confidence: 80,
    },
    {
      id: 'C3',
      question: 'How is Fixture Finish C applied to a VCT floor?',
      tier: 'Tier 1 (High)',
      category: 'Application and Use',
      accuracy: 80,
      relevance: 80,
      clarity: 80,
      concepts: {
        minimal_required: ['Apply with a mop'],
        // Same mandatory verdict, different spelling — normConcept must equate them.
        minimal_satisfied: ['apply with a mop.'],
        minimal_missing: [],
        expected_required: ['Apply with a mop', 'Allow to dry', 'Two coats', 'Wait 30 minutes between coats'],
        expected_satisfied: ['Apply with a mop', 'Allow to dry'],
        expected_missing: ['Two coats', 'Wait 30 minutes between coats'],
        material_issue: false,
      },
      unable_to_evaluate: false,
      eval_confidence: 75,
    },
    {
      id: 'C4',
      question: 'Which neutral cleaner suits a school hallway?',
      tier: 'Tier 2 (Med)',
      category: 'Product Recommendation',
      unable_to_evaluate: true,
      ute_reason: 'No actual response matched this golden question.',
    },
    {
      id: 'C5',
      question: 'What should I use on a restaurant kitchen floor?',
      tier: 'Tier 2 (Med)',
      category: 'Product Recommendation',
      accuracy: 85,
      relevance: 85,
      clarity: 85,
      concepts: conceptsC5,
      unable_to_evaluate: false,
      eval_confidence: 71,
    },
    {
      id: 'C6',
      question: 'Can Fixture Cleaner D go on a hardwood gym floor?',
      tier: 'Tier 2 (Med)',
      category: 'Product Recommendation',
      accuracy: 70,
      relevance: 60,
      clarity: 60,
      concepts: conceptsC6(false),
      unable_to_evaluate: false,
      eval_confidence: 65,
    },
    {
      id: 'C7',
      question: 'How much Fixture Degreaser E per gallon for heavy soil?',
      tier: 'Tier 1 (High)',
      category: 'Dilution',
      accuracy: 90,
      relevance: 90,
      clarity: 90,
      concepts: {
        minimal_required: ['Dilute 4 oz per gallon'],
        minimal_satisfied: ['Dilute 4 oz per gallon'],
        minimal_missing: [],
        expected_required: ['Dilute 4 oz per gallon', 'Use cold water'],
        expected_satisfied: ['Dilute 4 oz per gallon', 'Use cold water'],
        expected_missing: [],
        material_issue: false,
      },
      unable_to_evaluate: false,
      eval_confidence: 88,
    },
    {
      id: 'C8',
      question: 'A case only the desktop file graded.',
      tier: 'Tier 2 (Med)',
      category: 'Dilution',
      accuracy: 50,
      relevance: 50,
      clarity: 50,
      concepts: { expected_required: ['Anything'], expected_satisfied: ['Anything'], expected_missing: [] },
      unable_to_evaluate: false,
      eval_confidence: 60,
    },
    {
      id: 'C9',
      question: 'Is Fixture Sanitizer F safe on food-contact surfaces?',
      tier: 'Tier 3 (Low)',
      category: 'Safety',
      accuracy: 70,
      relevance: 60,
      clarity: 60,
      concepts: conceptsC9,
      unable_to_evaluate: false,
      eval_confidence: 90,
    },
  ],
};

function load(json: unknown): EvalFile {
  const parsed = parseEvalFile(json);
  if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
  return parsed.data;
}

/** The same file with a `scoring_config` block bolted on — the skill's per-run override. */
function withScoringConfig(file: EvalFile, scoringConfig: unknown): EvalFile {
  return { ...file, scoring_config: scoringConfig };
}

const bex = load(bexJson);
const desktop = load(desktopJson);
const result = compareEvalRuns(bex, desktop);
const rows = new Map(result.cases.map((c) => [c.id, c]));
const row = (id: string) => {
  const found = rows.get(id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};

describe('parseEvalFile', () => {
  it('accepts both fixtures and passes unknown keys through', () => {
    expect(bex.cases).toHaveLength(8);
    expect(desktop.cases).toHaveLength(9);
    const c2 = desktop.cases[1] as Record<string, unknown>;
    expect(c2.overall).toBe(10);
    expect(c2.status).toBe('Fail');
  });

  it('rejects a case without an id and an out-of-range sub-score, naming the path', () => {
    const noId = parseEvalFile({ cases: [{ question: 'x' }] });
    expect(noId.ok).toBe(false);
    if (!noId.ok) expect(noId.issues.some((i) => i.startsWith('cases.0.id:'))).toBe(true);

    const outOfRange = parseEvalFile({ cases: [{ id: 'X', accuracy: 101 }] });
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.issues.some((i) => i.startsWith('cases.0.accuracy:'))).toBe(true);

    expect(parseEvalFile({ cases: 'nope' }).ok).toBe(false);
    expect(parseEvalFile(null).ok).toBe(false);
  });

  it('carries a malformed scoring_config through rather than failing the parse', () => {
    const parsed = parseEvalFile({ scoring_config: 'nope', cases: [] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data.scoring_config).toBe('nope');
  });
});

describe('per-case comparison (the B0-835 pipeline on both sides)', () => {
  it('C1 identical: same overall, every agreement true, no review flag, no rule fired', () => {
    const c = row('C1');
    expect(c.compared).toBe(true);
    expect(c.a.completenessJudged).toBeNull();
    expect(c.a.coveragePct).toBe(100);
    expect(c.a.completeness).toBe(100);
    expect(c.a.overall).toBe(93);
    expect(c.b.overall).toBe(93);
    expect(c.delta).toBe(0);
    expect(c.statusAgree).toBe(true);
    expect(c.mandatoryAgree).toBe(true);
    expect(c.expectedAgree).toBe(true);
    expect(c.materialIssueAgree).toBe(true);
    expect(c.reviewA).toBe(false);
    expect(c.reviewB).toBe(false);
    expect(c.conceptDisagreement).toBe(false);
    expect(c.spread).toBe(false);
    expect(c.spreadExplained).toBeNull();
    // Full expected coverage qualifies for the automatic Pass, but the rubric already passed it.
    expect(c.a.statusSource).toBe('rubric');
    expect(formatSideRules(c.a)).toBe('—');
  });

  it('C2 reads the judged Completeness and applies the mandatory floor; derived numbers ignored', () => {
    const c = row('C2');
    // A's judged 40 is BELOW the 75 coverage, so the cap does not bind and the judged value stands.
    expect(c.a.completenessJudged).toBe(40);
    expect(c.a.coveragePct).toBe(75);
    expect(c.a.completeness).toBe(40);
    expect(c.a.coverageApplied).toBe(false);
    expect(c.a.weighted).toBe(68); // 32 + 12 + 16 + 8
    // Every mandatory concept satisfied, so the floor raises it to a C.
    expect(c.a.floorApplied).toBe(true);
    expect(c.a.floor).toBe(70);
    expect(c.a.overall).toBe(70);
    expect(c.a.preGateScore).toBe(70);
    expect(c.a.status).toBe('Pass');
    expect(formatSideRules(c.a)).toBe('floor 70');
    // B carries no judged Completeness, so coverage is the only Completeness it has.
    expect(c.b.completenessJudged).toBeNull();
    expect(c.b.completeness).toBe(75);
    expect(c.b.overall).toBe(75); // 28 + 22.5 + 16 + 8 = 74.5 → half-up, not the file's 10
    expect(c.b.floorApplied).toBe(false);
    expect(c.b.status).toBe('Pass'); // not the file's "Fail"
    expect(c.delta).toBe(5);
    expect(c.statusAgree).toBe(true);
    expect(c.conceptDisagreement).toBe(false);
    expect(c.spread).toBe(false);
  });

  it('C3 concept disagreement moves Completeness, produces a spread that is explained', () => {
    const c = row('C3');
    expect(c.a.completeness).toBe(100);
    expect(c.b.completeness).toBe(50);
    expect(c.a.overall).toBe(86);
    expect(c.b.overall).toBe(71);
    expect(c.delta).toBe(15);
    expect(c.statusAgree).toBe(true);
    // "Apply with a mop" vs "apply with a mop." — same verdict once normalised.
    expect(c.mandatoryAgree).toBe(true);
    expect(c.expectedAgree).toBe(false);
    expect(c.conceptDisagreement).toBe(true);
    expect(c.spread).toBe(true);
    expect(c.spreadExplained).toBe(true);
    // Neither side was moved by a rule: the whole 15 points is judgment.
    expect(formatSideRules(c.a)).toBe('—');
    expect(formatSideRules(c.b)).toBe('—');
  });

  it('C4 UTE on one side is matched but not compared, with the reason carried through', () => {
    const c = row('C4');
    expect(c.compared).toBe(false);
    expect(c.a.unableToEvaluate).toBe(false);
    expect(c.a.overall).toBe(83); // 30 + 30 + 15 + 7.5 = 82.5 → half-up
    // A blank mandatory column specifies nothing, so neither bound applies.
    expect(c.a.floorApplied).toBe(false);
    expect(c.a.ceilingApplied).toBe(false);
    expect(c.b.unableToEvaluate).toBe(true);
    expect(c.b.uteReason).toBe('No actual response matched this golden question.');
    expect(c.b.overall).toBeNull();
    expect(c.b.preGateScore).toBeNull();
    expect(c.b.statusSource).toBeNull();
    expect(c.delta).toBeNull();
    expect(c.statusAgree).toBeNull();
    expect(c.mandatoryAgree).toBeNull(); // B recorded no concepts block
    expect(c.materialIssueAgree).toBeNull();
    expect(c.reviewB).toBe(false);
  });

  it('C5 review queue: A queued at 55, B not at 71, no overlap', () => {
    const c = row('C5');
    expect(c.a.completeness).toBe(80);
    expect(c.a.overall).toBe(84); // 34 + 24 + 17 + 8.5 = 83.5 → half-up
    expect(c.b.overall).toBe(84);
    expect(c.reviewA).toBe(true);
    expect(c.reviewB).toBe(false);
    expect(c.reviewOverlap).toBe(false);
    expect(c.statusAgree).toBe(true);
  });

  it('C6 mandatory miss: the ceiling caps B at 59, both sides are gated to Fail', () => {
    const c = row('C6');
    // A's arithmetic is already under the ceiling, so the cap has nothing to do — but the gate
    // still decides the Result, and that is the difference the spread table has to be able to show.
    expect(c.a.weighted).toBe(57); // 24 + 15 + 12 + 6
    expect(c.a.preGateScore).toBe(57);
    expect(c.a.ceilingApplied).toBe(false);
    expect(c.a.ceiling).toBeNull();
    expect(c.a.overall).toBe(57);
    expect(c.a.status).toBe('Fail');
    expect(c.a.statusSource).toBe('minimal_gate');
    expect(formatSideRules(c.a)).toBe('gate');
    // B scored 61 on the rubric and is capped to 59 — grade F, Fail, by arithmetic.
    expect(c.b.weighted).toBe(61); // 28 + 15 + 12 + 6
    expect(c.b.preGateScore).toBe(61);
    expect(c.b.ceilingApplied).toBe(true);
    expect(c.b.ceiling).toBe(59);
    expect(c.b.overall).toBe(59);
    expect(c.b.grade).toBe('F');
    expect(c.b.status).toBe('Fail');
    expect(c.b.statusSource).toBe('minimal_gate');
    expect(formatSideRules(c.b)).toBe('ceiling 59, gate');
    expect(c.delta).toBe(2);
    expect(c.statusAgree).toBe(true);
    expect(c.mandatoryAgree).toBe(true);
    expect(c.expectedAgree).toBe(true);
    expect(c.conceptDisagreement).toBe(false);
    expect(c.a.materialIssue).toBe(true);
    expect(c.b.materialIssue).toBe(false);
    expect(c.materialIssueAgree).toBe(false);
    expect(c.reviewA).toBe(true); // eval_confidence 70 — Bex's queue is "at or below" (metrics.ts)
    expect(c.reviewB).toBe(true);
    expect(c.reviewOverlap).toBe(true);
  });

  it('C7 no expected concepts on one side is Unable to Evaluate with the metrics.ts reason', () => {
    const c = row('C7');
    expect(c.compared).toBe(false);
    expect(c.a.unableToEvaluate).toBe(true);
    expect(c.a.uteReason).toBe(NO_EXPECTED_CONCEPTS_UTE_REASON);
    expect(c.b.overall).toBe(93);
  });

  it('C9 blank mandatory column: no bound fires, so the rubric alone flips Pass/Fail', () => {
    const c = row('C9');
    expect(c.a.overall).toBe(57);
    expect(c.a.status).toBe('Fail');
    expect(c.a.statusSource).toBe('rubric');
    expect(c.b.overall).toBe(61);
    expect(c.b.status).toBe('Pass');
    expect(c.b.statusSource).toBe('rubric');
    expect(c.delta).toBe(4);
    expect(c.statusAgree).toBe(false);
    expect(c.conceptDisagreement).toBe(false);
    expect(formatSideRules(c.a)).toBe('—');
    expect(formatSideRules(c.b)).toBe('—');
  });

  it('pairs by id: C8 exists only in the desktop file', () => {
    expect(rows.has('C8')).toBe(false);
    expect(result.rollup.unmatchedA).toEqual([]);
    expect(result.rollup.unmatchedB).toEqual(['C8']);
  });
});

describe('rollups (hand-computed, over the 6 compared cases)', () => {
  const r = result.rollup;

  it('reports the rules both sides were recomputed under', () => {
    expect(r.scoringRules).toEqual(DEFAULT_SCORING_RULES);
    expect(r.scoringConfigDeclaredA).toBe(false);
    expect(r.scoringConfigDeclaredB).toBe(false);
    expect(r.scoringConfigWarnings).toEqual([]);
  });

  it('counts, Δ statistics and Pass/Fail agreement', () => {
    expect(r.passMark).toBe(60);
    expect(r.spreadThreshold).toBe(DEFAULT_SPREAD_THRESHOLD);
    expect(r.reviewThreshold).toBe(70);
    expect(r.matched).toBe(8);
    expect(r.compared).toBe(6);
    expect(r.uteEither).toBe(2);
    expect(r.medianDelta).toBe(3); // [0, 0, 2, 4, 5, 15] → (2 + 4) / 2
    expect(r.meanDelta).toBe(4.3); // 26 / 6 = 4.333 → half-up
    expect(r.statusAgreement).toEqual({ agree: 5, of: 6, pct: 83.3 });
  });

  it('lists spread cases with the pre-gate scores and the rules behind each side', () => {
    expect(r.spreadCases).toEqual([
      {
        id: 'C3',
        overallA: 86,
        overallB: 71,
        delta: 15,
        explained: true,
        preGateA: 86,
        preGateB: 71,
        rulesA: '—',
        rulesB: '—',
      },
    ]);
  });

  it('per-side overall avg, grade and pass rate', () => {
    // A: 93, 70, 86, 84, 57, 57 = 447 → 74.5 (C); 4 Pass.  B: 93, 75, 71, 84, 59, 61 = 443 → 73.8 (C); 5 Pass.
    expect(r.sideA).toEqual({ n: 6, avg: 74.5, grade: 'C', pass: 4, passPct: 66.7 });
    expect(r.sideB).toEqual({ n: 6, avg: 73.8, grade: 'C', pass: 5, passPct: 83.3 });
  });

  it('tier and category tables', () => {
    expect(r.tiers).toEqual([
      { key: 'Tier 1 (High)', n: 3, avgA: 83, avgB: 79.7, agree: 3, agreementPct: 100 }, // 249/3, 239/3
      { key: 'Tier 2 (Med)', n: 2, avgA: 70.5, avgB: 71.5, agree: 2, agreementPct: 100 },
      { key: 'Tier 3 (Low)', n: 1, avgA: 57, avgB: 61, agree: 0, agreementPct: 0 },
    ]);
    expect(r.categories).toEqual([
      { key: 'Application and Use', n: 1, avgA: 86, avgB: 71, agree: 1, agreementPct: 100 },
      { key: 'Dilution', n: 2, avgA: 81.5, avgB: 84, agree: 2, agreementPct: 100 },
      { key: 'Product Recommendation', n: 2, avgA: 70.5, avgB: 71.5, agree: 2, agreementPct: 100 },
      { key: 'Safety', n: 1, avgA: 57, avgB: 61, agree: 0, agreementPct: 0 },
    ]);
  });

  it('review-queue overlap as a Jaccard index', () => {
    expect(r.reviewQueue).toEqual({ a: ['C5', 'C6'], b: ['C6'], overlap: ['C6'], union: 2, jaccard: 0.5 });
  });

  it('evaluates the proposed targets and marks each as proposed', () => {
    expect(r.targets.map((t) => t.met)).toEqual([true, false, true]);
    expect(r.targets.map((t) => t.actual)).toEqual(['3', '83.3% (5/6)', '1/1']);
    for (const t of r.targets) expect(t.note).toBe(PROPOSED_TARGET_NOTE);
  });
});

describe('options', () => {
  it('pass mark 70 turns the C9 flip into an agreement (57 Fail / 61 Fail)', () => {
    const strict = compareEvalRuns(bex, desktop, { passMark: 70 });
    const c9 = strict.cases.find((c) => c.id === 'C9');
    expect(c9?.a.status).toBe('Fail');
    expect(c9?.b.status).toBe('Fail');
    expect(c9?.statusAgree).toBe(true);
    expect(strict.rollup.passMark).toBe(70);
    expect(strict.rollup.statusAgreement).toEqual({ agree: 6, of: 6, pct: 100 });
    expect(strict.rollup.targets[1].met).toBe(true);
    expect(strict.rollup.sideB.pass).toBe(4); // C9 (61) now fails on B too
  });

  it('spread threshold 4 flags C2, C3 and C9 — only C3 is explained', () => {
    const wide = compareEvalRuns(bex, desktop, { spreadThreshold: 4 });
    expect(wide.rollup.spreadCases.map((s) => [s.id, s.explained])).toEqual([
      ['C2', false],
      ['C3', true],
      ['C9', false],
    ]);
    // C2's spread is a rule outcome, not a judgment gap: A's judged Completeness was floored.
    expect(wide.rollup.spreadCases[0]).toMatchObject({ preGateA: 70, preGateB: 75, rulesA: 'floor 70', rulesB: '—' });
    expect(wide.rollup.targets[2].actual).toBe('1/3');
    expect(wide.rollup.targets[2].met).toBe(false);
  });

  it('review threshold 60 empties the desktop queue', () => {
    const low = compareEvalRuns(bex, desktop, { reviewThreshold: 60 });
    expect(low.rollup.reviewQueue).toEqual({ a: ['C5'], b: [], overlap: [], union: 1, jaccard: 0 });
  });

  it('even-count median is the half-up one-decimal mean of the middle two', () => {
    const keep = new Set(['C1', 'C2', 'C6', 'C9']);
    const subset = (file: EvalFile): EvalFile => ({ ...file, cases: file.cases.filter((c) => keep.has(c.id)) });
    const four = compareEvalRuns(subset(bex), subset(desktop));
    expect(four.rollup.compared).toBe(4);
    expect(four.rollup.medianDelta).toBe(3); // [0, 2, 4, 5] → (2 + 4) / 2
    expect(four.rollup.meanDelta).toBe(2.8); // 11 / 4 = 2.75 → half-up
    // Only C6 is queued, on both sides.
    expect(four.rollup.reviewQueue).toEqual({ a: ['C6'], b: ['C6'], overlap: ['C6'], union: 1, jaccard: 1 });
  });

  it('labels the two sides', () => {
    const labelled = compareEvalRuns(bex, desktop, { labelA: 'Bex (Opus 5, 3 passes)', labelB: 'Colleague' });
    expect(renderParityMarkdown(labelled)).toContain('# Grading parity — Bex (Opus 5, 3 passes) vs Colleague (B0-824)');
  });
});

describe('the expected-coverage cap (Rule 3)', () => {
  const capped = (completeness: number | null): unknown => ({
    cases: [
      {
        id: 'K1',
        question: 'Which dilution applies to a heavy soil load?',
        tier: 'Tier 1 (High)',
        category: 'Dilution',
        accuracy: 80,
        ...(completeness == null ? {} : { completeness }),
        relevance: 80,
        clarity: 80,
        concepts: {
          minimal_required: [],
          minimal_satisfied: [],
          minimal_missing: [],
          expected_required: ['Dilute 2 oz per gallon', '10 minute contact time'],
          expected_satisfied: ['Dilute 2 oz per gallon'],
          expected_missing: ['10 minute contact time'],
          material_issue: false,
        },
      },
    ],
  });

  it('caps a judged Completeness above the coverage share, and leaves one below it alone', () => {
    const generous = compareEvalRuns(load(capped(100)), load(capped(40)));
    const c = generous.cases[0];
    // A judged 100 on 1-of-2 coverage: capped to 50, and the judged value is kept for reporting.
    expect(c.a.completenessJudged).toBe(100);
    expect(c.a.coveragePct).toBe(50);
    expect(c.a.completeness).toBe(50);
    expect(c.a.coverageApplied).toBe(true);
    expect(c.a.overall).toBe(71); // 32 + 15 + 16 + 8
    expect(formatSideRules(c.a)).toBe('coverage cap 50');
    // B judged 40, below the 50 coverage: the cap only ever lowers, so 40 stands and nothing fired.
    expect(c.b.completenessJudged).toBe(40);
    expect(c.b.completeness).toBe(40);
    expect(c.b.coverageApplied).toBe(false);
    expect(c.b.overall).toBe(68); // 32 + 12 + 16 + 8
    expect(formatSideRules(c.b)).toBe('—');
    expect(c.delta).toBe(3);
  });

  it('falls back to the coverage share when a file carries no judged Completeness', () => {
    const none = compareEvalRuns(load(capped(null)), load(capped(null)));
    const c = none.cases[0];
    expect(c.a.completenessJudged).toBeNull();
    expect(c.a.completeness).toBe(50);
    // Nothing was capped: there was no grader judgment to move.
    expect(c.a.coverageApplied).toBe(false);
    expect(c.a.overall).toBe(71);
  });
});

describe('applyScoringOverrides (port of concept_rules.apply_scoring_overrides)', () => {
  it('returns the shipped defaults, undeclared, for a missing block', () => {
    const resolved = applyScoringOverrides(undefined);
    expect(resolved.declared).toBe(false);
    expect(resolved.passMarkDeclared).toBe(false);
    expect(resolved.rules).toEqual(DEFAULT_SCORING_RULES);
    expect(resolved.passMark).toBe(60);
    expect(resolved.warnings).toEqual([]);
  });

  it('honours every recognised key', () => {
    const resolved = applyScoringOverrides({
      pass_mark: { score: 70 },
      minimal_gate: { enabled: false },
      minimal_floor: { enabled: true, score: 65, respect_material_issue: false },
      minimal_ceiling: { enabled: false, score: 55 },
      expected_coverage: { enabled: false },
    });
    expect(resolved.declared).toBe(true);
    expect(resolved.passMarkDeclared).toBe(true);
    expect(resolved.passMark).toBe(70);
    expect(resolved.rules).toEqual({
      minimalGate: { enabled: false },
      minimalFloor: { enabled: true, score: 65, respectMaterialIssue: false },
      minimalCeiling: { enabled: false, score: 55 },
      expectedCoverage: { enabled: false },
    });
    expect(resolved.warnings).toEqual([]);
  });

  it('warns and keeps the default for a bad block, a bad section, an unknown key or a bad value', () => {
    expect(applyScoringOverrides('nope').warnings).toEqual([
      'scoring config: expected an object, got string; ignored',
    ]);
    expect(applyScoringOverrides([1, 2]).declared).toBe(false);

    const messy = applyScoringOverrides(
      {
        minimal_gate: 'on',
        minimal_floor: { enabled: 'yes', score: 150, nonsense: 1 },
        minimal_ceiling: { score: 59 },
        pass_mark: { score: 'sixty' },
      },
      'Bex: scoring_config',
    );
    expect(messy.declared).toBe(true);
    expect(messy.passMarkDeclared).toBe(false);
    expect(messy.passMark).toBe(60);
    expect(messy.rules).toEqual(DEFAULT_SCORING_RULES);
    expect(messy.warnings).toEqual([
      'Bex: scoring_config: pass_mark.score must be a number 0-100 (got "sixty"); kept 60',
      "Bex: scoring_config: 'minimal_gate' expected an object, got string; ignored",
      'Bex: scoring_config: minimal_floor.enabled must be true or false (got "yes"); kept true',
      'Bex: scoring_config: minimal_floor.score must be a number 0-100 (got 150); kept 70',
      "Bex: scoring_config: unknown key 'minimal_floor.nonsense' ignored (known: enabled, respect_material_issue, score)",
    ]);
  });
});

describe('scoring_config on the eval.json files', () => {
  const gatedCase = {
    id: 'G1',
    question: 'What contact time does the label state?',
    tier: 'Tier 1 (High)',
    category: 'Efficacy',
    accuracy: 90,
    relevance: 90,
    clarity: 90,
    concepts: {
      minimal_required: ['10 minute contact time'],
      minimal_satisfied: [],
      minimal_missing: ['10 minute contact time'],
      expected_required: ['10 minute contact time', 'Name a Betco product'],
      expected_satisfied: ['Name a Betco product'],
      expected_missing: ['10 minute contact time'],
      material_issue: false,
    },
    eval_confidence: 90,
  };
  const gated = load({ cases: [gatedCase] });

  it('under the shipped defaults the missing must-have caps the case at 59 and fails it', () => {
    const c = compareEvalRuns(gated, gated).cases[0];
    expect(c.a.weighted).toBe(78); // 36 + 15 + 18 + 9
    expect(c.a.preGateScore).toBe(78);
    expect(c.a.ceilingApplied).toBe(true);
    expect(c.a.overall).toBe(59);
    expect(c.a.grade).toBe('F');
    expect(c.a.status).toBe('Fail');
    expect(c.a.statusSource).toBe('minimal_gate');
  });

  it("honours a declared scoring_config, and a declared pass mark outranks the caller's", () => {
    const config = { minimal_gate: { enabled: false }, pass_mark: { score: 70 } };
    const relaxed = compareEvalRuns(
      withScoringConfig(gated, config),
      withScoringConfig(gated, config),
      { passMark: 60 },
    );
    const c = relaxed.cases[0];
    // The gate is off, so the ceiling must not fire either — it exists to express the gate.
    expect(c.a.ceilingApplied).toBe(false);
    expect(c.a.overall).toBe(78);
    expect(c.a.status).toBe('Pass');
    expect(c.a.statusSource).toBe('rubric');
    expect(relaxed.rollup.passMark).toBe(70);
    expect(relaxed.rollup.scoringRules.minimalGate.enabled).toBe(false);
    expect(relaxed.rollup.scoringConfigDeclaredA).toBe(true);
    expect(relaxed.rollup.scoringConfigDeclaredB).toBe(true);
    expect(relaxed.rollup.scoringConfigWarnings).toEqual([
      'Bex: scoring_config declares pass_mark.score 70, which overrides the pass mark 60 given by the caller.',
      'Desktop: scoring_config declares pass_mark.score 70, which overrides the pass mark 60 given by the caller.',
    ]);

    const md = renderParityMarkdown(relaxed);
    expect(md).toContain('| Pass mark | ≥ 70 rates Pass |');
    expect(md).toContain('| Mandatory gate (Rule 1) | off |');
    expect(md).toContain('| Source | declared in both files |');
    expect(md).toContain('Warnings from the declared `scoring_config`');
  });

  it('surfaces a declared block that only one side carries', () => {
    const config = { minimal_floor: { enabled: true, score: 70, respect_material_issue: true } };
    const one = compareEvalRuns(withScoringConfig(gated, config), gated);
    expect(one.rollup.scoringConfigDeclaredA).toBe(true);
    expect(one.rollup.scoringConfigDeclaredB).toBe(false);
    expect(renderParityMarkdown(one)).toContain('| Source | declared in Bex only |');
  });

  it('refuses to compare two files whose configs resolve differently, naming both', () => {
    const a = withScoringConfig(gated, { minimal_gate: { enabled: false } });
    expect(() => compareEvalRuns(a, gated)).toThrow(/different scoring_config rules/);
    expect(() => compareEvalRuns(a, gated)).toThrow(/Bex: pass mark 60; mandatory gate off/);
    expect(() => compareEvalRuns(a, gated)).toThrow(/Desktop: pass mark 60; mandatory gate on/);
    expect(() => compareEvalRuns(a, gated)).toThrow(/\[declared in the file\]/);
    expect(() => compareEvalRuns(a, gated)).toThrow(/\[shipped defaults\]/);

    // Two declarations that differ only in a pass mark are just as unusable.
    expect(() =>
      compareEvalRuns(
        withScoringConfig(gated, { pass_mark: { score: 60 } }),
        withScoringConfig(gated, { pass_mark: { score: 70 } }),
      ),
    ).toThrow(/different scoring_config rules/);

    // Identical declarations are fine.
    const config = { minimal_ceiling: { enabled: false } };
    expect(() => compareEvalRuns(withScoringConfig(gated, config), withScoringConfig(gated, config))).not.toThrow();
  });

  it('resolveScoringConfig reports one configuration for both sides', () => {
    const resolved = resolveScoringConfig(gated, gated, { labelA: 'Bex', labelB: 'Desktop' });
    expect(resolved).toEqual({
      rules: DEFAULT_SCORING_RULES,
      passMark: 60,
      declaredA: false,
      declaredB: false,
      warnings: [],
    });
  });

  it('describeScoringRules names every rule in one line', () => {
    expect(describeScoringRules(DEFAULT_SCORING_RULES, 60)).toBe(
      'pass mark 60; mandatory gate on; ceiling on at 59; floor on at 70 (withheld on a material factual issue); expected-coverage cap on',
    );
  });
});

describe('renderParityMarkdown', () => {
  const md = renderParityMarkdown(result);

  it('states the full pipeline and the rules in force', () => {
    expect(md).toContain('Completeness = min(judged Completeness, expected-concept coverage)');
    expect(md).toContain('overall = 0.40·A + 0.30·C + 0.20·R + 0.10·Cl (half-up)');
    expect(md).toContain('raised to at least 70, unless a material factual issue is flagged');
    expect(md).toContain('the Pre-Gate Content Score is captured there, before the cap');
    expect(md).toContain('capped at 59');
    expect(md).toContain('Pass at ≥ 60.');
    expect(md).toContain('## Rules in force');
    expect(md).toContain('| Pass mark | ≥ 60 rates Pass |');
    expect(md).toContain('| Mandatory gate (Rule 1) | on |');
    expect(md).toContain('| Mandatory ceiling | on — capped at 59 |');
    expect(md).toContain('| Mandatory floor (Rule 1b) | on — raised to 70, withheld on a material factual issue |');
    expect(md).toContain('| Expected-coverage cap (Rule 3) | on |');
    expect(md).toContain('| Source | the shipped defaults (neither file declares a scoring_config) |');
    expect(md).not.toContain('Warnings from the declared');
  });

  it('renders the rollups, the proposed targets and the per-case rows', () => {
    expect(md).toContain('# Grading parity — Bex vs Desktop (B0-824)');
    expect(md).toContain('| Only in Desktop | C8 |');
    expect(md).toContain('| Compared (both evaluable) | 6 |');
    expect(md).toContain('| Median Δ | 3 |');
    expect(md).toContain('| Pass/Fail agreement | 5/6 (83.3%) |');
    expect(md).toContain('| Review-queue overlap (Jaccard) | 1 of 2 (0.5) |');
    expect(md).toContain('| Overall avg | 74.5 | 73.8 |');
    expect(md).toContain(`## Targets (${PROPOSED_TARGET_NOTE})`);
    expect(md.split(PROPOSED_TARGET_NOTE).length - 1).toBe(4); // heading + one per target
    expect(md).toContain('| C3 | 86 | 71 | 15 | 86 | 71 | — | — | yes |');
    expect(md).toContain('| Tier 1 (High) | 3 | 83 | 79.7 | 3/3 (100%) |');
    expect(md).toContain('| Dilution | 2 | 81.5 | 84 | 2/2 (100%) |');
    expect(md).toContain(
      '| C3 | How is Fixture Finish C applied to a VCT floor? | 86 Pass | 71 Pass | 15 | yes | yes | no | yes | no | no | yes |',
    );
    expect(md).toContain('| C4 | Which neutral cleaner suits a school hallway? | 83 Pass | UTE | — | n/a | n/a | n/a | n/a | no | no | no |');
    expect(md).toContain('| C4 | Desktop | No actual response matched this golden question. |');
  });

  it('names the rules that moved a side in its own cell, so a row explains its number', () => {
    expect(md).toContain(
      '| C2 | What precautions apply when using Fixture Cleaner B? | 70 Pass (floor 70) | 75 Pass | 5 | yes | yes | yes | yes | no | no | no |',
    );
    expect(md).toContain(
      '| C6 | Can Fixture Cleaner D go on a hardwood gym floor? | 57 Fail (gate) | 59 Fail (ceiling 59, gate) | 2 | yes | yes | yes | no | yes | yes | no |',
    );
  });

  it('escapes pipes and truncates long questions so a table cell cannot break the row', () => {
    const long = 'x'.repeat(100);
    const one: unknown = {
      cases: [
        {
          id: 'P1',
          question: `a | b ${long}`,
          accuracy: 50,
          relevance: 50,
          clarity: 50,
          concepts: { expected_required: ['k'], expected_satisfied: ['k'], expected_missing: [] },
        },
      ],
    };
    const file = load(one);
    const out = renderParityMarkdown(compareEvalRuns(file, file));
    expect(out).toContain('| P1 | a \\| b xxx');
    expect(out).toContain('…');
    expect(out).not.toContain(long);
  });
});
