import { describe, expect, it } from 'vitest';

import { resolveKnowledgeCategoryExclusions } from '~/lib/tools/product-tools';

describe('resolveKnowledgeCategoryExclusions (B0-780, split B0-746)', () => {
  it('excludes both floor-care categories for the bathroom specialist regardless of wording', () => {
    expect(resolveKnowledgeCategoryExclusions('bathroom', 'what are common restroom mistakes')).toEqual(
      ['vct', 'sportszone'],
    );
    expect(resolveKnowledgeCategoryExclusions('bathroom', 'VCT wood gym floor')).toEqual([
      'vct',
      'sportszone',
    ]);
  });

  it('excludes vct unconditionally for the wood/sport floor specialist', () => {
    expect(
      resolveKnowledgeCategoryExclusions('floor_wood_sport', 'humidity levels for a wood gym floor'),
    ).toEqual(['vct']);
    // The specialist id itself resolves the domain post-B0-746 — query wording no longer matters.
    expect(resolveKnowledgeCategoryExclusions('floor_wood_sport', 'vinyl composition tile finish')).toEqual([
      'vct',
    ]);
  });

  it('excludes sportszone unconditionally for the VCT specialist', () => {
    expect(
      resolveKnowledgeCategoryExclusions('floor_vct', 'why did the VCT floor not fully strip'),
    ).toEqual(['sportszone']);
    expect(resolveKnowledgeCategoryExclusions('floor_vct', 'hardwood gym floor finish')).toEqual([
      'sportszone',
    ]);
  });

  it('excludes both floor-care categories for concrete and STG (no dedicated ingest folder)', () => {
    expect(resolveKnowledgeCategoryExclusions('floor_concrete', 'concrete sealer coverage')).toEqual([
      'vct',
      'sportszone',
    ]);
    expect(resolveKnowledgeCategoryExclusions('floor_stg', 'stone tile and grout cleaner dilution')).toEqual([
      'vct',
      'sportszone',
    ]);
  });

  it('excludes nothing for other specialists (product/dilution/recommendations/cross_reference)', () => {
    expect(resolveKnowledgeCategoryExclusions('product', 'wood gym floor question')).toEqual([]);
    expect(resolveKnowledgeCategoryExclusions('dilution', 'VCT dilution ratio')).toEqual([]);
    expect(resolveKnowledgeCategoryExclusions(null, 'wood gym floor question')).toEqual([]);
    expect(resolveKnowledgeCategoryExclusions(undefined, 'VCT floor')).toEqual([]);
  });
});
