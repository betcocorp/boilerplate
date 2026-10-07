import { describe, expect, it } from 'vitest';

import { compareAppVersionsDesc } from './versions';

describe('compareAppVersionsDesc (B0-575)', () => {
  it('sorts newest first with numeric segment comparison', () => {
    const sorted = ['1.9.0', '1.10.0', '2.0.0', '1.0.0'].sort(compareAppVersionsDesc);
    expect(sorted).toEqual(['2.0.0', '1.10.0', '1.9.0', '1.0.0']);
  });

  it('a release outranks its own pre-releases, and dev builds order numerically', () => {
    const sorted = ['2.0.0-dev.3', '2.0.0', '2.0.0-dev.10', '2.0.0-dev.2'].sort(
      compareAppVersionsDesc,
    );
    expect(sorted).toEqual(['2.0.0', '2.0.0-dev.10', '2.0.0-dev.3', '2.0.0-dev.2']);
  });

  it('falls back to string comparison for non-semver values without throwing', () => {
    const sorted = ['abc', '1.0.0'].sort(compareAppVersionsDesc);
    expect(sorted).toHaveLength(2);
  });
});
