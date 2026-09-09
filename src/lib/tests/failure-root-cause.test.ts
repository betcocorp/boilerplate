import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-908 — the root-cause analyst talks to a model only through the provider-neutral
 * `completeStructuredWithUsage`, so a `claude-*` id resolved from `BEX_RESPONSES_MODEL` / the run's
 * `modelTag` reaches it unchanged and is what gets stamped on the persisted suggestion.
 */
const { mockComplete, mockResolveModel, mockReplace } = vi.hoisted(() => ({
  mockComplete: vi.fn(),
  mockResolveModel: vi.fn(async () => 'gpt-test'),
  mockReplace: vi.fn(async () => {}),
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
vi.mock('~/lib/ai-suggestions/repository', () => ({
  replaceAiSuggestions: mockReplace,
}));
vi.mock('~/lib/observability/logger', () => ({
  logWarn: vi.fn(),
}));

import {
  analyzeAndPersistFailureRootCause,
  FAILURE_ROOT_CAUSE_ENTITY_TYPE,
} from './failure-root-cause';

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 };

const INPUT = {
  testResultItemId: 'tri-1',
  testName: 'Restroom set',
  prompt: 'What is the contact time for Pine Quat?',
  expectedShouldAnswer: true,
  responseText: 'I cannot help with that.',
  errorMessage: 'criteria not met',
  modelTag: 'claude-sonnet-5',
};

describe('analyzeAndPersistFailureRootCause (B0-617 / B0-908)', () => {
  beforeEach(() => {
    mockComplete.mockReset();
    mockReplace.mockClear();
    mockResolveModel.mockReset();
    mockResolveModel.mockResolvedValue('claude-sonnet-5');
  });

  it('sends the evidence + schema to completeStructuredWithUsage with the resolved claude id and persists it', async () => {
    mockComplete.mockResolvedValue({
      text: JSON.stringify({
        category: 'agent',
        root_cause: 'The agent refused without calling a retrieval tool.',
        suggested_fix: 'Force get_efficacy_data on contact-time questions.',
      }),
      usage: USAGE,
    });

    await analyzeAndPersistFailureRootCause(INPUT);

    expect(mockResolveModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(mockComplete).toHaveBeenCalledOnce();
    const request = mockComplete.mock.calls[0][0];
    expect(request).toMatchObject({
      model: 'claude-sonnet-5',
      schemaName: 'failure_root_cause',
      maxOutputTokens: 1024,
      temperature: 0.2,
      requestOptions: { maxRetries: 0, timeoutMs: 1000 },
    });
    expect(request.schema.required).toEqual(['category', 'root_cause', 'suggested_fix']);
    expect(request.schema.properties.category.enum).toEqual(['agent', 'corpus', 'retrieval', 'evaluation']);
    expect(request.system).toContain('You are a QA analyst diagnosing why a single AI agent test item failed.');
    expect(request.user).toContain('Test: Restroom set');
    expect(request.user).toContain('Failure reason recorded by the harness: criteria not met');
    expect(request.user).toContain('Response: I cannot help with that.');

    expect(mockReplace).toHaveBeenCalledWith(FAILURE_ROOT_CAUSE_ENTITY_TYPE, 'tri-1', [
      expect.objectContaining({
        title: 'Agent behavior',
        model: 'claude-sonnet-5',
        metadata: expect.objectContaining({ category: 'agent' }),
      }),
    ]);
  });

  it('persists nothing when the helper throws (truncation, refusal, transport)', async () => {
    mockComplete.mockRejectedValue(new Error('model refused the request'));

    await expect(analyzeAndPersistFailureRootCause(INPUT)).resolves.toBeUndefined();

    expect(mockReplace).not.toHaveBeenCalled();
  });
});
