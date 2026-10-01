import { describe, expect, it } from 'vitest';

import { formatLastUsed } from '~/components/admin/projects/format';
import { isTokenActive } from '~/lib/api/registry-repository';

const NOW = new Date('2026-07-15T12:00:00Z').getTime();

describe('isTokenActive (B0-116)', () => {
  it('is active when neither revoked nor expired', () => {
    expect(isTokenActive({ revokedAt: null, expiresAt: null }, NOW)).toBe(true);
  });
  it('is inactive when revoked', () => {
    expect(isTokenActive({ revokedAt: '2026-07-01T00:00:00Z', expiresAt: null }, NOW)).toBe(false);
  });
  it('is inactive when expired', () => {
    expect(isTokenActive({ revokedAt: null, expiresAt: '2026-07-01T00:00:00Z' }, NOW)).toBe(false);
  });
  it('is active when expiry is in the future', () => {
    expect(isTokenActive({ revokedAt: null, expiresAt: '2026-08-01T00:00:00Z' }, NOW)).toBe(true);
  });
});

describe('formatLastUsed (B0-116/B0-117)', () => {
  it('returns "never" for null', () => {
    expect(formatLastUsed(null, NOW)).toBe('never');
  });
  it('formats minutes/hours/days', () => {
    expect(formatLastUsed('2026-07-15T11:57:00Z', NOW)).toBe('3m ago');
    expect(formatLastUsed('2026-07-15T09:00:00Z', NOW)).toBe('3h ago');
    expect(formatLastUsed('2026-07-13T12:00:00Z', NOW)).toBe('2d ago');
  });
});
