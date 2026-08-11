import type OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import { describe, expect, it, vi } from 'vitest';

import { runResponsesWithToolLoop } from '~/lib/openai/responses-runtime';
import {
  isUpstreamTransportError,
  UPSTREAM_RETRY_USER_MESSAGE,
} from '~/lib/openai/transport-retry';
import type { ToolTraceEntry } from '~/lib/audit/trace';

type StubResponse = {
  id: string;
  output: Array<Record<string, unknown>>;
  output_text?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { cached_tokens: number };
  };
};

function stubClient(responses: StubResponse[]) {
  const create = vi.fn(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error('stub client ran out of responses');
    }
    return next as unknown as Response;
  });

  return {
    client: { responses: { create } } as unknown as OpenAI,
    create,
  };
}

/**
 * B0-370 — scripted client: each entry is either a response to return or an error to throw, so a
 * test can place a transport fault at an exact point in the tool loop.
 */
type ScriptStep = StubResponse | { throws: unknown };

function scriptedClient(script: ScriptStep[]) {
  const create = vi.fn(async (params: unknown, options?: unknown) => {
    void params;
    void options;
    const next = script.shift();
    if (!next) {
      throw new Error('scripted client ran out of steps');
    }
    if ('throws' in next) {
      throw next.throws;
    }
    return next as unknown as Response;
  });

  return { client: { responses: { create } } as unknown as OpenAI, create };
}

/** Mirrors undici: `TypeError: fetch failed` wrapping the socket error — the top production fault. */
function fetchFailed(): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }),
  });
}

/** No real timers, no jitter randomness — the retry policy itself is unit-tested separately. */
const testRetry = { sleep: async () => undefined, random: () => 0.5 };

const trace = (name: string): ToolTraceEntry => ({
  toolName: name,
  callId: 'call_1',
  argumentsPreview: '',
  outputPreview: '',
  ok: true,
  durationMs: 0,
});

describe('runResponsesWithToolLoop — prompt caching telemetry (B0-324)', () => {
  it('accumulates cached prompt tokens and reports usage per model call', async () => {
    const { client } = stubClient([
      {
        id: 'resp_1',
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'search_product_docs',
            arguments: '{"topic":"dilution"}',
          },
        ],
        usage: {
          input_tokens: 3200,
          output_tokens: 20,
          total_tokens: 3220,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
      {
        id: 'resp_2',
        output: [],
        output_text: 'Dilute 2 oz per gallon.',
        usage: {
          input_tokens: 3400,
          output_tokens: 40,
          total_tokens: 3440,
          input_tokens_details: { cached_tokens: 3072 },
        },
      },
    ]);

    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'dilution for Green Earth?',
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    expect(result.assistantText).toBe('Dilute 2 oz per gallon.');
    expect(result.usage).toEqual({
      promptTokens: 6600,
      completionTokens: 60,
      totalTokens: 6660,
      cachedPromptTokens: 3072,
    });
    // Per-call breakdown proves the 2nd model call in the loop reused the cached prefix.
    expect(result.usageByCall.map((call) => call.cachedPromptTokens)).toEqual([0, 3072]);
  });

  it('forwards promptCacheKey on every model call so the loop hits one cache pool', async () => {
    const { client, create } = stubClient([
      {
        id: 'resp_1',
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'search_product_docs',
            arguments: '{}',
          },
        ],
      },
      { id: 'resp_2', output: [], output_text: 'done' },
    ]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'hello',
      promptCacheKey: 'bex-product-support:orchestrator:product',
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    expect(create).toHaveBeenCalledTimes(2);
    for (const call of create.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(call[0].prompt_cache_key).toBe('bex-product-support:orchestrator:product');
      // The cached prefix is only reusable while instructions stay byte-identical per call.
      expect(call[0].instructions).toBe('stable prefix');
    }
  });

  it('omits prompt_cache_key when none is supplied', async () => {
    const { client, create } = stubClient([{ id: 'resp_1', output: [], output_text: 'hi' }]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'hello',
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const params = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(params && 'prompt_cache_key' in params).toBe(false);
  });
});

describe('runResponsesWithToolLoop — bounded transport retry (B0-370)', () => {
  it('retries a network fault and succeeds', async () => {
    const { client, create } = scriptedClient([
      { throws: fetchFailed() },
      { id: 'resp_1', output: [], output_text: 'Use 2 oz per gallon.' },
    ]);

    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'what cleaner is best for gym floors',
      retry: testRetry,
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.assistantText).toBe('Use 2 oz per gallon.');
    // The failed attempt must not leak into the accounting the workflow persists.
    expect(result.responseIds).toEqual(['resp_1']);
    expect(result.usageByCall).toHaveLength(1);
  });

  it('does not re-run a tool when the model call after it is retried', async () => {
    // Round 1 asks for a tool; the tool runs; the round-2 model call then hits a transport fault.
    // Replaying that request must not replay the tool.
    const { client, create } = scriptedClient([
      {
        id: 'resp_1',
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'search_product_docs',
            arguments: '{"topic":"dilution"}',
          },
        ],
      },
      { throws: fetchFailed() },
      { id: 'resp_2', output: [], output_text: 'Norinse Floor Cleaner: 2 oz per gallon.' },
    ]);

    const executeTool = vi.fn(async ({ name }: { name: string }) => ({
      output: '{"ok":true}',
      trace: trace(name),
    }));

    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'What dilution ratio does Norinse Floor Cleaner use?',
      retry: testRetry,
      executeTool,
    });

    // The acceptance criterion: exactly one tool invocation across the retry.
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.toolTrace).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(3);

    const calls = create.mock.calls as unknown as Array<[Record<string, unknown>, unknown]>;
    const failed = calls[1]?.[0];
    const replayed = calls[2]?.[0];
    // Same `previous_response_id` on the replay, so the stateful server-side chain stays
    // consistent and the provider does not re-run the round it already completed.
    expect(failed?.previous_response_id).toBe('resp_1');
    expect(replayed?.previous_response_id).toBe('resp_1');
    // Same tool output payload replayed byte-for-byte.
    expect(replayed?.input).toEqual(failed?.input);
    expect(result.assistantText).toBe('Norinse Floor Cleaner: 2 oz per gallon.');
  });

  it('does not retry a 4xx validation error', async () => {
    const badRequest = Object.assign(new Error('Invalid schema for function'), { status: 400 });
    const { client, create } = scriptedClient([{ throws: badRequest }]);

    // Propagates unchanged: a real defect must keep its own message, not the retry-able wording.
    await expect(
      runResponsesWithToolLoop({
        client,
        model: 'gpt-4.1',
        instructions: 'stable prefix',
        tools: [],
        userMessage: 'hello',
        retry: testRetry,
        executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
      }),
    ).rejects.toBe(badRequest);

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('fails cleanly with the user-facing message after exhausting retries', async () => {
    const { client, create } = scriptedClient([
      { throws: fetchFailed() },
      { throws: fetchFailed() },
      { throws: fetchFailed() },
    ]);

    const error = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'hello',
      retry: testRetry,
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    }).catch((err: unknown) => err);

    expect(create).toHaveBeenCalledTimes(3);
    expect(isUpstreamTransportError(error)).toBe(true);
    // The workflow's `catch` surfaces `err.message`, so this is what replaces
    // `{"error":"TypeError: fetch failed"}` in `final_output`.
    expect((error as Error).message).toBe(UPSTREAM_RETRY_USER_MESSAGE);
  });

  it('disables the OpenAI SDK per-request retries so the two policies cannot stack', async () => {
    const { client, create } = scriptedClient([{ id: 'resp_1', output: [], output_text: 'hi' }]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'hello',
      retry: testRetry,
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    // Client default is maxRetries: 2; without this override the bound would be 3 × 3 = 9.
    const options = (create.mock.calls as unknown as Array<[unknown, { maxRetries?: number }]>)[0]?.[1];
    expect(options?.maxRetries).toBe(0);
  });
});

describe('runResponsesWithToolLoop — streaming retry safety (B0-370)', () => {
  type StreamStep =
    | { deltas: string[]; response: StubResponse }
    | { deltas: string[]; throws: unknown };

  function streamingClient(script: StreamStep[]) {
    const stream = vi.fn((params: unknown, options?: unknown) => {
      void params;
      void options;
      const next = script.shift();
      if (!next) {
        throw new Error('streaming client ran out of steps');
      }
      return {
        async *[Symbol.asyncIterator]() {
          for (const delta of next.deltas) {
            yield { type: 'response.output_text.delta', delta } as const;
          }
          if ('throws' in next) {
            throw next.throws;
          }
        },
        finalResponse: async () =>
          ('response' in next ? next.response : undefined) as unknown as Response,
      };
    });

    return {
      client: { responses: { stream, create: vi.fn() } } as unknown as OpenAI,
      stream,
    };
  }

  it('retries a fault that happens before any token reaches the user', async () => {
    const { client, stream } = streamingClient([
      { deltas: [], throws: fetchFailed() },
      { deltas: ['Use ', '2 oz'], response: { id: 'resp_1', output: [] } },
    ]);

    const deltas: string[] = [];
    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'hello',
      retry: testRetry,
      onAssistantDelta: (delta) => deltas.push(delta),
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    expect(stream).toHaveBeenCalledTimes(2);
    // Nothing was emitted by the failed attempt, so the user sees each token exactly once.
    expect(deltas).toEqual(['Use ', '2 oz']);
    expect(result.finalResponseId).toBe('resp_1');
  });

  it('refuses to replay a stream that already emitted visible text', async () => {
    const { client, stream } = streamingClient([
      { deltas: ['Partial answer'], throws: fetchFailed() },
      { deltas: ['Partial answer again'], response: { id: 'resp_1', output: [] } },
    ]);

    const deltas: string[] = [];
    const error = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'hello',
      retry: testRetry,
      onAssistantDelta: (delta) => deltas.push(delta),
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    }).catch((err: unknown) => err);

    // Retrying here would duplicate text the user already saw; fail cleanly instead.
    expect(stream).toHaveBeenCalledTimes(1);
    expect(deltas).toEqual(['Partial answer']);
    expect(isUpstreamTransportError(error)).toBe(true);
    expect((error as Error).message).toBe(UPSTREAM_RETRY_USER_MESSAGE);
  });

  /**
   * B0-429 — a measurement-only observer (TTFT) must make the runtime stream without inheriting the
   * retry restriction that a caller-visible sink carries.
   */
  it('streams for a measurement-only observer even when no caller consumes deltas', async () => {
    const { client, stream } = streamingClient([
      { deltas: ['Use ', '2 oz'], response: { id: 'resp_1', output: [] } },
    ]);

    const observed: string[] = [];
    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'hello',
      retry: testRetry,
      observeAssistantDelta: (delta) => observed.push(delta),
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    expect(stream).toHaveBeenCalledTimes(1);
    expect(observed).toEqual(['Use ', '2 oz']);
    expect(result.finalResponseId).toBe('resp_1');
  });

  it('still retries after an observed-but-invisible token, since nobody saw it', async () => {
    const { client, stream } = streamingClient([
      { deltas: ['Partial answer'], throws: fetchFailed() },
      { deltas: ['Full answer'], response: { id: 'resp_1', output: [] } },
    ]);

    const observed: string[] = [];
    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'hello',
      retry: testRetry,
      observeAssistantDelta: (delta) => observed.push(delta),
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    // No caller-visible sink ⇒ the replay duplicates nothing, so resilience is unchanged for
    // non-streaming callers such as `/api/v1/orchestrator`.
    expect(stream).toHaveBeenCalledTimes(2);
    expect(observed).toEqual(['Partial answer', 'Full answer']);
    expect(result.finalResponseId).toBe('resp_1');
  });

  it('feeds both sinks when a caller consumes deltas and TTFT is being measured', async () => {
    const { client } = streamingClient([
      { deltas: ['Use ', '2 oz'], response: { id: 'resp_1', output: [] } },
    ]);

    const deltas: string[] = [];
    const observed: string[] = [];
    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'hello',
      retry: testRetry,
      onAssistantDelta: (delta) => deltas.push(delta),
      observeAssistantDelta: (delta) => observed.push(delta),
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    // Each token reaches the caller exactly once — the observer is not a second forwarding path.
    expect(deltas).toEqual(['Use ', '2 oz']);
    expect(observed).toEqual(['Use ', '2 oz']);
  });
});
