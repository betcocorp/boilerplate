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
  it('formats the token with the bex_ prefix (no environment segment)', () => {
    expect(generateApiToken().token).toMatch(/^bex_[A-Za-z0-9_-]+$/);
  });

  it('stores a hash that matches sha256 of the full token, never the token itself', () => {
    const { token, tokenHash } = generateApiToken();
    expect(tokenHash).toBe(hashApiToken(token));
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('exposes a prefix that is a leading slice of the token', () => {
    const { token, prefix } = generateApiToken();
    expect(token.startsWith(prefix)).toBe(true);
    expect(prefix.startsWith('bex_')).toBe(true);
  });

  it('produces a unique secret each call', () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});

describe('hashApiToken', () => {
  it('is deterministic', () => {
    expect(hashApiToken('bex_abc')).toBe(hashApiToken('bex_abc'));
  });
});

describe('looksLikeApiToken', () => {
  it('accepts well-formed tokens (current and legacy env-prefixed)', () => {
    expect(looksLikeApiToken(generateApiToken().token)).toBe(true);
    // Legacy bex_<env>_<secret> tokens minted before env removal still pass the shape check.
    expect(looksLikeApiToken('bex_prod_aaaaaaaaaaaaaaaa')).toBe(true);
  });

  it('rejects garbage, wrong scheme, and truncated tokens', () => {
    expect(looksLikeApiToken('')).toBe(false);
    expect(looksLikeApiToken('not-a-token')).toBe(false);
    expect(looksLikeApiToken('bex_short')).toBe(false);
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
