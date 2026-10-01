import { describe, expect, it } from 'vitest';

import { extractResolvedProviderFromSummary } from '~/lib/tests/response-payload';

/**
 * B0-905 — `summary.resolvedProvider`: the vendor that answered a run, written once by
 * `executeTestRun` beside `summary.resolvedModel`.
 *
 * The reader is deliberately strict and the writer deliberately derives the value from the model id
 * (`modelProviderFor`), so the two fields can never contradict each other. What matters here is the
 * legacy case: a run written before the field must read as "unknown" rather than as OpenAI, because
 * the caller's fallback (deriving from the persisted model id) is correct while a default is a guess.
 */
describe('extractResolvedProviderFromSummary (B0-905)', () => {
  it('reads a recorded vendor', () => {
    expect(extractResolvedProviderFromSummary({ resolvedProvider: 'anthropic' })).toBe(
      'anthropic',
    );
    expect(extractResolvedProviderFromSummary({ resolvedProvider: 'openai' })).toBe('openai');
  });

  it('normalises case and surrounding whitespace', () => {
    expect(extractResolvedProviderFromSummary({ resolvedProvider: ' Anthropic ' })).toBe(
      'anthropic',
    );
  });

  it('returns null for a run that predates the field, so the caller derives it from the model', () => {
    expect(extractResolvedProviderFromSummary({ resolvedModel: 'claude-opus-5' })).toBeNull();
    expect(extractResolvedProviderFromSummary({})).toBeNull();
  });

  it('returns null rather than a vendor that does not exist', () => {
    expect(extractResolvedProviderFromSummary({ resolvedProvider: 'cohere' })).toBeNull();
    expect(extractResolvedProviderFromSummary({ resolvedProvider: '' })).toBeNull();
    expect(extractResolvedProviderFromSummary({ resolvedProvider: 42 })).toBeNull();
  });

  it('returns null for a summary that is not an object', () => {
    expect(extractResolvedProviderFromSummary(null)).toBeNull();
    expect(extractResolvedProviderFromSummary('anthropic')).toBeNull();
    expect(extractResolvedProviderFromSummary([{ resolvedProvider: 'openai' }])).toBeNull();
  });
});
