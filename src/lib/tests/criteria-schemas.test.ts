import { describe, expect, it } from 'vitest';

import {
  aggregateCriteriaVerdicts,
  buildExpectedCriteria,
  conceptIdentityKey,
  parseConceptPhrase,
  type ExpectedCriterion,
} from './criteria-schemas';

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

/**
 * B0-932 — the three `text[]` concept columns are the only source of criteria now, and
 * `minimum_concepts` is what makes an item pass or fail. These pin the tiering, the de-dupe that
 * stops a phrase in two columns from double-counting, and the `exact:` regulated-value opt-in.
 */
describe('buildExpectedCriteria (B0-932)', () => {
  it('tiers minimum_concepts as 1 and the other two columns as 2', () => {
    const criteria = buildExpectedCriteria({
      minimumConcepts: ['must state the labeled dilution'],
      expectedConcepts: ['mentions pre-cleaning heavy soil'],
      expectedCriteria: ['names the source document'],
    });

    expect(criteria).toEqual([
      { concept: 'must state the labeled dilution', tier: 1, match: 'semantic' },
      { concept: 'mentions pre-cleaning heavy soil', tier: 2, match: 'semantic' },
      { concept: 'names the source document', tier: 2, match: 'semantic' },
    ]);
  });

  it('keeps ONE tier-1 criterion for a phrase that appears in both mandatory and expected', () => {
    // The mandatory set is usually a literal subset of the expected set; without the de-dupe the
    // phrase would be judged twice and double-count in the weighted score.
    const criteria = buildExpectedCriteria({
      minimumConcepts: ['no pricing information'],
      expectedConcepts: ['no pricing information', 'distributor can quote it'],
    });

    expect(criteria).toEqual([
      { concept: 'no pricing information', tier: 1, match: 'semantic' },
      { concept: 'distributor can quote it', tier: 2, match: 'semantic' },
    ]);
  });

  it('de-dupes on the normalised identity key, not on exact text', () => {
    const criteria = buildExpectedCriteria({
      minimumConcepts: ['No Pricing Information'],
      expectedConcepts: ['no pricing information.'],
    });

    // The surviving copy is the mandatory one, spelled exactly as the mandatory column wrote it.
    expect(criteria).toEqual([
      { concept: 'No Pricing Information', tier: 1, match: 'semantic' },
    ]);
  });

  it('drops blank entries rather than emitting a criterion that matches everything', () => {
    expect(
      buildExpectedCriteria({ minimumConcepts: ['', '   ', 'real phrase'] }),
    ).toEqual([{ concept: 'real phrase', tier: 1, match: 'semantic' }]);
  });

  it('returns an empty list for empty / absent columns', () => {
    expect(buildExpectedCriteria({})).toEqual([]);
    expect(
      buildExpectedCriteria({ minimumConcepts: [], expectedConcepts: null }),
    ).toEqual([]);
  });

  describe('the `exact:` regulated-value opt-in', () => {
    it('pins the entry to the deterministic literal check and strips the prefix', () => {
      expect(
        buildExpectedCriteria({ minimumConcepts: ['exact: EPA Reg. No. 12345-67'] }),
      ).toEqual([{ concept: 'EPA Reg. No. 12345-67', tier: 1, match: 'exact' }]);
    });

    it('accepts the marker in any case and preserves the phrase verbatim after it', () => {
      expect(parseConceptPhrase('EXACT:  4 oz/gal')).toEqual({
        concept: '4 oz/gal',
        match: 'exact',
      });
    });

    it('defaults everything else to semantic, including a phrase that merely contains "exact"', () => {
      expect(parseConceptPhrase('states the exact contact time')).toEqual({
        concept: 'states the exact contact time',
        match: 'semantic',
      });
    });

    it('drops an entry that is nothing but the marker', () => {
      expect(parseConceptPhrase('exact:')).toBeNull();
      expect(buildExpectedCriteria({ minimumConcepts: ['exact:  '] })).toEqual([]);
    });

    it('de-dupes an exact entry against the same phrase written plainly, exact winning by position', () => {
      expect(
        buildExpectedCriteria({
          minimumConcepts: ['exact: 4 oz/gal'],
          expectedConcepts: ['4 oz/gal'],
        }),
      ).toEqual([{ concept: '4 oz/gal', tier: 1, match: 'exact' }]);
    });
  });

  it('produces criteria whose tier-1 misses fail the item in aggregateCriteriaVerdicts', () => {
    const criteria = buildExpectedCriteria({
      minimumConcepts: ['mandatory phrase'],
      expectedConcepts: ['nice to have'],
    });

    const missed = aggregateCriteriaVerdicts(criteria, [
      { criterionIndex: 0, met: false, evidence: '' },
      { criterionIndex: 1, met: true, evidence: 'yes' },
    ]);
    expect(missed.passed).toBe(false);
    expect(missed.failureReason).toContain('mandatory phrase');

    const covered = aggregateCriteriaVerdicts(criteria, [
      { criterionIndex: 0, met: true, evidence: 'yes' },
      { criterionIndex: 1, met: false, evidence: '' },
    ]);
    expect(covered.passed).toBe(true);
  });
});

describe('conceptIdentityKey (B0-932)', () => {
  it('matches the report grader\'s normConcept behaviour it was ported from', () => {
    expect(conceptIdentityKey('  Dilute at 2 oz/gal!  ')).toBe('dilute at 2 oz gal');
    expect(conceptIdentityKey('Café')).toBe('cafe');
    expect(conceptIdentityKey(null)).toBe('');
  });
});
