import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-1109 — `recordGradingUsage` is fire-and-forget: it must never make a grading call site await a
 * database write, so the function itself returns void and only logs (never throws) on failure. This
 * mocks the Supabase insert as a resolved/rejected-`error` promise and asserts on the insert payload
 * plus the failure log, the same style `insertTestItems`'s own tests use for the service-role client.
 */
const { mockInsert, mockFrom, mockLogWarn } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockFrom: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => ({ from: mockFrom }),
}));
vi.mock('~/lib/observability/logger', () => ({
  logWarn: mockLogWarn,
}));

mockFrom.mockImplementation(() => ({ insert: mockInsert }));

import { recordGradingUsage } from './grading-usage';

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedPromptTokens: 2 };

describe('recordGradingUsage (B0-1109)', () => {
  beforeEach(() => {
    mockInsert.mockReset();
    mockFrom.mockClear();
    mockLogWarn.mockClear();
  });

  it('inserts a row shaped for test_grading_usage against the given table', () => {
    mockInsert.mockReturnValue(Promise.resolve({ error: null }));

    recordGradingUsage({
      context: { testResultId: 'tr-1', testItemId: 'ti-1' },
      callSite: 'criteria_grader',
      provider: 'openai',
      model: 'gpt-4.1',
      usage: USAGE,
    });

    expect(mockFrom).toHaveBeenCalledWith('test_grading_usage');
    expect(mockInsert).toHaveBeenCalledWith({
      test_result_id: 'tr-1',
      test_item_id: 'ti-1',
      pass_index: null,
      call_site: 'criteria_grader',
      provider: 'openai',
      model: 'gpt-4.1',
      prompt_tokens: 10,
      completion_tokens: 5,
      cached_prompt_tokens: 2,
      total_tokens: 15,
    });
  });

  it('B0-1112 — omits testItemId and passes passIndex through for report-generation call sites', () => {
    mockInsert.mockReturnValue(Promise.resolve({ error: null }));

    recordGradingUsage({
      context: { testResultId: 'tr-5', passIndex: 2 },
      callSite: 'case_scorer',
      provider: 'openai',
      model: 'gpt-4.1',
      usage: USAGE,
    });

    expect(mockInsert).toHaveBeenCalledWith({
      test_result_id: 'tr-5',
      test_item_id: null,
      pass_index: 2,
      call_site: 'case_scorer',
      provider: 'openai',
      model: 'gpt-4.1',
      prompt_tokens: 10,
      completion_tokens: 5,
      cached_prompt_tokens: 2,
      total_tokens: 15,
    });
  });

  it('does not throw synchronously, even when the insert rejects/errors', () => {
    mockInsert.mockReturnValue(Promise.resolve({ error: { message: 'db unavailable' } }));

    expect(() =>
      recordGradingUsage({
        context: { testResultId: 'tr-2', testItemId: 'ti-2' },
        callSite: 'decline_grader',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        usage: USAGE,
      }),
    ).not.toThrow();
  });

  it('logs a warning (never throws) when the insert reports an error', async () => {
    mockInsert.mockReturnValue(Promise.resolve({ error: { message: 'db unavailable' } }));

    recordGradingUsage({
      context: { testResultId: 'tr-3', testItemId: 'ti-3' },
      callSite: 'failure_root_cause',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: USAGE,
    });

    await vi.waitFor(() => {
      expect(mockLogWarn).toHaveBeenCalledWith('test_grading_usage_persist_failed', {
        testResultId: 'tr-3',
        testItemId: 'ti-3',
        callSite: 'failure_root_cause',
        message: 'db unavailable',
      });
    });
  });

  it('does not log when the insert succeeds', async () => {
    mockInsert.mockReturnValue(Promise.resolve({ error: null }));

    recordGradingUsage({
      context: { testResultId: 'tr-4', testItemId: 'ti-4' },
      callSite: 'criteria_grader',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      usage: USAGE,
    });

    // Flush the microtask queue the mocked `.then()` resolves on.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockLogWarn).not.toHaveBeenCalled();
  });
});
