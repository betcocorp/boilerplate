import { describe, expect, it } from 'vitest';

import { classifyRetrievalIntent } from '~/lib/tools/product-tools';

/**
 * B0-759 — the procedural/enumeration branch. Three of the four F-graded cases on the
 * golden-set run bb07d5e5 answered from a single 3-document, 1-chunk-per-document search against
 * expectations that wanted a fifteen-item maintenance schedule or a full list of failure causes.
 *
 * These tests exist for the OVER-firing risk, not the under-firing one: 34 of that run's 38 items
 * were already passing, and widening retrieval for them could move scores in either direction
 * inside a +/-2 noise band where the change would be indistinguishable from chance. The "leaves
 * alone" block is therefore the load-bearing half — it is drawn from real prompts in that set.
 */
describe('classifyRetrievalIntent procedural depth branch', () => {
  // Width only — see the B0-759 note in classifyRetrievalIntent for why depth was measured and dropped.
  const DEPTH = { limit: 6 };

  describe('widens for the shapes that graded F', () => {
    const widened = [
      'What factors can throw off the dilution accuracy in these systems?',
      'What kind of maintenance does a dilution control system need?',
      'How soon can I put a second coat of finish on?',
      'How long before I can put a second coat of finish on?',
      'How long does it take to get a wall-mounted dispenser like FastDraw Pro installed?',
      'What are the steps to strip and recoat?',
      'How often should we verify dilution accuracy?',
      'Give me a step-by-step for the startup check',
      // B0-759 follow-up — D-band enumeration asks from the same golden set.
      'Which high-touch points get missed most often when cleaning restrooms?',
      'What is the strongest floor stripper you have?',
    ];

    for (const query of widened) {
      it(`widens: ${query}`, () => {
        expect(classifyRetrievalIntent(query)).toEqual(DEPTH);
      });
    }
  });

  describe('leaves single-value and single-product lookups alone', () => {
    const untouched = [
      // Real prompts from the same golden set that were NOT failing on evidence volume.
      'What product should I use on VCT floors?',
      'Can I use pH7Q on stainless steel?',
      'What disinfectant works best against norovirus?',
      'How do I get shoe scuffs and ball marks off the floor?',
      // "best" is deliberately NOT a depth trigger: this one already scores in the high 80s as a
      // single-product answer, and widening it would be churn on a case that works.
      'What is the best glass cleaner?',
      // The noun alone must not fire — this is a single-value lookup, not a schedule.
      'what dilution does the maintenance cleaner use',
    ];

    for (const query of untouched) {
      it(`leaves alone: ${query}`, () => {
        expect(classifyRetrievalIntent(query)).toEqual({});
      });
    }
  });

  it('keeps comparison precedence — "difference between" wins over the depth branch', () => {
    // "What's the difference between a finish and a sealer?" contains no depth trigger, but the
    // ordering matters for a query that carries both; comparisons stay on product_line_profile.
    expect(classifyRetrievalIntent('what factors differ, compare A and B')).toEqual({
      limit: 5,
      maxPerDocument: 1,
      requiredDocumentKinds: ['product_line_profile'],
    });
  });

  it('keeps product-name precedence, so a named product retains its existing tuning', () => {
    expect(classifyRetrievalIntent('how often should I recoat?', 'StreetShoe')).toEqual({
      limit: 4,
      maxPerDocument: 2,
    });
  });
});
