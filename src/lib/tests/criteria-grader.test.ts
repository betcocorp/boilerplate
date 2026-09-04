import { describe, expect, it } from 'vitest';

import { gradeExactCriterion } from './criteria-grader';

/**
 * B0-803 — `gradeExactCriterion` is the deterministic guardrail for `match: 'exact'` criteria and,
 * via B0-538's `matchTerm`, for every regulated-looking multi-turn expectation term. The rule it
 * implements is pinned here: lower-case + collapse whitespace runs + trim on BOTH sides, and
 * nothing else. The positive cases prove capitalisation and line-wrapping no longer fail a correct
 * answer; the negative cases prove digits, units and punctuation are still matched exactly as
 * printed, so the fix cannot be over-loosened without a test going red.
 *
 * Figures below are matcher fixtures only — never an authored expectation about a real product.
 */

const ANSWER = 'Keep the surface wet for 2 minutes.';

describe('gradeExactCriterion — B0-803 case/whitespace normalisation', () => {
  it('matches an identical phrase and reports the original concept as evidence', () => {
    expect(gradeExactCriterion('2 minutes', ANSWER)).toEqual({
      criterionIndex: -1,
      met: true,
      evidence: '2 minutes',
    });
  });

  it('ignores capitalisation differences (the B0-236 failure mode)', () => {
    expect(gradeExactCriterion('2 Minutes', ANSWER)).toEqual({
      criterionIndex: -1,
      met: true,
      evidence: '2 Minutes',
    });
    expect(gradeExactCriterion('KEEP THE SURFACE WET', ANSWER).met).toBe(true);
    expect(gradeExactCriterion('epa reg. no. 1839-83', 'EPA Reg. No. 1839-83').met).toBe(true);
  });

  describe('whitespace runs collapse to a single space on both sides', () => {
    it.each([
      ['double space in the concept', '2  minutes', ANSWER],
      ['tab in the concept', '2\tminutes', ANSWER],
      ['newline in the concept', '2\nminutes', ANSWER],
      ['leading/trailing space in the concept', '  2 minutes  ', ANSWER],
      ['newline inside the phrase in the response', '2 minutes', 'Keep the surface wet for 2\nminutes.'],
      ['CRLF inside the phrase in the response', '10 minutes', 'contact time of 10\r\nminutes'],
      ['line-wrapped, indented response', '4 oz/gal', 'Dilute at 4\n   oz/gal for general cleaning.'],
    ])('%s', (_label, concept, response) => {
      expect(gradeExactCriterion(concept, response)).toEqual({
        criterionIndex: -1,
        met: true,
        evidence: concept,
      });
    });
  });

  describe('digits, units and punctuation stay literal', () => {
    it.each([
      ['4.0 is not 4', '4 oz/gal', 'Use 4.0 oz/gal.'],
      ['40 is not 4', '4 oz/gal', 'Use 40 oz/gal.'],
      ['20 minutes is not 2 minutes', '2 minutes', 'Keep the surface wet for 20 minutes.'],
      ['unit mismatch', '4 oz/gal', 'Use 4 oz/L.'],
      ['punctuation difference in a registration number', 'EPA Reg. No. 1839-83', 'EPA Reg No 1839-83'],
      ['ratio separator', '1:64', 'dilute 1-64'],
      ['decimal dropped', '0.5%', 'apply at 5%'],
    ])('%s: "%s" does not match "%s"', (_label, concept, response) => {
      expect(gradeExactCriterion(concept, response)).toEqual({
        criterionIndex: -1,
        met: false,
        evidence: '',
      });
    });
  });

  it('never matches an empty or whitespace-only concept', () => {
    for (const concept of ['', ' ', '   ', '\n', '\t\n ']) {
      expect(gradeExactCriterion(concept, ANSWER)).toEqual({
        criterionIndex: -1,
        met: false,
        evidence: '',
      });
    }
  });

  it('returns met:false with empty evidence when the concept is absent', () => {
    expect(gradeExactCriterion('30 seconds', ANSWER)).toEqual({
      criterionIndex: -1,
      met: false,
      evidence: '',
    });
  });

  it('never matches anything against an empty response', () => {
    expect(gradeExactCriterion('2 minutes', '').met).toBe(false);
  });
});
