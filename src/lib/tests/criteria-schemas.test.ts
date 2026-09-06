import { describe, expect, it } from 'vitest';

import { aggregateCriteriaVerdicts, type ExpectedCriterion } from './criteria-schemas';

describe('aggregateCriteriaVerdicts — B0-616 deterministic tier aggregation', () => {
  it('passes with no criteria (legacy behavior-only grading untouched)', () => {
    const outcome = aggregateCriteriaVerdicts([], []);
    expect(outcome).toEqual({ passed: true, score: null, verdicts: [], failureReason: null });
  });

  it('fails when any tier-1 criterion is not met, regardless of tier 2/3', () => {
    const criteria: ExpectedCriterion[] = [
      { concept: 'dilution 4 oz/gal', tier: 1, match: 'exact' },
      { concept: 'dwell time', tier: 2, match: 'semantic' },
    ];
    const outcome = aggregateCriteriaVerdicts(criteria, [
      { criterionIndex: 0, met: false, evidence: '' },
      { criterionIndex: 1, met: true, evidence: 'leave for 10 minutes' },
    ]);

    expect(outcome.passed).toBe(false);
    expect(outcome.failureReason).toContain('dilution 4 oz/gal');
  });

  it('passes when every tier-1 criterion is met, even if tier 2/3 are missed', () => {
    const criteria: ExpectedCriterion[] = [
      { concept: 'dilution 4 oz/gal', tier: 1, match: 'exact' },
      { concept: 'dwell time', tier: 2, match: 'semantic' },
      { concept: 'mentions PPE', tier: 3, match: 'semantic' },
    ];
    const outcome = aggregateCriteriaVerdicts(criteria, [
      { criterionIndex: 0, met: true, evidence: '4 oz/gal' },
      { criterionIndex: 1, met: false, evidence: '' },
      { criterionIndex: 2, met: false, evidence: '' },
    ]);

    expect(outcome.passed).toBe(true);
    expect(outcome.failureReason).toBeNull();
    // weighted: tier1=3 (met), tier2=2 (missed), tier3=1 (missed) → 3 / 6
    expect(outcome.score).toBeCloseTo(0.5);
  });

  it('scores full weighted coverage when every criterion is met', () => {
    const criteria: ExpectedCriterion[] = [
      { concept: 'a', tier: 1, match: 'semantic' },
      { concept: 'b', tier: 3, match: 'semantic' },
    ];
    const outcome = aggregateCriteriaVerdicts(criteria, [
      { criterionIndex: 0, met: true, evidence: 'a' },
      { criterionIndex: 1, met: true, evidence: 'b' },
    ]);

    expect(outcome.passed).toBe(true);
    expect(outcome.score).toBe(1);
  });

  it('treats a missing verdict for a criterion as not-met rather than throwing', () => {
    const criteria: ExpectedCriterion[] = [{ concept: 'a', tier: 1, match: 'semantic' }];
    const outcome = aggregateCriteriaVerdicts(criteria, []);

    expect(outcome.passed).toBe(false);
    expect(outcome.verdicts[0]).toMatchObject({ met: false, concept: 'a' });
  });

  /**
   * B0-832 — an exact-mode criterion's verdict must never be overwritten by another verdict
   * claiming the same `criterionIndex`, regardless of array order. This is the structural
   * guardrail underneath `gradeWithCriteria`'s upstream filtering (criteria-grader.ts): even if a
   * colliding semantic verdict somehow reached this function, the exact verdict must win.
   */
  it('never lets a second verdict at an exact criterion\'s index overwrite it, in either order', () => {
    const criteria: ExpectedCriterion[] = [
      { concept: '4 oz/gal', tier: 1, match: 'exact' },
      { concept: 'dwell time', tier: 2, match: 'semantic' },
    ];

    const exactVerdict = { criterionIndex: 0, met: false, evidence: '', source: 'exact' as const };
    const collidingSemanticVerdict = {
      criterionIndex: 0,
      met: true,
      evidence: 'fabricated',
      source: 'semantic' as const,
    };

    // exact first, colliding semantic second (the real call order in gradeWithCriteria)
    const outcomeA = aggregateCriteriaVerdicts(criteria, [exactVerdict, collidingSemanticVerdict]);
    expect(outcomeA.verdicts[0]).toMatchObject({ met: false, match: 'exact' });
    expect(outcomeA.passed).toBe(false);

    // colliding semantic first, exact second — still must not flip the outcome
    const outcomeB = aggregateCriteriaVerdicts(criteria, [collidingSemanticVerdict, exactVerdict]);
    expect(outcomeB.verdicts[0]).toMatchObject({ met: false, match: 'exact' });
    expect(outcomeB.passed).toBe(false);
  });
});
