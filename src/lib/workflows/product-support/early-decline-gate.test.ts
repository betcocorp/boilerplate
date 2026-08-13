import { describe, expect, it } from 'vitest';

import { classifyEarlyDecline } from '~/lib/workflows/product-support/run-product-support-workflow';

describe('classifyEarlyDecline — B0-300 cross-reference false positive', () => {
  it('does not hijack a competitor cross-reference query that happens to say "what do you recommend"', () => {
    // The exact B0-97 "Recommendations — No-Equivalent Probes" prompt that failed:
    // routed to the generic broad-recommendation decline instead of the
    // cross-reference/recommendations flow.
    expect(
      classifyEarlyDecline(
        'Looking for a Betco alternative to Madeupco HyperFresh Foam. What do you recommend?',
      ),
    ).toBeNull();
  });

  it('still declines a genuinely broad, context-free recommendation request', () => {
    expect(classifyEarlyDecline('What do you recommend for daily cleaning?')).toEqual(
      expect.objectContaining({ reason: 'broad_recommendation_without_context' }),
    );
  });

  it('still declines chemical mixing / safety questions regardless of cross-reference wording', () => {
    expect(
      classifyEarlyDecline(
        'Is it safe to mix bleach with our Betco equivalent alternative cleaner?',
      ),
    ).toEqual(expect.objectContaining({ reason: 'chemical_mixing_or_safety' }));
  });

  it('still declines legal/compliance questions', () => {
    expect(
      classifyEarlyDecline('Is this Betco product OSHA compliant?'),
    ).toEqual(expect.objectContaining({ reason: 'legal_or_compliance' }));
  });

  it('still declines expired-product questions', () => {
    expect(
      classifyEarlyDecline('Is this Betco product still good after expiration?'),
    ).toEqual(expect.objectContaining({ reason: 'storage_or_expiration' }));
  });
});
