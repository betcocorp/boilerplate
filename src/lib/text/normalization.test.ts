import { describe, expect, it } from 'vitest';

import { normalizeLookupValue, tokenizeLookupValue } from '~/lib/text/normalization';

describe('normalizeLookupValue (B0-39)', () => {
  it('lowercases, expands #, strips punctuation, and collapses whitespace', () => {
    expect(normalizeLookupValue('  #1  Laundry-Break! ')).toBe('number 1 laundry break');
    expect(normalizeLookupValue('BNC-15')).toBe('bnc 15');
    expect(normalizeLookupValue('Green Earth® Peroxide')).toBe('green earth peroxide');
  });

  it('returns an empty string for punctuation-only / empty input', () => {
    expect(normalizeLookupValue('   ')).toBe('');
    expect(normalizeLookupValue('!!!')).toBe('');
  });
});

describe('tokenizeLookupValue (B0-39)', () => {
  it('splits the normalized value into tokens', () => {
    expect(tokenizeLookupValue('#1 Laundry-Break')).toEqual(['number', '1', 'laundry', 'break']);
  });
  it('returns [] for empty/punctuation-only input', () => {
    expect(tokenizeLookupValue('   ')).toEqual([]);
  });
});
