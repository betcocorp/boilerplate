import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-908 — `gradeSemanticDecline` talks to a model only through the provider-neutral
 * `completeStructuredWithUsage`, so a `claude-*` id resolved from `BEX_RESPONSES_MODEL` / the run's
 * `modelTag` reaches it unchanged with the same prompt + schema bytes and transport knobs.
 */
const { mockComplete, mockResolveModel } = vi.hoisted(() => ({
  mockComplete: vi.fn(),
  mockResolveModel: vi.fn(async () => 'gpt-test'),
}));
vi.mock('~/lib/llm/structured-completion', () => ({
  completeStructuredWithUsage: mockComplete,
}));
vi.mock('~/lib/openai/client', () => ({
  resolveResponsesModel: mockResolveModel,
}));
vi.mock('~/lib/openai/transport-retry', () => ({
  resolveOpenAiRequestTimeoutMs: () => 1000,
  retryTransportFaults: (fn: () => unknown) => fn(),
}));
vi.mock('~/lib/workflows/product-support/max-output-tokens', () => ({
  resolveMaxOutputTokens: () => 1024,
}));

import { gradeSemanticDecline } from './decline-grader';
import { DECLINE_GRADER_JSON_SCHEMA } from './decline-schemas';

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 };

describe('gradeSemanticDecline (B0-755 / B0-908)', () => {
  beforeEach(() => {
    mockComplete.mockReset();
    mockResolveModel.mockReset();
    mockResolveModel.mockResolvedValue('gpt-test');
  });

  it('passes a resolved claude id through to completeStructuredWithUsage with the decline schema', async () => {
    mockResolveModel.mockResolvedValue('claude-sonnet-5');
    mockComplete.mockResolvedValue({
      text: JSON.stringify({ isDecline: true, rationale: 'Points the user to a distributor.' }),
      usage: USAGE,
    });

    const verdict = await gradeSemanticDecline({
      prompt: 'How much does Pine Quat cost?',
      responseText: 'Pricing varies by distributor; please contact your Betco rep.',
      idealResponse: 'Refer the user to their distributor.',
      // B0-931/932 — `text[]` columns: one element per phrase, rendered verbatim.
      expectedConcepts: ['pricing varies by distributor and agreement'],
      minimumConcepts: ['no pricing information', 'directs the customer to a distributor'],
      modelTag: 'claude-sonnet-5',
    });

    expect(mockResolveModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(mockComplete).toHaveBeenCalledOnce();
    const request = mockComplete.mock.calls[0][0];
    expect(request).toMatchObject({
      model: 'claude-sonnet-5',
      schemaName: 'semantic_decline_grading_result',
      schema: DECLINE_GRADER_JSON_SCHEMA,
      maxOutputTokens: 1024,
      temperature: 0,
      requestOptions: { maxRetries: 0, timeoutMs: 1000 },
    });
    expect(request.system).toContain('You are grading whether an AI assistant\'s response is a "decline"');
    expect(request.user).toContain('Original prompt (expected to be declined, not answered):\nHow much does Pine Quat cost?');
    expect(request.user).toContain('What a correct decline looks like for this question:\nRefer the user to their distributor.');
    // Each mandatory concept is its own verbatim bullet — never re-joined into one delimited cell.
    expect(request.user).toContain(
      'Minimum concepts a correct decline should cover:\n- no pricing information\n- directs the customer to a distributor',
    );
    expect(request.user).toContain(
      'Full expected concepts:\n- pricing varies by distributor and agreement',
    );
    expect(verdict).toMatchObject({ isDecline: true });
  });

  it('propagates a helper failure instead of guessing a verdict', async () => {
    mockComplete.mockRejectedValue(new Error('output truncated at max_output_tokens'));

    await expect(
      gradeSemanticDecline({
        prompt: 'p',
        responseText: 'r',
        idealResponse: null,
        expectedConcepts: [],
        minimumConcepts: [],
      }),
    ).rejects.toThrow('output truncated');
  });
});
