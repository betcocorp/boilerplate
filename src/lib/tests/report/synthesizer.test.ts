import { describe, expect, it, vi } from 'vitest';

import { StructuredOutputTruncatedError } from '~/lib/llm/structured-completion';

import type { EvaluatedCase, ReportMetrics } from './metrics';
import type { CaseHarnessAside } from './render';
import {
  chunkCases,
  digestChunkWithRetry,
  formatDigestsAsText,
  synthesizeReportFindings,
  type CaseFindings,
  type StructuredCompletionWithUsage,
} from './synthesizer';

// B0-1116 — recordGradingUsage talks to Supabase; stubbed so this stays a pure unit test.
const { mockRecordGradingUsage } = vi.hoisted(() => ({
  mockRecordGradingUsage: vi.fn(),
}));
vi.mock('~/lib/tests/grading-usage', () => ({
  recordGradingUsage: mockRecordGradingUsage,
}));

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedPromptTokens: 0 };

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
  // B0-863 — harness provenance, absent for these chunking-only fixtures.
  answerProvenance: null,
  routingDecision: null,
  gatesFired: null,
  draftDiscarded: false,
  chunkCount: null,
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
      return {
        text: JSON.stringify({ failurePatterns: [`fail:${ids.join(',')}`], strengths: [], weaknesses: [] }),
        usage: USAGE,
      };
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

  it('B0-1116 — records a synthesizer_digest row per successful call, including bisected retries, and nothing for a failed attempt', async () => {
    mockRecordGradingUsage.mockClear();
    const complete = fakeComplete(3); // a chunk of 6 overflows once and bisects into two of 3
    const chunk = Array.from({ length: 6 }, (_, i) => fakeCase(String(i)));
    const context = { testResultId: 'result-1' };

    await digestChunkWithRetry(complete, 'claude-opus-5', chunk, 'label', 'xhigh', context);

    // One failed attempt (the whole chunk of 6) recorded nothing; the two successful bisected
    // halves (3 each) each recorded their own row.
    expect(mockRecordGradingUsage).toHaveBeenCalledTimes(2);
    for (const call of mockRecordGradingUsage.mock.calls) {
      expect(call[0]).toMatchObject({
        context: { testResultId: 'result-1' },
        callSite: 'synthesizer_digest',
        provider: 'anthropic',
        model: 'claude-opus-5',
        usage: USAGE,
      });
    }
  });

  it('B0-1116 — records nothing when no context is given', async () => {
    mockRecordGradingUsage.mockClear();
    const complete = fakeComplete(3);
    const chunk = Array.from({ length: 3 }, (_, i) => fakeCase(String(i)));

    await digestChunkWithRetry(complete, 'model', chunk, 'label');

    expect(mockRecordGradingUsage).not.toHaveBeenCalled();
  });
});

/**
 * B0-863 — the synthesizer now sees each case's harness provenance (answer provenance, routing
 * decision, fired gates, draft-discarded, retrieved chunk count) alongside its explanation/missed/
 * incorrect findings, so its Top-3 recommendations can cite a specific mechanism instead of a
 * generic complaint. This only proves the text the model reads carries that evidence — it does not
 * (and cannot, without a live model) prove the model uses it well.
 */
describe('synthesizeReportFindings — harness provenance (B0-863)', () => {
  const RATE_BLOCK = { n: 1, avg: 40, grade: 'F', pass: 0, fail: 1, passPct: 0, failPct: 100 } as const;

  function fakeMetrics(evaluated: EvaluatedCase): ReportMetrics {
    return {
      overall: RATE_BLOCK,
      tiers: [['Tier 1', RATE_BLOCK]],
      categories: [['Dilution', RATE_BLOCK]],
      strongestCategory: null,
      weakestCategory: 'Dilution',
      uteCount: 0,
      perCase: [evaluated],
      // Every other field of `ReportMetrics` is untouched by `synthesizeReportFindings`.
    } as unknown as ReportMetrics;
  }

  const TOP3 = Array.from({ length: 3 }, (_, i) => ({
    priority: i + 1,
    what: 'x',
    whyFirst: 'x',
    evidence: 'x',
    affected: 'x',
    change: 'x',
    impact: 'x',
  }));

  function fakeSynthesisComplete() {
    let capturedUser = '';
    const complete = vi.fn(async (request: { user: string }) => {
      capturedUser = request.user;
      return {
        text: JSON.stringify({
          failurePatterns: [],
          strengths: [],
          weaknesses: [],
          top3: TOP3,
          exec: {
            strongestAreas: [],
            improvementAreas: [],
            mostSignificantFailure: 'x',
            majorRisk: 'x',
            readiness: 'x',
          },
        }),
        usage: USAGE,
      };
    });
    return { complete, getCapturedUser: () => capturedUser };
  }

  it('includes answer provenance, routing, fired gates, draft-discarded and chunk count as an evidence line', async () => {
    const evaluated = {
      id: 'case-1',
      tier: 'Tier 1',
      category: 'Dilution',
      overall: 20,
      grade: 'F',
      status: 'Fail',
    } as unknown as EvaluatedCase;

    const harness: CaseHarnessAside = {
      passed: false,
      status: 'failed',
      similarity: null,
      answerProvenance: 'regulated_claim_partial_redaction',
      routingDecision: 'llm',
      gates: [{ name: 'regulatedClaimGuardrail', verdict: 'rejected' }],
      draftDiscarded: true,
      chunkCount: 2,
    };

    const findingsByCaseId = new Map<string, CaseFindings>([
      ['case-1', { explanation: 'Declined entirely.', missed: 'Everything.', incorrect: '', harness }],
    ]);

    const { complete, getCapturedUser } = fakeSynthesisComplete();

    await synthesizeReportFindings(fakeMetrics(evaluated), findingsByCaseId, 'result-1', undefined, undefined, {
      complete: complete as unknown as StructuredCompletionWithUsage,
      resolveModel: async () => 'fake-model',
    });

    const user = getCapturedUser();
    expect(user).toContain('answer provenance: regulated_claim_partial_redaction');
    expect(user).toContain('routing: llm');
    expect(user).toContain('gates fired: regulatedClaimGuardrail: rejected');
    expect(user).toContain('draft discarded');
    expect(user).toContain('retrieved chunks: 2');
  });

  it('omits the provenance line entirely when a case carries no harness (no result row)', async () => {
    const evaluated = {
      id: 'case-2',
      tier: 'Tier 1',
      category: 'Dilution',
      overall: 90,
      grade: 'A',
      status: 'Pass',
    } as unknown as EvaluatedCase;

    const findingsByCaseId = new Map<string, CaseFindings>([
      ['case-2', { explanation: 'Fine.', missed: '', incorrect: '', harness: null }],
    ]);

    const { complete, getCapturedUser } = fakeSynthesisComplete();

    await synthesizeReportFindings(fakeMetrics(evaluated), findingsByCaseId, 'result-1', undefined, undefined, {
      complete: complete as unknown as StructuredCompletionWithUsage,
      resolveModel: async () => 'fake-model',
    });

    expect(getCapturedUser()).not.toContain('Harness provenance');
  });

  it('B0-1116 — records a synthesizer_final row on a successful Top-3/exec call', async () => {
    mockRecordGradingUsage.mockClear();
    const evaluated = {
      id: 'case-3',
      tier: 'Tier 1',
      category: 'Dilution',
      overall: 90,
      grade: 'A',
      status: 'Pass',
    } as unknown as EvaluatedCase;
    const findingsByCaseId = new Map<string, CaseFindings>([
      ['case-3', { explanation: 'Fine.', missed: '', incorrect: '', harness: null }],
    ]);
    const { complete } = fakeSynthesisComplete();

    await synthesizeReportFindings(fakeMetrics(evaluated), findingsByCaseId, 'result-2', 'claude-opus-5', undefined, {
      complete: complete as unknown as StructuredCompletionWithUsage,
      resolveModel: async () => 'claude-opus-5',
    });

    expect(mockRecordGradingUsage).toHaveBeenCalledWith({
      context: { testResultId: 'result-2' },
      callSite: 'synthesizer_final',
      provider: 'anthropic',
      model: 'claude-opus-5',
      usage: USAGE,
    });
  });

  it('B0-1116 — records nothing for a final call that throws (overflow), only for the retry that succeeds', async () => {
    mockRecordGradingUsage.mockClear();
    const evaluated = {
      id: 'case-4',
      tier: 'Tier 1',
      category: 'Dilution',
      overall: 90,
      grade: 'A',
      status: 'Pass',
    } as unknown as EvaluatedCase;
    const findingsByCaseId = new Map<string, CaseFindings>([
      ['case-4', { explanation: 'Fine.', missed: '', incorrect: '', harness: null }],
    ]);
    const { complete: succeedingComplete } = fakeSynthesisComplete();
    let attempt = 0;
    const flakyComplete = vi.fn(async (request: { user: string }) => {
      attempt += 1;
      if (attempt === 1) {
        throw new StructuredOutputTruncatedError();
      }
      return (succeedingComplete as unknown as (r: { user: string }) => Promise<unknown>)(request);
    });

    await synthesizeReportFindings(fakeMetrics(evaluated), findingsByCaseId, 'result-3', undefined, undefined, {
      complete: flakyComplete as unknown as StructuredCompletionWithUsage,
      resolveModel: async () => 'fake-model',
    });

    expect(attempt).toBe(2);
    expect(mockRecordGradingUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordGradingUsage).toHaveBeenCalledWith(
      expect.objectContaining({ callSite: 'synthesizer_final', context: { testResultId: 'result-3' } }),
    );
  });
});
