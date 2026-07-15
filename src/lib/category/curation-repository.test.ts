import { describe, expect, it } from 'vitest';

import { CURATION_FILTERS, parseCurationFilter } from '~/lib/category/curation-repository';

describe('parseCurationFilter (B0-36)', () => {
  it('accepts every known filter', () => {
    for (const f of CURATION_FILTERS) {
      expect(parseCurationFilter(f)).toBe(f);
    }
  });

  it('falls back to "all" for unknown or empty values', () => {
    expect(parseCurationFilter('bogus')).toBe('all');
    expect(parseCurationFilter('')).toBe('all');
    expect(parseCurationFilter(null)).toBe('all');
    expect(parseCurationFilter(undefined)).toBe('all');
  });
});
