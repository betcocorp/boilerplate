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

import {
  ANTHROPIC_THINKING_HEADROOM_TOKENS,
  completeStructured,
  StructuredOutputRefusedError,
  StructuredOutputTruncatedError,
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
