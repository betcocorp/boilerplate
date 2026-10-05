import { describe, expect, it } from 'vitest';

import {
  buildEvalRunCase,
  buildEvalRunDocument,
  EXPORT_EVAL_JSON_COMMENT,
  toSkillScoringConfig,
  type EvalRunCaseSource,
  type EvalRunDocumentInput,
} from './eval-json-export';
import { NO_EXPECTED_CONCEPTS_UTE_REASON } from './metrics';
import { parseEvalFile } from './parity-compare';
import type { CaseScore } from './schemas';
import { DEFAULT_SCORING_RULES } from './scoring-config';

function gradedScore(overrides: Partial<CaseScore> = {}): CaseScore {
  return {
    unableToEvaluate: false,
    uteReason: null,
    accuracy: 20,
    completeness: 3,
    relevance: 20,
    clarity: 65,
    explanation: 'why',
    missed: 'the substance',
    incorrect: '',
    improvement: 'answer the question',
    concepts: {
      mandatory: { required: ['list products'], satisfied: [], missing: ['list products'] },
      expected: {
        required: ['list products', 'cite the label'],
        satisfied: ['cite the label'],
        missing: ['list products'],
      },
      materialIssue: false,
      materialIssueNote: null,
    },
    similarity: 0.03,
    similarityNote: 'nothing shared',
    evalConfidence: 88,
    confidenceNote: 'clear refusal',
    ...overrides,
  };
}

const caseA: EvalRunCaseSource = {
  id: 'item-a',
  question: 'Which of your disinfectants kill HIV-1?',
  priorityRaw: 1,
  tier: 'Tier 1',
  category: 'pathogen-specific',
  idealResponse: 'List the products…',
  actual: "I can't verify the efficacy claim…",
  ttftSeconds: 6.187,
  latencySeconds: 10.531,
};

const caseB: EvalRunCaseSource = {
  id: 'item-b',
  question: 'Do you have a product called Hard as Nailz?',
  priorityRaw: 2,
  tier: 'Tier 2',
  category: 'recommendation',
  idealResponse: 'No…',
  actual: 'No response',
  ttftSeconds: null,
  latencySeconds: null,
};

function documentInput(overrides: Partial<EvalRunDocumentInput> = {}): EvalRunDocumentInput {
  return {
    test: { id: 'test-1', name: 'Product Specialist Top 20', intended_agent: 'product' },
    run: { id: 'run-1', app_version: '3.1.0' },
    items: [
      { id: 'item-a', priority: 1 },
      { id: 'item-b', priority: 2 },
    ],
    state: {
      passes: 2,
      passMark: 60,
      spreadThreshold: 10,
      gradingPromptHash: 'abc',
      judgedThresholds: null,
      scoringRules: DEFAULT_SCORING_RULES,
      model: 'claude-opus-5',
      gradingEffort: 'high',
      synthesis: null,
    } as EvalRunDocumentInput['state'],
    cases: [caseA, caseB],
    passScores: {
      'item-a': [gradedScore(), gradedScore({ accuracy: 25 })],
      'item-b': [
        { ...gradedScore(), unableToEvaluate: true, uteReason: 'No response text recorded for this item in this run.' },
        gradedScore(),
      ],
    },
    passIndex: 0,
    exportedAt: '2026-10-05T12:00:00.000Z',
    ...overrides,
  };
}

describe('buildEvalRunCase', () => {
  it('emits the skill case shape in the exporter’s key order, with judged Completeness uncapped', () => {
    const c = buildEvalRunCase(caseA, gradedScore());
    expect(Object.keys(c)).toEqual([
      'id', 'question', 'priority_raw', 'tier', 'category', 'expected', 'actual',
      'accuracy', 'completeness', 'relevance', 'clarity', 'explanation', 'missed', 'incorrect', 'improvement',
      'ttft_seconds', 'latency_seconds', 'concepts', 'unable_to_evaluate', 'ute_reason',
      'similarity', 'similarity_note', 'eval_confidence', 'confidence_note',
    ]);
    expect(c.completeness).toBe(3); // judged, not the 50% coverage share
    expect(c.concepts).toEqual({
      minimal_required: ['list products'],
      minimal_satisfied: [],
      minimal_missing: ['list products'],
      expected_required: ['list products', 'cite the label'],
      expected_satisfied: ['cite the label'],
      expected_missing: ['list products'],
      material_issue: false,
      material_issue_note: null,
    });
    expect(c.unable_to_evaluate).toBe(false);
    expect(c.ute_reason).toBeNull();
  });

  it('falls back to the coverage share when a pass carries no judged Completeness (B0-813 window)', () => {
    const c = buildEvalRunCase(caseA, gradedScore({ completeness: null }));
    expect(c.completeness).toBe(50);
  });

  it('writes a grader UTE with its reason and no sub-scores, and omits absent timings and judged metrics', () => {
    const c = buildEvalRunCase(caseB, {
      ...gradedScore({ similarity: null, similarityNote: null, evalConfidence: null, confidenceNote: null }),
      unableToEvaluate: true,
      uteReason: 'empty response',
    });
    expect(c.unable_to_evaluate).toBe(true);
    expect(c.ute_reason).toBe('empty response');
    expect(c).not.toHaveProperty('accuracy');
    expect(c).not.toHaveProperty('ttft_seconds');
    expect(c).not.toHaveProperty('similarity');
  });

  it('treats a pass with no expected concepts as unable to evaluate under Bex’s rule', () => {
    const c = buildEvalRunCase(caseA, gradedScore({ concepts: null }));
    expect(c.unable_to_evaluate).toBe(true);
    expect(c.ute_reason).toBe(NO_EXPECTED_CONCEPTS_UTE_REASON);
    expect(c).not.toHaveProperty('completeness');
  });
});

describe('buildEvalRunDocument', () => {
  it('builds a per-pass document the parity comparator accepts, with the exporter’s meta by default', () => {
    const doc = buildEvalRunDocument(documentInput());
    expect(Object.keys(doc)).toEqual(['meta', 'tier_labels', 'scoring_config', 'cases']);
    expect(Object.keys(doc.meta)).toEqual(['workbook', 'workflow', 'prepared_for', 'run_url', '$comment', 'bex']);
    expect(doc.meta.$comment).toBe(EXPORT_EVAL_JSON_COMMENT);
    expect(doc.meta.bex).toMatchObject({ run_id: 'run-1', pass: 1, passes: 2, grading: { model: 'claude-opus-5', effort: 'high', pass_mark: 60, grading_prompt_hash: 'abc' } });
    expect(doc.tier_labels).toEqual({ 'Tier 1': '1', 'Tier 2': '2' });
    expect(doc.scoring_config).toEqual(toSkillScoringConfig(DEFAULT_SCORING_RULES, 60));
    expect(doc.cases.map((c) => c.id)).toEqual(['item-a', 'item-b']);
    expect(doc.cases[1]?.unable_to_evaluate).toBe(true);

    const parsed = parseEvalFile(JSON.parse(JSON.stringify(doc)));
    expect(parsed.ok).toBe(true);
  });

  it('selects the requested pass and omits cases that have no score on it', () => {
    const doc = buildEvalRunDocument(
      documentInput({ passIndex: 1, passScores: { 'item-a': [gradedScore(), gradedScore({ accuracy: 25 })], 'item-b': [gradedScore()] } }),
    );
    expect(doc.meta.bex.pass).toBe(2);
    expect(doc.cases.map((c) => c.id)).toEqual(['item-a']);
    expect(doc.cases[0]?.accuracy).toBe(25);
  });

  it('lets another producer replace the comment and append meta, without touching the rest', () => {
    const doc = buildEvalRunDocument(
      documentInput({ meta: { comment: 'Re-graded (B0-854)', extra: { regrade: { ticket: 'B0-854' } } } }),
    );
    expect(doc.meta.$comment).toBe('Re-graded (B0-854)');
    expect(Object.keys(doc.meta)).toEqual(['workbook', 'workflow', 'prepared_for', 'run_url', '$comment', 'bex', 'regrade']);
    expect(doc.meta).toMatchObject({ regrade: { ticket: 'B0-854' } });
  });

  it('throws when an item has a score but the assembly produced no case for it', () => {
    expect(() => buildEvalRunDocument(documentInput({ cases: [caseA] }))).toThrow(/no case for item item-b/);
  });
});
