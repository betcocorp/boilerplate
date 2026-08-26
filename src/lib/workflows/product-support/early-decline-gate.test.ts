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

describe('classifyEarlyDecline — B0-559 gym/sports floor is not ambiguous surface context', () => {
  it('does not decline a gym floor finish request for missing surface context', () => {
    expect(
      classifyEarlyDecline(
        'I need a durable gym floor finish but the gym is back in use tomorrow, what do you recommend?',
      ),
    ).toBeNull();
  });

  it('still declines a genuinely broad recommendation request with no floor/surface mention', () => {
    expect(classifyEarlyDecline('What do you recommend for daily cleaning?')).toEqual(
      expect.objectContaining({ reason: 'broad_recommendation_without_context' }),
    );
  });
});

describe('classifyEarlyDecline — B0-660 don\'t ask for a surface the user already named', () => {
  it('does not decline "what\'s the best product for a concrete floor"', () => {
    expect(classifyEarlyDecline("What's the best product for a concrete floor?")).toBeNull();
  });

  it('does not decline a VCT surface question', () => {
    expect(
      classifyEarlyDecline('What do you recommend for cleaning a VCT floor?'),
    ).toBeNull();
  });

  it('does not decline a terrazzo surface question', () => {
    expect(
      classifyEarlyDecline("What's the best product for terrazzo?"),
    ).toBeNull();
  });

  it('does not decline a grout surface question', () => {
    expect(classifyEarlyDecline('What do you recommend for grout?')).toBeNull();
  });

  it('does not decline a carpet surface question', () => {
    expect(
      classifyEarlyDecline("What's the best product for carpet in a lobby?"),
    ).toBeNull();
  });

  it('does not decline a stainless steel surface question', () => {
    expect(
      classifyEarlyDecline('What do you recommend for cleaning stainless steel prep tables?'),
    ).toBeNull();
  });

  it('still declines a genuinely context-free ask with no surface named', () => {
    expect(classifyEarlyDecline('What do you recommend for daily cleaning?')).toEqual(
      expect.objectContaining({ reason: 'broad_recommendation_without_context' }),
    );
  });
});
