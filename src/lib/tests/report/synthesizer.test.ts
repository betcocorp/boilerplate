import { describe, expect, it, vi } from 'vitest';

import { StructuredOutputTruncatedError } from '~/lib/llm/structured-completion';

import { chunkCases, digestChunkWithRetry, formatDigestsAsText } from './synthesizer';

type CaseSummary = Parameters<typeof chunkCases>[0][number];

const fakeCase = (id: string): CaseSummary => ({
  id,
  tier: 'Tier 1',
  category: 'general',
  overall: 90,
  grade: 'A',
  status: 'Pass',
  explanation: '',
  missed: '',
  incorrect: '',
});

/**
 * B0-735 — these pin down the two pieces of the chunk/merge fix that don't require an OpenAI
 * call: chunking stays bounded per chunk regardless of total case count, and the merged digest
 * text grows with chunk COUNT, not case count.
 */
describe('chunkCases', () => {
  it('splits into chunkSize-sized groups, preserving order', () => {
    const cases = Array.from({ length: 12 }, (_, i) => fakeCase(String(i)));
    const chunks = chunkCases(cases, 5);
    expect(chunks.map((c) => c.length)).toEqual([5, 5, 2]);
    expect(chunks[0][0].id).toBe('0');
    expect(chunks[2][1].id).toBe('11');
  });

  it('returns a single chunk when cases fit within chunkSize', () => {
    const cases = Array.from({ length: 3 }, (_, i) => fakeCase(String(i)));
    expect(chunkCases(cases, 50)).toHaveLength(1);
  });

  it('returns no chunks for an empty case list', () => {
    expect(chunkCases([], 50)).toHaveLength(0);
  });
});

describe('formatDigestsAsText', () => {
  it('labels each bullet with its batch and stays bounded by batch count, not bullet volume', () => {
    const text = formatDigestsAsText([
      { failurePatterns: ['missed dilution ratio (case A1)'], strengths: [], weaknesses: ['vague on contact time (case A2)'] },
      { failurePatterns: [], strengths: ['cited SDS correctly (case B1)'], weaknesses: [] },
    ]);

    expect(text).toContain('aggregated from 2 batches');
    expect(text).toContain('[Batch 1] missed dilution ratio (case A1)');
    expect(text).toContain('[Batch 2] cited SDS correctly (case B1)');
    expect(text).toContain('[Batch 1] vague on contact time (case A2)');
  });

  it('handles a batch with no findings in a list without crashing', () => {
    const text = formatDigestsAsText([{ failurePatterns: [], strengths: [], weaknesses: [] }]);
    expect(text).toContain('aggregated from 1 batches');
  });
});

/**
 * B0-735 — a fixed chunk size and token budget narrowed the odds of overflow but couldn't
 * guarantee it away (verbosity varies run to run for the same input); these prove the bisection
 * retry actually recovers instead of just hoping the budget was big enough.
 */
describe('digestChunkWithRetry', () => {
  const idsInPrompt = (content: string) => [...content.matchAll(/^Case (\S+)/gm)].map((m) => m[1]);

  /**
   * Simulates the seam's truncation error (B0-819 — what both providers surface when the output cap
   * cuts generation off) for any call whose chunk exceeds `maxCasesOk`.
   */
  function fakeComplete(maxCasesOk: number) {
    return vi.fn(async ({ user }: { user: string }) => {
      const ids = idsInPrompt(user);
      if (ids.length > maxCasesOk) {
        throw new StructuredOutputTruncatedError();
      }
      return JSON.stringify({ failurePatterns: [`fail:${ids.join(',')}`], strengths: [], weaknesses: [] });
    }) as unknown as Parameters<typeof digestChunkWithRetry>[0];
  }

  it('bisects an overflowing chunk until every half fits, then merges in original order', async () => {
    const complete = fakeComplete(3);
    const chunk = Array.from({ length: 10 }, (_, i) => fakeCase(String(i)));

    const digest = await digestChunkWithRetry(complete, 'model', chunk, 'label');

    const citedIds = digest.failurePatterns.flatMap((line) => line.replace('fail:', '').split(','));
    expect(citedIds).toEqual(chunk.map((c) => c.id));
  });

  it('rethrows once bisection bottoms out and every half still overflows', async () => {
    const complete = fakeComplete(-1); // nothing ever fits
    const chunk = Array.from({ length: 5 }, (_, i) => fakeCase(String(i)));

    await expect(digestChunkWithRetry(complete, 'model', chunk, 'label')).rejects.toThrow(
      /max_output_tokens/,
    );
  });

  it('passes the grading effort through to every digest call, splits included', async () => {
    const complete = fakeComplete(3);
    const chunk = Array.from({ length: 6 }, (_, i) => fakeCase(String(i)));

    await digestChunkWithRetry(complete, 'claude-opus-5', chunk, 'label', 'xhigh');

    const calls = (complete as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const [request] of calls) {
      expect(request.effort).toBe('xhigh');
      expect(request.schemaName).toBe('batch_digest');
      expect(request.model).toBe('claude-opus-5');
    }
  });
});
