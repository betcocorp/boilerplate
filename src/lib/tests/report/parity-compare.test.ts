import { describe, expect, it } from 'vitest';

import { NO_EXPECTED_CONCEPTS_UTE_REASON } from './metrics';
import {
  compareEvalRuns,
  DEFAULT_SPREAD_THRESHOLD,
  parseEvalFile,
  PROPOSED_TARGET_NOTE,
  renderParityMarkdown,
  type EvalFile,
} from './parity-compare';

/**
 * B0-824 — Bex vs desktop parity comparison, pinned against two hand-scored synthetic eval.json
 * fixtures (the same data as the scratchpad pair the CLI is smoke-tested on). Every expected number
 * below is computed by hand the Bex way: Completeness = 100 × expected satisfied / required,
 * overall = 0.40·A + 0.30·C + 0.20·R + 0.10·Cl rounded half-up, Pass at ≥ 60.
 *
 * Per case (A = "Bex" side, B = "Desktop" side):
 *   C1 identical                → 93 / 93
 *   C2 sub-score-only difference → A 78.5→79 (judged completeness 40 in the file is ignored), B 74.5→75
 *                                  (B also carries derived overall/grade/status that must be ignored)
 *   C3 concept disagreement      → A 4/4 expected → 86; B 2/4 → 71; Δ 15 = spread, explained
 *   C4 UTE on one side           → A 82.5→83; B unable_to_evaluate
 *   C5 review-queue case         → 84 / 84; A eval_confidence 55 (queued), B 71 (not)
 *   C6 Pass/Fail flip            → A 57 Fail (material issue), B 61 Pass; both queued (70 is at-or-below)
 *   C7 no expected concepts on A → A UTE, B 93
 *   C8 only in B                 → unmatched
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
  ],
};

function load(json: unknown): EvalFile {
  const parsed = parseEvalFile(json);
  if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
  return parsed.data;
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
    expect(bex.cases).toHaveLength(7);
    expect(desktop.cases).toHaveLength(8);
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
});

describe('per-case comparison (Bex scoring on both sides)', () => {
  it('C1 identical: same overall, every agreement true, no review flag', () => {
    const c = row('C1');
    expect(c.compared).toBe(true);
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
  });

  it('C2 sub-score-only: ignores the judged completeness and the derived overall/status in the files', () => {
    const c = row('C2');
    expect(c.a.completeness).toBe(75); // 3/4 expected, not the file's 40
    expect(c.a.overall).toBe(79); // 32 + 22.5 + 16 + 8 = 78.5 → half-up
    expect(c.b.completeness).toBe(75);
    expect(c.b.overall).toBe(75); // 28 + 22.5 + 16 + 8 = 74.5 → half-up, not the file's 10
    expect(c.b.status).toBe('Pass'); // not the file's "Fail"
    expect(c.delta).toBe(4);
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
  });

  it('C4 UTE on one side is matched but not compared, with the reason carried through', () => {
    const c = row('C4');
    expect(c.compared).toBe(false);
    expect(c.a.unableToEvaluate).toBe(false);
    expect(c.a.overall).toBe(83); // 30 + 30 + 15 + 7.5 = 82.5 → half-up
    expect(c.b.unableToEvaluate).toBe(true);
    expect(c.b.uteReason).toBe('No actual response matched this golden question.');
    expect(c.b.overall).toBeNull();
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

  it('C6 Pass/Fail flip with a material-issue disagreement; 70 is at-or-below the review threshold', () => {
    const c = row('C6');
    expect(c.a.overall).toBe(57);
    expect(c.a.status).toBe('Fail');
    expect(c.b.overall).toBe(61);
    expect(c.b.status).toBe('Pass');
    expect(c.delta).toBe(4);
    expect(c.statusAgree).toBe(false);
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

  it('pairs by id: C8 exists only in the desktop file', () => {
    expect(rows.has('C8')).toBe(false);
    expect(result.rollup.unmatchedA).toEqual([]);
    expect(result.rollup.unmatchedB).toEqual(['C8']);
  });
});

describe('rollups (hand-computed, over the 5 compared cases)', () => {
  const r = result.rollup;

  it('counts, Δ statistics and Pass/Fail agreement', () => {
    expect(r.passMark).toBe(60);
    expect(r.spreadThreshold).toBe(DEFAULT_SPREAD_THRESHOLD);
    expect(r.reviewThreshold).toBe(70);
    expect(r.matched).toBe(7);
    expect(r.compared).toBe(5);
    expect(r.uteEither).toBe(2);
    expect(r.medianDelta).toBe(4); // [0, 0, 4, 4, 15]
    expect(r.meanDelta).toBe(4.6); // 23 / 5
    expect(r.statusAgreement).toEqual({ agree: 4, of: 5, pct: 80 });
  });

  it('lists spread cases with whether a concept disagreement explains them', () => {
    expect(r.spreadCases).toEqual([{ id: 'C3', overallA: 86, overallB: 71, delta: 15, explained: true }]);
  });

  it('per-side overall avg, grade and pass rate', () => {
    // A: 93, 79, 86, 84, 57 = 399 → 79.8 (C); 4 Pass.  B: 93, 75, 71, 84, 61 = 384 → 76.8 (C); 5 Pass.
    expect(r.sideA).toEqual({ n: 5, avg: 79.8, grade: 'C', pass: 4, passPct: 80 });
    expect(r.sideB).toEqual({ n: 5, avg: 76.8, grade: 'C', pass: 5, passPct: 100 });
  });

  it('tier and category tables', () => {
    expect(r.tiers).toEqual([
      { key: 'Tier 1 (High)', n: 3, avgA: 86, avgB: 79.7, agree: 3, agreementPct: 100 }, // 258/3, 239/3
      { key: 'Tier 2 (Med)', n: 2, avgA: 70.5, avgB: 72.5, agree: 1, agreementPct: 50 },
    ]);
    expect(r.categories).toEqual([
      { key: 'Application and Use', n: 1, avgA: 86, avgB: 71, agree: 1, agreementPct: 100 },
      { key: 'Dilution', n: 2, avgA: 86, avgB: 84, agree: 2, agreementPct: 100 },
      { key: 'Product Recommendation', n: 2, avgA: 70.5, avgB: 72.5, agree: 1, agreementPct: 50 },
    ]);
  });

  it('review-queue overlap as a Jaccard index', () => {
    expect(r.reviewQueue).toEqual({ a: ['C5', 'C6'], b: ['C6'], overlap: ['C6'], union: 2, jaccard: 0.5 });
  });

  it('evaluates the proposed targets and marks each as proposed', () => {
    expect(r.targets.map((t) => t.met)).toEqual([true, false, true]);
    expect(r.targets.map((t) => t.actual)).toEqual(['4', '80% (4/5)', '1/1']);
    for (const t of r.targets) expect(t.note).toBe(PROPOSED_TARGET_NOTE);
  });
});

describe('options', () => {
  it('pass mark 70 turns the C6 flip into an agreement (57 Fail / 61 Fail)', () => {
    const strict = compareEvalRuns(bex, desktop, { passMark: 70 });
    const c6 = strict.cases.find((c) => c.id === 'C6');
    expect(c6?.a.status).toBe('Fail');
    expect(c6?.b.status).toBe('Fail');
    expect(c6?.statusAgree).toBe(true);
    expect(strict.rollup.statusAgreement).toEqual({ agree: 5, of: 5, pct: 100 });
    expect(strict.rollup.targets[1].met).toBe(true);
    expect(strict.rollup.sideB.pass).toBe(4); // C6 (61) now fails on B too
  });

  it('spread threshold 4 flags C2, C3 and C6 — only C3 is explained', () => {
    const wide = compareEvalRuns(bex, desktop, { spreadThreshold: 4 });
    expect(wide.rollup.spreadCases.map((s) => [s.id, s.explained])).toEqual([
      ['C2', false],
      ['C3', true],
      ['C6', false],
    ]);
    expect(wide.rollup.targets[2].actual).toBe('1/3');
    expect(wide.rollup.targets[2].met).toBe(false);
  });

  it('review threshold 60 empties the desktop queue', () => {
    const low = compareEvalRuns(bex, desktop, { reviewThreshold: 60 });
    expect(low.rollup.reviewQueue).toEqual({ a: ['C5'], b: [], overlap: [], union: 1, jaccard: 0 });
  });

  it('even-count median is the half-up one-decimal mean of the middle two', () => {
    const keep = new Set(['C1', 'C2', 'C3', 'C5']);
    const subset = (file: EvalFile): EvalFile => ({ ...file, cases: file.cases.filter((c) => keep.has(c.id)) });
    const four = compareEvalRuns(subset(bex), subset(desktop));
    expect(four.rollup.compared).toBe(4);
    expect(four.rollup.medianDelta).toBe(2); // [0, 0, 4, 15] → (0 + 4) / 2
    expect(four.rollup.meanDelta).toBe(4.8); // 19 / 4 = 4.75 → half-up
    // A queues C5, B queues nothing → union 1, overlap 0.
    expect(four.rollup.reviewQueue).toEqual({ a: ['C5'], b: [], overlap: [], union: 1, jaccard: 0 });
  });

  it('labels the two sides', () => {
    const labelled = compareEvalRuns(bex, desktop, { labelA: 'Bex (Opus 5, 3 passes)', labelB: 'Colleague' });
    expect(renderParityMarkdown(labelled)).toContain('# Grading parity — Bex (Opus 5, 3 passes) vs Colleague (B0-824)');
  });
});

describe('renderParityMarkdown', () => {
  const md = renderParityMarkdown(result);

  it('renders the rollups, the proposed targets and the per-case rows', () => {
    expect(md).toContain('# Grading parity — Bex vs Desktop (B0-824)');
    expect(md).toContain('| Only in Desktop | C8 |');
    expect(md).toContain('| Compared (both evaluable) | 5 |');
    expect(md).toContain('| Median Δ | 4 |');
    expect(md).toContain('| Pass/Fail agreement | 4/5 (80%) |');
    expect(md).toContain('| Review-queue overlap (Jaccard) | 1 of 2 (0.5) |');
    expect(md).toContain('| Overall avg | 79.8 | 76.8 |');
    expect(md).toContain(`## Targets (${PROPOSED_TARGET_NOTE})`);
    expect(md.split(PROPOSED_TARGET_NOTE).length - 1).toBe(4); // heading + one per target
    expect(md).toContain('| C3 | 86 | 71 | 15 | yes |');
    expect(md).toContain('| Tier 1 (High) | 3 | 86 | 79.7 | 3/3 (100%) |');
    expect(md).toContain('| Dilution | 2 | 86 | 84 | 2/2 (100%) |');
    expect(md).toContain(
      '| C3 | How is Fixture Finish C applied to a VCT floor? | 86 Pass | 71 Pass | 15 | yes | yes | no | yes | no | no | yes |',
    );
    expect(md).toContain('| C4 | Which neutral cleaner suits a school hallway? | 83 Pass | UTE | — | n/a | n/a | n/a | n/a | no | no | no |');
    expect(md).toContain('| C6 | Can Fixture Cleaner D go on a hardwood gym floor? | 57 Fail | 61 Pass | 4 | no | yes | yes | no | yes | yes | no |');
    expect(md).toContain('| C4 | Desktop | No actual response matched this golden question. |');
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
