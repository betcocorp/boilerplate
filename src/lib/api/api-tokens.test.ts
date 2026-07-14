import { describe, expect, it } from 'vitest';

import {
  extractBearerToken,
  generateApiToken,
  hashApiToken,
  looksLikeApiToken,
} from '~/lib/api/api-tokens';

function requestWithAuth(headerValue?: string): Request {
  return new Request('http://localhost/api/v1/agents', {
    headers: headerValue ? { authorization: headerValue } : {},
  });
}

describe('generateApiToken', () => {
  it('formats the token with the environment segment', () => {
    expect(generateApiToken('production').token).toMatch(/^bex_prod_/);
    expect(generateApiToken('staging').token).toMatch(/^bex_stg_/);
    expect(generateApiToken('development').token).toMatch(/^bex_dev_/);
  });

  it('stores a hash that matches sha256 of the full token, never the token itself', () => {
    const { token, tokenHash } = generateApiToken('production');
    expect(tokenHash).toBe(hashApiToken(token));
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('exposes a prefix that is a leading slice of the token', () => {
    const { token, prefix } = generateApiToken('production');
    expect(token.startsWith(prefix)).toBe(true);
    expect(prefix.startsWith('bex_prod_')).toBe(true);
  });

  it('produces a unique secret each call', () => {
    const a = generateApiToken('production');
    const b = generateApiToken('production');
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});

describe('hashApiToken', () => {
  it('is deterministic', () => {
    expect(hashApiToken('bex_prod_abc')).toBe(hashApiToken('bex_prod_abc'));
  });
});

describe('looksLikeApiToken', () => {
  it('accepts well-formed tokens', () => {
    expect(looksLikeApiToken(generateApiToken('production').token)).toBe(true);
    expect(looksLikeApiToken(generateApiToken('development').token)).toBe(true);
  });

  it('rejects garbage, wrong scheme, and truncated tokens', () => {
    expect(looksLikeApiToken('')).toBe(false);
    expect(looksLikeApiToken('not-a-token')).toBe(false);
    expect(looksLikeApiToken('bex_prod_short')).toBe(false);
    expect(looksLikeApiToken('bex_qa_aaaaaaaaaaaaaaaa')).toBe(false);
    expect(looksLikeApiToken('sk_live_aaaaaaaaaaaaaaaa')).toBe(false);
  });
});

describe('extractBearerToken', () => {
  it('extracts a bearer credential case-insensitively', () => {
    expect(extractBearerToken(requestWithAuth('Bearer abc123'))).toBe('abc123');
    expect(extractBearerToken(requestWithAuth('bearer abc123'))).toBe('abc123');
  });

  it('returns null when the header is absent, empty, or a different scheme', () => {
    expect(extractBearerToken(requestWithAuth())).toBeNull();
    expect(extractBearerToken(requestWithAuth('Bearer '))).toBeNull();
    expect(extractBearerToken(requestWithAuth('Basic abc123'))).toBeNull();
    expect(extractBearerToken(requestWithAuth('abc123'))).toBeNull();
  });
});
