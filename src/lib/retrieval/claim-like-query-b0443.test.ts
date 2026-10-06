import { describe, expect, it } from 'vitest';

import { isClaimLikeQuery } from '~/lib/retrieval/product-knowledge';

/**
 * B0-443: `CLAIM_LIKE_QUERY_PATTERN` placed its closing `\b` outside the alternation group, so
 * stem-style alternatives (e.g. `dilut`) only matched when the very next character was a
 * non-word character. "dilution" never matched: the group matched "dilut", then `\b` failed
 * between "t" and "i". This table-driven matrix pins the full phrasing set from the ticket so a
 * future edit to `CLAIM_LIKE_QUERY_PATTERN` can't silently re-break a phrasing without a test
 * failing here.
 */
describe('isClaimLikeQuery — B0-443 phrasing matrix', () => {
  // Previously false (the bug). Must now return true.
  const previouslyFalseNowTrue = [
    'what dilution do I use for Triforce?',
    'dilution ratio',
    'dilute 1:64',
    'what is the dilution',
    'diluted',
    'hazards',
    'hazardous',
    'epa registered',
    '2 oz per gallon',
  ];

  // Previously true. Must remain true (no regressions).
  const previouslyTrueStillTrue = [
    'hazard',
    'epa reg',
    'epa reg no',
    '4 oz/gal',
    'contact time',
    'first aid',
    'kill claim',
    'efficacy',
    'ppe',
    'flammable',
    'corrosive',
    'directions for use',
    'sanitize a soft surface',
    'disinfect upholstered furniture',
  ];

  // Not claim-like phrasing at all -- guards against the fix over-matching.
  const shouldStayFalse = [
    'tell me about this product family',
    'how do I use this on vinyl',
    'general floor care advice',
    'what colors does this come in',
    'is this available in a gallon size',
    'what is the shelf life',
  ];

  it.each(previouslyFalseNowTrue)('now returns true for %s', (query) => {
    expect(isClaimLikeQuery(query)).toBe(true);
  });

  it.each(previouslyTrueStillTrue)('still returns true for %s', (query) => {
    expect(isClaimLikeQuery(query)).toBe(true);
  });

  it.each(shouldStayFalse)('returns false for non-claim query %s', (query) => {
    expect(isClaimLikeQuery(query)).toBe(false);
  });
});
