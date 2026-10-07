import { describe, expect, it } from 'vitest';

import { inferSectionTypeFromQuery } from './section-type-inference';

describe('pH section-type inference', () => {
  it('routes standalone pH questions to physical properties', () => {
    expect(inferSectionTypeFromQuery('What is the pH of Push Mint?')).toBe(
      'physical_properties',
    );
  });

  it('does not match the letters ph inside unrelated words', () => {
    expect(inferSectionTypeFromQuery('Which upholstery cleaner should I use?')).toBeNull();
  });

  it('prioritizes an explicit PPE request over a product name containing Concentrate', () => {
    expect(
      inferSectionTypeFromQuery('What PPE do I need when using Speedex Concentrate?'),
    ).toBe('exposure_ppe');
  });
});
