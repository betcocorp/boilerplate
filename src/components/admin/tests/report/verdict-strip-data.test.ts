import { describe, expect, it } from 'vitest';

import type { ReportCase, ReportEvaluatedCase } from '~/lib/tests/report/data-schemas';
import { caseAnchorId } from '~/lib/tests/report/render';

import { buildExceptionRows, exceptionReason } from './verdict-strip-data';

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
    mandatoryMissing: false,
    materialIssue: false,
    passesOnlyUnderCurrentMark: false,
    concepts: CONCEPTS,
    ...overrides,
  };
}

function detail(overrides: Partial<ReportCase>): ReportCase {
  const id = overrides.id ?? 'id';
  return {
    id,
    anchorId: caseAnchorId(id),
    question: 'q',
    tier: 'Tier 1',
    priorityRaw: 1,
    category: 'Dilution',
    idealResponse: null,
    expectedConcepts: null,
    minimumConcepts: null,
    expectedSources: null,
    expectedShouldAnswer: null,
    concepts: CONCEPTS,
    actual: '(no response recorded)',
    responseRecorded: false,
    score: {
      unableToEvaluate: false,
      uteReason: null,
      accuracy: 0,
      completeness: null,
      relevance: 0,
      clarity: 0,
      explanation: '',
      missed: '',
      incorrect: '',
      improvement: '',
    },
    unableToEvaluate: false,
    evaluated: null,
    latencySeconds: null,
    latencyMs: null,
    ttftSeconds: null,
    ttftMs: null,
    speed: null,
    variance: null,
    harness: null,
    retrievedDocumentIds: [],
    workflowRunId: null,
    ...overrides,
  };
}

describe('exceptionReason', () => {
  it('prefers incorrect, then missed, then explanation', () => {
    const base = detail({}).score;
    expect(
      exceptionReason({ ...base, incorrect: 'wrong ratio', missed: 'm', explanation: 'e' }),
    ).toBe('wrong ratio');
    expect(exceptionReason({ ...base, missed: 'm', explanation: 'e' })).toBe('m');
    expect(exceptionReason({ ...base, explanation: 'e' })).toBe('e');
  });

  it('returns null rather than inventing a reason', () => {
    expect(exceptionReason(undefined)).toBeNull();
    expect(exceptionReason({ ...detail({}).score, explanation: '   ' })).toBeNull();
  });

  it('passes regulated values through verbatim', () => {
    const reason = 'Answered 2 oz/gal (1:64); the label states 4 oz/gal (1:32) at 10 minutes.';
    expect(exceptionReason({ ...detail({}).score, incorrect: reason })).toBe(reason);
  });
});

describe('buildExceptionRows', () => {
  const perCase = [
    evaluated({ id: 'p1', overall: 91, grade: 'A', status: 'Pass' }),
    evaluated({ id: 'p2', overall: 65, grade: 'D', status: 'Pass', passesOnlyUnderCurrentMark: true }),
    evaluated({ id: 'f1', overall: 41, grade: 'F', status: 'Fail' }),
    evaluated({ id: 'f2', overall: 12, grade: 'F', status: 'Fail' }),
    evaluated({ id: 'f3', overall: 12, grade: 'F', status: 'Fail' }),
  ];

  it('keeps exactly the fails, worst first — a D that passes is not an exception', () => {
    const rows = buildExceptionRows(perCase, []);
    // Fails ascending, ties in dataset order.
    expect(rows.map((row) => row.id)).toEqual(['f2', 'f3', 'f1']);
    expect(rows.every((row) => row.status === 'Fail')).toBe(true);
  });

  it('is empty when every case passed', () => {
    expect(buildExceptionRows([perCase[0]!, perCase[1]!], [])).toEqual([]);
  });

  it('joins the ledger case on id for the anchor and the reason', () => {
    const rows = buildExceptionRows(
      [evaluated({ id: 'f1', overall: 41 })],
      [
        detail({
          id: 'f1',
          anchorId: 'case-f1',
          score: { ...detail({}).score, incorrect: 'Cited 1:128 instead of 1:64.' },
        }),
      ],
    );
    expect(rows[0]!.anchorId).toBe('case-f1');
    expect(rows[0]!.reason).toBe('Cited 1:128 instead of 1:64.');
  });

  it('falls back to caseAnchorId and omits the reason when no ledger case matches', () => {
    const rows = buildExceptionRows([evaluated({ id: 'ABC-1' })], []);
    expect(rows[0]!.anchorId).toBe(caseAnchorId('ABC-1'));
    expect(rows[0]!.reason).toBeNull();
  });

  it('reads scores off the payload without recomputing them', () => {
    const rows = buildExceptionRows([evaluated({ id: 'f1', overall: 41.5 })], []);
    expect(rows[0]!.overall).toBe(41.5);
  });
});
