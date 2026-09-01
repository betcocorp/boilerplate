import { describe, expect, it } from 'vitest';

import { resolveKnowledgeCategoryExclusions } from '~/lib/tools/product-tools';

describe('resolveKnowledgeCategoryExclusions (B0-780)', () => {
  it('excludes both floor-care categories for the bathroom specialist regardless of wording', () => {
    expect(resolveKnowledgeCategoryExclusions('bathroom', 'what are common restroom mistakes')).toEqual(
      ['vct', 'sportszone'],
    );
    expect(resolveKnowledgeCategoryExclusions('bathroom', 'VCT wood gym floor')).toEqual([
      'vct',
      'sportszone',
    ]);
  });

  it('excludes vct for a wood/sport-floor query under the floor specialist', () => {
    expect(
      resolveKnowledgeCategoryExclusions('floor', 'humidity levels for a wood gym floor'),
    ).toEqual(['vct']);
    expect(resolveKnowledgeCategoryExclusions('floor', 'hardwood athletic floor finish')).toEqual([
      'vct',
    ]);
  });

  it('excludes sportszone for a VCT query under the floor specialist', () => {
    expect(
      resolveKnowledgeCategoryExclusions('floor', 'why did the VCT floor not fully strip'),
    ).toEqual(['sportszone']);
    expect(
      resolveKnowledgeCategoryExclusions('floor', 'vinyl composition tile finish selection'),
    ).toEqual(['sportszone']);
  });

  it('excludes nothing for an ambiguous or substrate-agnostic floor query', () => {
    expect(resolveKnowledgeCategoryExclusions('floor', 'how do I select the right floor finish')).toEqual(
      [],
    );
    // Both domains named — an actually ambiguous case, not one this ticket resolves.
    expect(resolveKnowledgeCategoryExclusions('floor', 'wood vs VCT floor finish')).toEqual([]);
  });

  it('excludes nothing for other specialists (product/dilution/recommendations/cross_reference)', () => {
    expect(resolveKnowledgeCategoryExclusions('product', 'wood gym floor question')).toEqual([]);
    expect(resolveKnowledgeCategoryExclusions('dilution', 'VCT dilution ratio')).toEqual([]);
    expect(resolveKnowledgeCategoryExclusions(null, 'wood gym floor question')).toEqual([]);
    expect(resolveKnowledgeCategoryExclusions(undefined, 'VCT floor')).toEqual([]);
  });
});
