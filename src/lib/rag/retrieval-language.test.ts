import { describe, expect, it } from 'vitest';

import {
  assertRetrievalLanguageCode,
  isRetrievableLanguageCode,
  normalizeRetrievalLanguageCode,
  RETRIEVAL_LANGUAGE_CODE,
  RETRIEVAL_LANGUAGE_CODES,
  retrievalLanguageCodeSchema,
} from '~/lib/rag/retrieval-language';

describe('retrieval language policy (B0-804)', () => {
  it('allows exactly EN — widening this set means re-deciding the match_* RPC filters too', () => {
    expect([...RETRIEVAL_LANGUAGE_CODES]).toEqual(['EN']);
    expect(RETRIEVAL_LANGUAGE_CODE).toBe('EN');
  });

  it('accepts EN in any casing or padding', () => {
    for (const raw of ['EN', 'en', 'En', ' en ', '\tEN\n', '  eN  ']) {
      const result = normalizeRetrievalLanguageCode(raw);
      expect(result.ok, `expected ${JSON.stringify(raw)} to be accepted`).toBe(true);
      expect(result.ok && result.languageCode).toBe('EN');
    }
  });

  it('defaults blank, whitespace-only, undefined and null to EN — unchanged behaviour for normal use', () => {
    for (const raw of ['', '   ', undefined, null]) {
      const result = normalizeRetrievalLanguageCode(raw);
      expect(result.ok, `expected ${JSON.stringify(raw)} to default`).toBe(true);
      expect(result.ok && result.languageCode).toBe('EN');
    }
  });

  it('rejects the languages actually present in rag.document (FR 158, ES 637, IT 1)', () => {
    for (const raw of ['FR', 'ES', 'IT', 'fr', ' es ']) {
      const result = normalizeRetrievalLanguageCode(raw);
      expect(result.ok, `expected ${JSON.stringify(raw)} to be rejected`).toBe(false);
      if (!result.ok) {
        expect(result.requested).toBe(raw.trim().toUpperCase());
        expect(result.error).toContain('B0-804');
      }
    }
  });

  it('rejects anything else, including near-misses and non-strings', () => {
    for (const raw of ['ENG', 'EN-US', 'en_US', 'XX', 'all', 42, true, {}]) {
      expect(normalizeRetrievalLanguageCode(raw).ok).toBe(false);
    }
  });

  it('assertRetrievalLanguageCode throws an error that names the ticket', () => {
    expect(assertRetrievalLanguageCode(undefined)).toBe('EN');
    expect(assertRetrievalLanguageCode(' en ')).toBe('EN');
    expect(() => assertRetrievalLanguageCode('FR')).toThrow(/B0-804/);
    expect(() => assertRetrievalLanguageCode('FR')).toThrow(/"FR"/);
  });

  it('isRetrievableLanguageCode treats an unknown or missing stored language as NOT retrievable', () => {
    expect(isRetrievableLanguageCode('EN')).toBe(true);
    expect(isRetrievableLanguageCode(' en ')).toBe(true);
    expect(isRetrievableLanguageCode('FR')).toBe(false);
    expect(isRetrievableLanguageCode('')).toBe(false);
    expect(isRetrievableLanguageCode(null)).toBe(false);
    expect(isRetrievableLanguageCode(undefined)).toBe(false);
  });

  it('exposes a Zod schema that validates already-normalized codes', () => {
    expect(retrievalLanguageCodeSchema.safeParse('EN').success).toBe(true);
    expect(retrievalLanguageCodeSchema.safeParse('en').success).toBe(false);
    expect(retrievalLanguageCodeSchema.safeParse('FR').success).toBe(false);
  });
});
