import { describe, expect, it } from 'vitest';

import {
  normalizeSearchQuery,
  webSearchCacheKey,
  webSearchCacheReadKeys,
} from '~/lib/websearch/cache';

describe('normalizeSearchQuery (B0-326)', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizeSearchQuery('  Spartan   Chemical  ')).toBe('spartan chemical');
  });

  it('treats punctuation/separator variants of the same lookup as identical', () => {
    expect(normalizeSearchQuery('Zorbex Klenz-9000')).toBe(
      normalizeSearchQuery('zorbex klenz 9000'),
    );
    expect(normalizeSearchQuery('BNC-15')).toBe(normalizeSearchQuery('BNC 15'));
    expect(normalizeSearchQuery('spec OR cleaner')).toBe(
      normalizeSearchQuery('spec or cleaner'),
    );
  });

  it('keeps genuinely different products distinct', () => {
    expect(normalizeSearchQuery('Klenz-9000')).not.toBe(normalizeSearchQuery('Klenz-9001'));
  });

  it('preserves non-ascii letters rather than stripping them', () => {
    expect(normalizeSearchQuery('Crème Nettoyante')).toBe('crème nettoyante');
  });
});

describe('webSearchCacheKey (B0-326)', () => {
  it('collapses punctuation variance onto one key', () => {
    expect(webSearchCacheKey('tavily', { query: 'Klenz-9000 spec' })).toBe(
      webSearchCacheKey('tavily', { query: 'klenz 9000   spec' }),
    );
  });

  it('still separates provider, depth, maxResults and domains', () => {
    const base = { query: 'q' };
    expect(webSearchCacheKey('tavily', base)).not.toBe(webSearchCacheKey('mock', base));
    expect(webSearchCacheKey('tavily', base)).not.toBe(
      webSearchCacheKey('tavily', { ...base, depth: 'advanced' }),
    );
    expect(webSearchCacheKey('tavily', base)).not.toBe(
      webSearchCacheKey('tavily', { ...base, maxResults: 10 }),
    );
    expect(webSearchCacheKey('tavily', base)).not.toBe(
      webSearchCacheKey('tavily', { ...base, domains: ['epa.gov'] }),
    );
  });

  it('is order- and case-insensitive for the domain allowlist', () => {
    expect(webSearchCacheKey('tavily', { query: 'q', domains: ['EPA.gov', 'acme.com'] })).toBe(
      webSearchCacheKey('tavily', { query: 'q', domains: ['acme.com', 'epa.gov'] }),
    );
  });
});

describe('webSearchCacheReadKeys (B0-326)', () => {
  it('lets a stored advanced response satisfy a basic request', () => {
    const keys = webSearchCacheReadKeys('tavily', { query: 'q', depth: 'basic' });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(webSearchCacheKey('tavily', { query: 'q', depth: 'basic' }));
    expect(keys[1]).toBe(webSearchCacheKey('tavily', { query: 'q', depth: 'advanced' }));
  });

  it('defaults an unspecified depth to basic and still offers the advanced fallback', () => {
    expect(webSearchCacheReadKeys('tavily', { query: 'q' })).toEqual(
      webSearchCacheReadKeys('tavily', { query: 'q', depth: 'basic' }),
    );
  });

  it('never lets a basic response satisfy an advanced request', () => {
    const keys = webSearchCacheReadKeys('tavily', { query: 'q', depth: 'advanced' });
    expect(keys).toEqual([webSearchCacheKey('tavily', { query: 'q', depth: 'advanced' })]);
  });
});
