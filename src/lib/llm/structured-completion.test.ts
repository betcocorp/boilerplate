import { beforeEach, describe, expect, it, vi } from 'vitest';

const anthropicStream = vi.fn();
const openaiCreate = vi.fn();

vi.mock('~/lib/anthropic/client', () => ({
  getAnthropicClient: () => ({ messages: { stream: anthropicStream } }),
}));
vi.mock('~/lib/openai/client', () => ({
  getOpenAIClient: () => ({ responses: { create: openaiCreate } }),
}));
vi.mock('~/lib/observability/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { logError, logInfo, logWarn } from '~/lib/observability/logger';

import {
  ANTHROPIC_THINKING_HEADROOM_TOKENS,
  completeStructured,
  completeStructuredWithUsage,
  completeText,
  completeTextWithUsage,
  StructuredOutputRefusedError,
  StructuredOutputTruncatedError,
  supportsAnthropicAdaptiveThinking,
  type StructuredCompletionRequest,
} from './structured-completion';

/**
 * B0-819 — the provider seam. What matters is that both providers are asked the same question with
 * the same schema bytes, that each is asked in the shape its API accepts (verified live 2026-09-03),
 * and that "cut off" and "refused" come back as their own errors rather than as a JSON parse failure
 * or a silent switch to another model.
 */

/** Mirrors the grader's shape: nullable `type` arrays, descriptions, strict object. */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    note: { type: ['string', 'null'], description: 'null when nothing to say' },
  },
  required: ['ok', 'note'],
};

const REQUEST: StructuredCompletionRequest = {
  model: 'claude-opus-5',
  system: 'You grade.',
  user: '{"question":"q"}',
  schemaName: 'case_score',
  schema: SCHEMA,
  maxOutputTokens: 16_000,
  temperature: 0,
  effort: 'high',
};

function anthropicMessage(partial: Record<string, unknown> = {}) {
  return {
    stop_reason: 'end_turn',
    stop_details: null,
    content: [{ type: 'text', text: '{"ok":true,"note":null}' }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
    ...partial,
  };
}

function openaiResponse(partial: Record<string, unknown> = {}) {
  return {
    incomplete_details: null,
    output_text: '{"ok":true,"note":null}',
    output: [],
    usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
    ...partial,
  };
}

beforeEach(() => {
  anthropicStream.mockReset();
  openaiCreate.mockReset();
  vi.mocked(logError).mockClear();
  vi.mocked(logWarn).mockClear();
  vi.mocked(logInfo).mockClear();
});

describe('completeStructured — Anthropic', () => {
  it('routes claude-* to the Messages API with adaptive thinking, effort and the schema verbatim, and never sends sampling controls', async () => {
    anthropicStream.mockReturnValue({ finalMessage: async () => anthropicMessage() });

    const text = await completeStructured(REQUEST);

    expect(text).toBe('{"ok":true,"note":null}');
    expect(openaiCreate).not.toHaveBeenCalled();
    const params = anthropicStream.mock.calls[0]![0];
    expect(params.model).toBe('claude-opus-5');
    expect(params.system).toBe('You grade.');
    expect(params.messages).toEqual([{ role: 'user', content: '{"question":"q"}' }]);
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.output_config).toEqual({
      effort: 'high',
      format: { type: 'json_schema', schema: SCHEMA },
    });
    // The same object, not a re-shaped copy — both providers see identical schema bytes.
    expect(params.output_config.format.schema).toBe(SCHEMA);
    expect('temperature' in params).toBe(false);
    expect('top_p' in params).toBe(false);
    expect('budget_tokens' in params.thinking).toBe(false);
  });

  it('adds thinking headroom on top of the caller cap, so a high-effort think cannot starve the answer', async () => {
    anthropicStream.mockReturnValue({ finalMessage: async () => anthropicMessage() });
    await completeStructured(REQUEST);
    expect(anthropicStream.mock.calls[0]![0].max_tokens).toBe(
      16_000 + ANTHROPIC_THINKING_HEADROOM_TOKENS,
    );
  });

  it('omits effort from output_config when the caller gives none', async () => {
    anthropicStream.mockReturnValue({ finalMessage: async () => anthropicMessage() });
    await completeStructured({ ...REQUEST, effort: undefined });
    expect(anthropicStream.mock.calls[0]![0].output_config).toEqual({
      format: { type: 'json_schema', schema: SCHEMA },
    });
  });

  it('returns the concatenated text blocks and skips thinking blocks', async () => {
    anthropicStream.mockReturnValue({
      finalMessage: async () =>
        anthropicMessage({
          content: [
            { type: 'thinking', thinking: '', signature: 'sig' },
            { type: 'text', text: '{"ok":' },
            { type: 'text', text: 'true,"note":null}' },
          ],
        }),
    });
    expect(await completeStructured(REQUEST)).toBe('{"ok":true,"note":null}');
  });

  it('surfaces a max_tokens stop as the truncation error, in the wording callers already match on', async () => {
    anthropicStream.mockReturnValue({
      finalMessage: async () => anthropicMessage({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ok":' }] }),
    });
    const attempt = completeStructured(REQUEST);
    await expect(attempt).rejects.toBeInstanceOf(StructuredOutputTruncatedError);
    await expect(attempt).rejects.toThrow(/max_output_tokens/);
  });

  it('surfaces a refusal with its category instead of quietly grading on another model', async () => {
    anthropicStream.mockReturnValue({
      finalMessage: async () =>
        anthropicMessage({
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' },
          content: [],
        }),
    });
    const attempt = completeStructured(REQUEST);
    await expect(attempt).rejects.toBeInstanceOf(StructuredOutputRefusedError);
    await expect(attempt).rejects.toThrow(/refused.*\(cyber\).*declined/);
    expect(openaiCreate).not.toHaveBeenCalled();
  });
});

describe('completeStructured — OpenAI', () => {
  it('routes every non-claude id to the Responses API with strict json_schema and the same schema bytes', async () => {
    openaiCreate.mockResolvedValue(openaiResponse());

    const text = await completeStructured({ ...REQUEST, model: 'gpt-4.1' });

    expect(text).toBe('{"ok":true,"note":null}');
    expect(anthropicStream).not.toHaveBeenCalled();
    const params = openaiCreate.mock.calls[0]![0];
    expect(params.model).toBe('gpt-4.1');
    expect(params.instructions).toBe('You grade.');
    expect(params.input).toEqual([{ role: 'user', content: '{"question":"q"}', type: 'message' }]);
    expect(params.text).toEqual({
      format: { type: 'json_schema', name: 'case_score', strict: true, schema: SCHEMA },
    });
    expect(params.text.format.schema).toBe(SCHEMA);
    expect(params.max_output_tokens).toBe(16_000);
    expect(params.temperature).toBe(0);
    expect(params.store).toBe(false);
    expect('output_config' in params).toBe(false);
    expect('thinking' in params).toBe(false);
  });

  it('drops temperature for models that reject sampling controls (B0-606)', async () => {
    openaiCreate.mockResolvedValue(openaiResponse());
    await completeStructured({ ...REQUEST, model: 'gpt-5.6' });
    expect('temperature' in openaiCreate.mock.calls[0]![0]).toBe(false);
  });

  it('surfaces an incomplete response at max_output_tokens as the truncation error', async () => {
    openaiCreate.mockResolvedValue(
      openaiResponse({ incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"ok":' }),
    );
    await expect(completeStructured({ ...REQUEST, model: 'gpt-4.1' })).rejects.toBeInstanceOf(
      StructuredOutputTruncatedError,
    );
  });
});

describe('B0-908 — usage, request options, text mode and Haiku gating', () => {
  it('returns the call usage in the runtime LlmTokenUsage shape for both providers', async () => {
    anthropicStream.mockReturnValue({
      finalMessage: async () =>
        anthropicMessage({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 } }),
    });
    expect((await completeStructuredWithUsage(REQUEST)).usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedPromptTokens: 40,
    });

    openaiCreate.mockResolvedValue(
      openaiResponse({ usage: { input_tokens: 7, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } } }),
    );
    expect((await completeStructuredWithUsage({ ...REQUEST, model: 'gpt-4.1' })).usage).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
      cachedPromptTokens: 2,
    });
  });

  it('forwards timeout/maxRetries to the SDK as the second argument, and sends nothing when absent', async () => {
    openaiCreate.mockResolvedValue(openaiResponse());
    await completeStructured({ ...REQUEST, model: 'gpt-4.1', requestOptions: { maxRetries: 0, timeoutMs: 1234 } });
    expect(openaiCreate.mock.calls[0]![1]).toEqual({ maxRetries: 0, timeout: 1234 });

    anthropicStream.mockReturnValue({ finalMessage: async () => anthropicMessage() });
    await completeStructured({ ...REQUEST, requestOptions: { timeoutMs: 999 } });
    expect(anthropicStream.mock.calls[0]![1]).toEqual({ timeout: 999 });

    openaiCreate.mockReset();
    openaiCreate.mockResolvedValue(openaiResponse());
    await completeStructured({ ...REQUEST, model: 'gpt-4.1' });
    expect(openaiCreate.mock.calls[0]![1]).toBeUndefined();
  });

  it('text mode sends no schema/format and returns a cut-off answer instead of throwing', async () => {
    const textRequest = { model: 'gpt-4.1', system: 'Revise.', user: 'draft', maxOutputTokens: 500, temperature: 0.2 };
    openaiCreate.mockResolvedValue(
      openaiResponse({ output_text: 'partial', incomplete_details: { reason: 'max_output_tokens' } }),
    );
    expect(await completeText(textRequest)).toBe('partial');
    expect('text' in openaiCreate.mock.calls[0]![0]).toBe(false);

    anthropicStream.mockReturnValue({
      finalMessage: async () =>
        anthropicMessage({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'cut' }] }),
    });
    const result = await completeTextWithUsage({ ...textRequest, model: 'claude-sonnet-5', effort: 'low' });
    expect(result.text).toBe('cut');
    const params = anthropicStream.mock.calls[0]![0];
    expect(params.output_config).toEqual({ effort: 'low' });
    expect(params.thinking).toEqual({ type: 'adaptive' });
  });

  it('text mode still surfaces an Anthropic refusal', async () => {
    anthropicStream.mockReturnValue({
      finalMessage: async () =>
        anthropicMessage({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null }, content: [] }),
    });
    await expect(
      completeText({ model: 'claude-opus-5', system: 's', user: 'u', maxOutputTokens: 10 }),
    ).rejects.toBeInstanceOf(StructuredOutputRefusedError);
  });

  it('omits adaptive thinking, effort and the thinking headroom for Haiku-class ids', async () => {
    expect(supportsAnthropicAdaptiveThinking('claude-haiku-4-5')).toBe(false);
    expect(supportsAnthropicAdaptiveThinking('claude-sonnet-4-6')).toBe(true);
    expect(supportsAnthropicAdaptiveThinking('claude-opus-4-8')).toBe(true);
    expect(supportsAnthropicAdaptiveThinking('claude-sonnet-4-5')).toBe(false);

    anthropicStream.mockReturnValue({ finalMessage: async () => anthropicMessage() });
    await completeStructured({ ...REQUEST, model: 'claude-haiku-4-5' });
    const params = anthropicStream.mock.calls[0]![0];
    expect('thinking' in params).toBe(false);
    expect(params.output_config).toEqual({ format: { type: 'json_schema', schema: SCHEMA } });
    expect(params.max_tokens).toBe(16_000);
    expect('temperature' in params).toBe(false);
  });
});

/**
 * B0-922 — before this, the seam logged only successes, so B0-910's 400 on every one of 106 items
 * left no log line anywhere and the run still reported a letter grade. Every failure is now recorded
 * exactly once, here, whatever the caller then does with the error.
 */
describe('B0-922 — provider failures are logged centrally', () => {
  it('logs one error line carrying provider, model, schema and the error, then re-throws untouched', async () => {
    const badRequest = new Error(
      "output_config.format.schema: Invalid schema: Enum value 'betco' does not match declared type '['string', 'null']'",
    );
    anthropicStream.mockReturnValue({
      finalMessage: async () => {
        throw badRequest;
      },
    });

    await expect(completeStructured(REQUEST)).rejects.toBe(badRequest);

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith('llm_structured_completion_failed', {
      provider: 'anthropic',
      model: 'claude-opus-5',
      schema: 'case_score',
      effort: 'high',
      errorName: 'Error',
      error: badRequest.message,
    });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('logs an OpenAI failure with provider openai and a null effort', async () => {
    const boom = new Error('429 rate_limit_exceeded');
    openaiCreate.mockRejectedValue(boom);

    await expect(completeStructured({ ...REQUEST, model: 'gpt-4.1' })).rejects.toBe(boom);

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      'llm_structured_completion_failed',
      expect.objectContaining({ provider: 'openai', model: 'gpt-4.1', schema: 'case_score', effort: null }),
    );
  });

  it('logs a truncation, which callers turn into a retry or an Unable to Evaluate case', async () => {
    anthropicStream.mockReturnValue({
      finalMessage: async () => anthropicMessage({ stop_reason: 'max_tokens', content: [] }),
    });

    await expect(completeStructured(REQUEST)).rejects.toBeInstanceOf(StructuredOutputTruncatedError);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      'llm_structured_completion_failed',
      expect.objectContaining({ errorName: 'StructuredOutputTruncatedError' }),
    );
  });

  // A refusal is a surfaced, documented outcome with no fallback model, not a broken call — warn so
  // it is countable without reading as an incident.
  it('logs a refusal at warn, with its category, and never as an error', async () => {
    anthropicStream.mockReturnValue({
      finalMessage: async () =>
        anthropicMessage({
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' },
          content: [],
        }),
    });

    await expect(completeStructured(REQUEST)).rejects.toBeInstanceOf(StructuredOutputRefusedError);

    expect(logError).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      'llm_structured_completion_refused',
      expect.objectContaining({
        provider: 'anthropic',
        schema: 'case_score',
        errorName: 'StructuredOutputRefusedError',
        refusalCategory: 'cyber',
      }),
    );
  });

  it('logs a failure in text mode too, with a null schema', async () => {
    const boom = new Error('socket hang up');
    openaiCreate.mockRejectedValue(boom);

    await expect(
      completeText({ model: 'gpt-4.1', system: 's', user: 'u', maxOutputTokens: 100 }),
    ).rejects.toBe(boom);
    expect(logError).toHaveBeenCalledWith(
      'llm_structured_completion_failed',
      expect.objectContaining({ schema: null }),
    );
  });

  it('logs nothing but the usage line on success', async () => {
    anthropicStream.mockReturnValue({ finalMessage: async () => anthropicMessage() });
    await completeStructured(REQUEST);
    expect(logError).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledTimes(1);
  });
});

describe('B0-908 — prior messages and abort signal', () => {
  const prior = [
    { role: 'assistant' as const, content: 'earlier answer' },
    { role: 'user' as const, content: 'earlier question' },
    { role: 'assistant' as const, content: 'earlier answer 2' },
  ];

  it('sends prior turns as real input items ahead of the user turn on OpenAI, verbatim', async () => {
    openaiCreate.mockResolvedValue(openaiResponse());
    await completeStructured({ ...REQUEST, model: 'gpt-4.1', priorMessages: prior });
    expect(openaiCreate.mock.calls[0]![0].input).toEqual([
      { role: 'assistant', content: 'earlier answer', type: 'message' },
      { role: 'user', content: 'earlier question', type: 'message' },
      { role: 'assistant', content: 'earlier answer 2', type: 'message' },
      { role: 'user', content: '{"question":"q"}', type: 'message' },
    ]);
  });

  it('sends prior turns as messages on Anthropic, dropping a leading assistant turn the API would reject', async () => {
    anthropicStream.mockReturnValue({ finalMessage: async () => anthropicMessage() });
    await completeStructured({ ...REQUEST, priorMessages: prior });
    expect(anthropicStream.mock.calls[0]![0].messages).toEqual([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer 2' },
      { role: 'user', content: '{"question":"q"}' },
    ]);
  });

  it('forwards an AbortSignal to both SDKs', async () => {
    const controller = new AbortController();
    openaiCreate.mockResolvedValue(openaiResponse());
    await completeStructured({ ...REQUEST, model: 'gpt-4.1', requestOptions: { signal: controller.signal } });
    expect(openaiCreate.mock.calls[0]![1]).toEqual({ signal: controller.signal });

    anthropicStream.mockReturnValue({ finalMessage: async () => anthropicMessage() });
    await completeStructured({ ...REQUEST, requestOptions: { signal: controller.signal, maxRetries: 0 } });
    expect(anthropicStream.mock.calls[0]![1]).toEqual({ signal: controller.signal, maxRetries: 0 });
  });
});
