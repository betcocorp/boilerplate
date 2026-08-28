import { describe, expect, it } from 'vitest';

import { chunkCases, formatDigestsAsText } from './synthesizer';

/**
 * B0-735 — these pin down the two pieces of the chunk/merge fix that don't require an OpenAI
 * call: chunking stays bounded per chunk regardless of total case count, and the merged digest
 * text grows with chunk COUNT, not case count.
 */
describe('chunkCases', () => {
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
