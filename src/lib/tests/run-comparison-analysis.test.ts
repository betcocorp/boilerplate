import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockComplete, mockResolveModel } = vi.hoisted(() => ({
  mockComplete: vi.fn(),
  mockResolveModel: vi.fn(async () => 'gpt-test'),
}));
vi.mock('~/lib/llm/structured-completion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/llm/structured-completion')>()),
  completeStructuredWithUsage: mockComplete,
}));
vi.mock('~/lib/openai/client', () => ({
  resolveResponsesModel: mockResolveModel,
}));

import { StructuredOutputTruncatedError } from '~/lib/llm/structured-completion';

import {
  analyzeRunComparison,
  RUN_COMPARISON_ANALYSIS_JSON_SCHEMA,
  runComparisonAnalysisSchema,
  runComparisonFailureAnalysisSchema,
} from './run-comparison-analysis';
import type { RunComparisonDiff } from './run-comparison-diff';

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 };

function diffWith(over: Partial<RunComparisonDiff> = {}): RunComparisonDiff {
  return {
    currentPassRate: 0.8,
    previousPassRate: 0.9,
    scoreDelta: -0.1,
    newFailures: [],
    fixes: [],
    ...over,
  } as RunComparisonDiff;
}

const NEW_FAILURE = {
  resultItemId: 'r1',
  testItemId: 'item-1',
  rowIndex: 0,
  prompt: 'How do I dilute Pine Quat?',
  errorMessage: null,
};

describe('runComparisonFailureAnalysisSchema', () => {
  it('accepts a well-formed failure analysis', () => {
    const result = runComparisonFailureAnalysisSchema.safeParse({
      testItemId: 'abc-123',
      cause: 'The corpus no longer has a Basic Coatings SDS chunk for this dilution question.',
      fix: 'Re-ingest the Basic Coatings label after the B0-260 conversion fix.',
    });

    expect(result.success).toBe(true);
  });

  it('rejects an empty cause or fix', () => {
    expect(
      runComparisonFailureAnalysisSchema.safeParse({
        testItemId: 'abc-123',
        cause: '',
        fix: 'Something.',
      }).success,
    ).toBe(false);

    expect(
      runComparisonFailureAnalysisSchema.safeParse({
        testItemId: 'abc-123',
        cause: 'Something.',
        fix: '',
      }).success,
    ).toBe(false);
  });

  it('rejects a missing testItemId', () => {
    expect(
      runComparisonFailureAnalysisSchema.safeParse({
        cause: 'Something.',
        fix: 'Something else.',
      }).success,
    ).toBe(false);
  });
});

describe('runComparisonAnalysisSchema', () => {
  it('accepts a well-formed response with failures', () => {
    const result = runComparisonAnalysisSchema.safeParse({
      verdict: 'regressed',
      verdictSummary: 'Pass rate dropped 12 points after the reranker rollout in the current run notes.',
      failures: [
        { testItemId: 'a', cause: 'Reranker demoted the correct chunk.', fix: 'Tune the rerank weight.' },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('accepts an empty failures array (no new failures)', () => {
    const result = runComparisonAnalysisSchema.safeParse({
      verdict: 'flat',
      verdictSummary: 'No new failures and no recoveries versus the previous run.',
      failures: [],
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown verdict', () => {
    expect(
      runComparisonAnalysisSchema.safeParse({
        verdict: 'worse',
        verdictSummary: 'Bad verdict value.',
        failures: [],
      }).success,
    ).toBe(false);
  });

  it('rejects a missing verdictSummary', () => {
    expect(
      runComparisonAnalysisSchema.safeParse({
        verdict: 'flat',
        failures: [],
      }).success,
    ).toBe(false);
  });
});

/**
 * B0-908 — the model call goes through the provider-neutral `completeStructuredWithUsage` with a
 * strict schema, so a `claude-*` `BEX_RESPONSES_MODEL` works; the deterministic short-circuit and the
 * `parse_error` / `invalid_shape` outcomes are unchanged.
 */
describe('analyzeRunComparison', () => {
  beforeEach(() => {
    mockComplete.mockReset();
    mockResolveModel.mockReset();
    mockResolveModel.mockResolvedValue('gpt-test');
  });

  it('never calls the model when there are no new failures', async () => {
    const result = await analyzeRunComparison({
      diff: diffWith({ fixes: [{ ...NEW_FAILURE, testItemId: 'fixed-1' }] }),
      currentNotes: null,
      previousNotes: null,
    });

    expect(mockComplete).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      analysis: {
        verdict: 'improved',
        verdictSummary: 'No new failures; 1 previously-failing case(s) now pass.',
        failures: [],
      },
    });
  });

  it('sends the strict schema and a resolved claude id to completeStructuredWithUsage', async () => {
    mockResolveModel.mockResolvedValue('claude-sonnet-5');
    mockComplete.mockResolvedValue({
      text: JSON.stringify({
        verdict: 'regressed',
        verdictSummary: 'One case regressed.',
        failures: [{ testItemId: 'item-1', cause: 'Reranker demoted the chunk.', fix: 'Retune.' }],
      }),
      usage: USAGE,
    });

    const result = await analyzeRunComparison({
      diff: diffWith({ newFailures: [NEW_FAILURE] }),
      currentNotes: 'Deployed reranker v2',
      previousNotes: null,
    });

    expect(mockComplete).toHaveBeenCalledOnce();
    const request = mockComplete.mock.calls[0][0];
    expect(request).toMatchObject({
      model: 'claude-sonnet-5',
      schemaName: 'run_comparison_analysis',
      schema: RUN_COMPARISON_ANALYSIS_JSON_SCHEMA,
      maxOutputTokens: 3000,
      temperature: 0.2,
    });
    expect(request.system).toContain('You are a QA analyst investigating a regression');
    expect(request.user).toContain('[testItemId: item-1]');
    expect(request.user).toContain('Deployed reranker v2');
    expect(result).toEqual({
      ok: true,
      analysis: {
        verdict: 'regressed',
        verdictSummary: 'One case regressed.',
        failures: [{ testItemId: 'item-1', cause: 'Reranker demoted the chunk.', fix: 'Retune.' }],
      },
    });
  });

  it('reports parse_error when the structured answer is truncated', async () => {
    mockComplete.mockRejectedValue(new StructuredOutputTruncatedError());

    const result = await analyzeRunComparison({
      diff: diffWith({ newFailures: [NEW_FAILURE] }),
      currentNotes: null,
      previousNotes: null,
    });

    expect(result).toEqual({ ok: false, reason: 'parse_error' });
  });

  it('reports invalid_shape when the JSON does not satisfy the Zod schema', async () => {
    mockComplete.mockResolvedValue({
      text: JSON.stringify({ verdict: 'worse', verdictSummary: 'x', failures: [] }),
      usage: USAGE,
    });

    const result = await analyzeRunComparison({
      diff: diffWith({ newFailures: [NEW_FAILURE] }),
      currentNotes: null,
      previousNotes: null,
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_shape' });
  });
});
