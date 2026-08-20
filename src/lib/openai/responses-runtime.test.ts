import type OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runResponsesWithToolLoop,
  TOOL_ROUNDS_EXHAUSTED_FALLBACK_TEXT,
  TOOL_ROUNDS_EXHAUSTED_TOOL_OUTPUT,
} from '~/lib/openai/responses-runtime';
import {
  isUpstreamTransportError,
  UPSTREAM_RETRY_USER_MESSAGE,
} from '~/lib/openai/transport-retry';
import type { ToolTraceEntry } from '~/lib/audit/trace';
import { __resetLearnedSamplingSupport } from '~/lib/openai/model-capabilities';

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

describe('runResponsesWithToolLoop — preloaded evidence (B0-436)', () => {
  const evidence = {
    label: 'search_product_docs({"freeformQuery":"dilution for Green Earth?"})',
    text: '{"ok":true,"sources":[{"documentId":"doc-1"}]}',
  };

  it('appends the evidence as its own message item after the user message, round 1 only', async () => {
    const { client, create } = stubClient([
      {
        id: 'resp_1',
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_efficacy_data',
            arguments: '{"productId":"Green Earth"}',
          },
        ],
      },
      { id: 'resp_2', output: [], output_text: '2 oz per gallon.' },
    ]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'dilution for Green Earth?',
      promptCacheKey: 'bex-product-support:orchestrator:product',
      preloadedEvidence: evidence,
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const calls = create.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const round1 = calls[0]?.[0].input as Array<Record<string, unknown>>;

    expect(round1).toHaveLength(2);
    expect(round1[0]).toMatchObject({ role: 'user', content: 'dilution for Green Earth?' });
    // A normal message item — NOT a `function_call_output`, which would be invalid with no
    // matching `function_call` in the chain.
    expect(round1[1]?.type).toBe('message');
    expect(String(round1[1]?.content)).toContain('## Retrieved evidence (pre-fetched)');
    expect(String(round1[1]?.content)).toContain(evidence.text);
    // Round 2 carries tool outputs only; re-injecting the evidence would duplicate it in the chain.
    const round2 = calls[1]?.[0].input as Array<Record<string, unknown>>;
    expect(round2.every((item) => item.type === 'function_call_output')).toBe(true);
  });

  it('keeps the evidence out of the cacheable prefix (instructions + prompt_cache_key)', async () => {
    const { client, create } = stubClient([{ id: 'resp_1', output: [], output_text: 'hi' }]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'dilution for Green Earth?',
      promptCacheKey: 'bex-product-support:orchestrator:product',
      preloadedEvidence: evidence,
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const params = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(params?.instructions).toBe('stable prefix');
    expect(params?.prompt_cache_key).toBe('bex-product-support:orchestrator:product');
  });

  it('sends the user message alone when no evidence was preloaded', async () => {
    const { client, create } = stubClient([{ id: 'resp_1', output: [], output_text: 'hi' }]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'hello',
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const input = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]
      .input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
  });
});

describe('runResponsesWithToolLoop — capped history replay (B0-519)', () => {
  it('injects history as explicit messages, before the user message, when no previousResponseId is given', async () => {
    const { client, create } = stubClient([{ id: 'resp_1', output: [], output_text: 'hi' }]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'and the bathroom cleaner?',
      history: [
        { role: 'user', content: 'What is your best floor cleaner?' },
        { role: 'assistant', content: 'Try Green Earth Neutral Cleaner.' },
      ],
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const round1 = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]
      .input as Array<Record<string, unknown>>;

    expect(round1).toHaveLength(3);
    expect(round1[0]).toMatchObject({
      role: 'user',
      content: 'What is your best floor cleaner?',
    });
    expect(round1[1]).toMatchObject({
      role: 'assistant',
      content: 'Try Green Earth Neutral Cleaner.',
    });
    expect(round1[2]).toMatchObject({ role: 'user', content: 'and the bathroom cleaner?' });
  });

  it('ignores history when a previousResponseId is given, to avoid duplicating the server-side chain', async () => {
    const { client, create } = stubClient([{ id: 'resp_1', output: [], output_text: 'hi' }]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'and the bathroom cleaner?',
      previousResponseId: 'resp_prev',
      history: [{ role: 'user', content: 'What is your best floor cleaner?' }],
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const round1 = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]
      .input as Array<Record<string, unknown>>;

    expect(round1).toHaveLength(1);
    expect(round1[0]).toMatchObject({ role: 'user', content: 'and the bathroom cleaner?' });
  });

  it('drops blank history messages, matching the AI SDK runtime', async () => {
    const { client, create } = stubClient([{ id: 'resp_1', output: [], output_text: 'hi' }]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'hello',
      history: [{ role: 'user', content: '   ' }],
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const round1 = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]
      .input as Array<Record<string, unknown>>;
    expect(round1).toHaveLength(1);
  });
});

describe('runResponsesWithToolLoop — suggestedFirstTool round-0 tool_choice bias (B0-512)', () => {
  const searchTool = {
    type: 'function' as const,
    name: 'search_product_docs',
    parameters: {},
    strict: null,
  };
  const otherTool = {
    type: 'function' as const,
    name: 'get_efficacy_data',
    parameters: {},
    strict: null,
  };

  it('pins round 0 to the suggested tool when toolChoice is the generic "required"', async () => {
    const { client, create } = stubClient([{ id: 'resp_1', output: [], output_text: 'hi' }]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [searchTool, otherTool],
      userMessage: 'hello',
      toolChoice: 'required',
      suggestedFirstTool: { name: 'search_product_docs', confidence: 0.9 },
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const params = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(params?.tool_choice).toEqual({ type: 'function', name: 'search_product_docs' });
  });

  it('leaves a named-function toolChoice (forced cross-reference/recommendations) untouched', async () => {
    const { client, create } = stubClient([{ id: 'resp_1', output: [], output_text: 'hi' }]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [searchTool, otherTool],
      userMessage: 'hello',
      toolChoice: { type: 'function', name: 'lookup_cross_reference' },
      suggestedFirstTool: { name: 'search_product_docs', confidence: 0.99 },
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const params = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(params?.tool_choice).toEqual({ type: 'function', name: 'lookup_cross_reference' });
  });

  it('leaves an explicit "auto" toolChoice (preloaded-evidence turns) untouched', async () => {
    const { client, create } = stubClient([{ id: 'resp_1', output: [], output_text: 'hi' }]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [searchTool, otherTool],
      userMessage: 'hello',
      toolChoice: 'auto',
      suggestedFirstTool: { name: 'search_product_docs', confidence: 0.99 },
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const params = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(params?.tool_choice).toBe('auto');
  });

  it('ignores a suggestion below the confidence floor, keeping the generic "required"', async () => {
    const { client, create } = stubClient([{ id: 'resp_1', output: [], output_text: 'hi' }]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [searchTool, otherTool],
      userMessage: 'hello',
      toolChoice: 'required',
      suggestedFirstTool: { name: 'search_product_docs', confidence: 0.2 },
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const params = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(params?.tool_choice).toBe('required');
  });

  it('ignores a suggestion naming a tool not offered this round', async () => {
    const { client, create } = stubClient([{ id: 'resp_1', output: [], output_text: 'hi' }]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [searchTool],
      userMessage: 'hello',
      toolChoice: 'required',
      suggestedFirstTool: { name: 'get_efficacy_data', confidence: 0.9 },
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const params = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(params?.tool_choice).toBe('required');
  });

  it('only biases round 0 — round 2+ still sends "auto" regardless of the suggestion', async () => {
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
      tools: [searchTool, otherTool],
      userMessage: 'hello',
      toolChoice: 'required',
      suggestedFirstTool: { name: 'search_product_docs', confidence: 0.9 },
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const calls = create.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls[0]?.[0].tool_choice).toEqual({ type: 'function', name: 'search_product_docs' });
    expect(calls[1]?.[0].tool_choice).toBe('auto');
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

describe('runResponsesWithToolLoop — model vs persisted tool output (B0-437)', () => {
  it('sends `modelOutput` to the model when the tool provides one', async () => {
    const { client, create } = stubClient([
      {
        id: 'resp_1',
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'search_product_docs',
            arguments: '{"freeformQuery":"pH7Q first aid"}',
          },
        ],
      },
      { id: 'resp_2', output: [], output_text: 'Rinse cautiously with water.' },
    ]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'pH7Q first aid',
      executeTool: async ({ name }) => ({
        output: '{"sources":[{"snippet":"...","documentBody":"FULL BODY"}]}',
        modelOutput: '{"sources":[{"documentBody":"SLIM"}]}',
        trace: trace(name),
      }),
    });

    const round2 = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[1]?.[0]
      .input as Array<Record<string, unknown>>;
    expect(round2[0]?.output).toBe('{"sources":[{"documentBody":"SLIM"}]}');
  });

  it('falls back to `output` when the tool provides no model variant', async () => {
    const { client, create } = stubClient([
      {
        id: 'resp_1',
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_escalation_policy',
            arguments: '{"issueType":"safety"}',
          },
        ],
      },
      { id: 'resp_2', output: [], output_text: 'Escalate to EHS.' },
    ]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'who do I escalate to?',
      executeTool: async ({ name }) => ({ output: '{"policy":"x"}', trace: trace(name) }),
    });

    const round2 = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[1]?.[0]
      .input as Array<Record<string, unknown>>;
    expect(round2[0]?.output).toBe('{"policy":"x"}');
  });
});

describe('runResponsesWithToolLoop — tool-round exhaustion (B0-381)', () => {
  /** Distinct call ids so ordering assertions can tell the entries apart. */
  const traceFor = (name: string, callId: string): ToolTraceEntry => ({
    ...trace(name),
    toolName: name,
    callId,
  });

  /** A model that never stops asking for tools — the pathological case the guard exists for. */
  const alwaysCallsTools = (callId: string) => ({
    type: 'function_call',
    call_id: callId,
    name: 'search_product_docs',
    arguments: '{"topic":"dilution"}',
  });

  it('returns a non-empty answer when the model still requests tools on the final round', async () => {
    const { client, create } = stubClient([
      { id: 'resp_1', output: [alwaysCallsTools('call_1')] },
      { id: 'resp_2', output: [alwaysCallsTools('call_2'), alwaysCallsTools('call_3')] },
      { id: 'resp_3', output: [], output_text: 'Answering from the evidence gathered so far.' },
    ]);

    const executeTool = vi.fn(async ({ name, callId }: { name: string; callId: string }) => ({
      output: '{"ok":true}',
      trace: traceFor(name, callId),
    }));

    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'What dilution ratio does Norinse Floor Cleaner use?',
      maxToolRounds: 2,
      executeTool,
    });

    // The acceptance criterion: exhaustion never yields an empty answer.
    expect(result.assistantText).toBe('Answering from the evidence gathered so far.');

    // No tool round may run whose outputs are never returned to the model: round 1's single call
    // executed, the final round's two calls did not.
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.toolTrace).toHaveLength(1);
    expect(result.toolTrace[0]?.callId).toBe('call_1');

    // The forced answering request: tools off, and every pending call answered so the
    // `previous_response_id` chain has no dangling `function_call`.
    const forced = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[2]?.[0];
    expect(forced?.tool_choice).toBe('none');
    expect(forced?.previous_response_id).toBe('resp_2');

    const input = forced?.input as Array<Record<string, unknown>>;
    expect(input.slice(0, 2)).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_2',
        output: TOOL_ROUNDS_EXHAUSTED_TOOL_OUTPUT,
      },
      {
        type: 'function_call_output',
        call_id: 'call_3',
        output: TOOL_ROUNDS_EXHAUSTED_TOOL_OUTPUT,
      },
    ]);
    // Followed by the instruction telling the model to answer now.
    expect(input[2]?.role).toBe('user');
    expect(result.responseIds).toEqual(['resp_1', 'resp_2', 'resp_3']);
  });

  it('falls back to the canned answer when even the forced request returns no text', async () => {
    const { client } = stubClient([
      { id: 'resp_1', output: [alwaysCallsTools('call_1')] },
      // No `output_text` and no message item — the forced request produced nothing.
      { id: 'resp_2', output: [] },
    ]);

    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'what dilution?',
      maxToolRounds: 1,
      executeTool: async ({ name, callId }) => ({
        output: '{"ok":true}',
        trace: traceFor(name, callId),
      }),
    });

    expect(result.assistantText).toBe(TOOL_ROUNDS_EXHAUSTED_FALLBACK_TEXT);
    expect(result.assistantText.trim()).not.toBe('');
  });

  it('reports the exhaustion to the caller with the pending-call count', async () => {
    const { client } = stubClient([
      { id: 'resp_1', output: [alwaysCallsTools('call_1'), alwaysCallsTools('call_2')] },
      { id: 'resp_2', output: [], output_text: 'done' },
    ]);

    const onToolRoundsExhausted = vi.fn();

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'what dilution?',
      maxToolRounds: 1,
      executeTool: async ({ name, callId }) => ({
        output: '{"ok":true}',
        trace: traceFor(name, callId),
      }),
      onToolRoundsExhausted,
    });

    expect(onToolRoundsExhausted).toHaveBeenCalledTimes(1);
    expect(onToolRoundsExhausted).toHaveBeenCalledWith({
      maxToolRounds: 1,
      pendingCallCount: 2,
    });
  });

  it('does not engage the guard when the model answers within the round budget', async () => {
    const { client, create } = stubClient([
      { id: 'resp_1', output: [alwaysCallsTools('call_1')] },
      { id: 'resp_2', output: [], output_text: '2 oz per gallon.' },
    ]);

    const onToolRoundsExhausted = vi.fn();

    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'what dilution?',
      maxToolRounds: 4,
      executeTool: async ({ name, callId }) => ({
        output: '{"ok":true}',
        trace: traceFor(name, callId),
      }),
      onToolRoundsExhausted,
    });

    expect(result.assistantText).toBe('2 oz per gallon.');
    expect(onToolRoundsExhausted).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('runResponsesWithToolLoop — concurrent tool execution (B0-379)', () => {
  const traceFor = (name: string, callId: string): ToolTraceEntry => ({
    ...trace(name),
    toolName: name,
    callId,
  });

  const callItem = (callId: string, name: string) => ({
    type: 'function_call',
    call_id: callId,
    name,
    arguments: '{}',
  });

  it('runs a multi-call round concurrently and keeps output order in model call order', async () => {
    const { client, create } = stubClient([
      {
        id: 'resp_1',
        output: [
          callItem('call_a', 'search_product_docs'),
          callItem('call_b', 'get_efficacy_data'),
          callItem('call_c', 'lookup_category'),
        ],
      },
      { id: 'resp_2', output: [], output_text: 'combined answer' },
    ]);

    /** Each call parks here until released, so all three must be in flight simultaneously. */
    const release: Array<() => void> = [];
    const executeTool = vi.fn(
      async ({ name, callId }: { name: string; callId: string }) => {
        await new Promise<void>((resolve) => {
          release.push(resolve);
        });
        return { output: JSON.stringify({ ok: true, callId }), trace: traceFor(name, callId) };
      },
    );

    const pending = runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'compare these products',
      executeTool,
    });

    // Concurrency itself: all three calls entered before any of them was allowed to finish.
    // Serial execution could never park more than one.
    await vi.waitFor(() => expect(release).toHaveLength(3));
    expect(executeTool).toHaveBeenCalledTimes(3);

    // Settle in reverse order to prove ordering does not depend on completion order.
    for (const resolve of [...release].reverse()) {
      resolve();
    }

    const result = await pending;

    expect(result.toolTrace.map((entry) => entry.callId)).toEqual([
      'call_a',
      'call_b',
      'call_c',
    ]);

    const round2 = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[1]?.[0]
      .input as Array<Record<string, unknown>>;
    expect(round2.map((item) => item.call_id)).toEqual(['call_a', 'call_b', 'call_c']);
    expect(round2.map((item) => item.output)).toEqual([
      '{"ok":true,"callId":"call_a"}',
      '{"ok":true,"callId":"call_b"}',
      '{"ok":true,"callId":"call_c"}',
    ]);
    expect(result.assistantText).toBe('combined answer');
  });

  it('isolates a rejecting call so its siblings still return their own outputs', async () => {
    const { client, create } = stubClient([
      {
        id: 'resp_1',
        output: [
          callItem('call_a', 'search_product_docs'),
          callItem('call_b', 'get_efficacy_data'),
          callItem('call_c', 'lookup_category'),
        ],
      },
      { id: 'resp_2', output: [], output_text: 'answered around the failure' },
    ]);

    const executeTool = vi.fn(async ({ name, callId }: { name: string; callId: string }) => {
      if (callId === 'call_b') {
        throw new Error('supabase rpc exploded');
      }
      return { output: JSON.stringify({ ok: true, callId }), trace: traceFor(name, callId) };
    });

    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'compare these products',
      executeTool,
    });

    // All three siblings ran and produced their own trace entry, in model call order.
    expect(result.toolTrace.map((entry) => entry.callId)).toEqual([
      'call_a',
      'call_b',
      'call_c',
    ]);
    expect(result.toolTrace.map((entry) => entry.ok)).toEqual([true, false, true]);

    const round2 = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[1]?.[0]
      .input as Array<Record<string, unknown>>;
    // The failure is reported to the model as that one call's own structured output.
    expect(round2[1]?.output).toBe('{"ok":false,"error":"supabase rpc exploded"}');
    expect(round2[0]?.output).toBe('{"ok":true,"callId":"call_a"}');
    expect(round2[2]?.output).toBe('{"ok":true,"callId":"call_c"}');
    expect(result.assistantText).toBe('answered around the failure');
  });

  it('leaves single-call rounds behaving exactly as before', async () => {
    const { client, create } = stubClient([
      { id: 'resp_1', output: [callItem('call_a', 'search_product_docs')] },
      { id: 'resp_2', output: [], output_text: 'single answer' },
    ]);

    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'what dilution?',
      executeTool: async ({ name, callId }) => ({
        output: '{"ok":true}',
        trace: traceFor(name, callId),
      }),
    });

    expect(result.toolTrace).toHaveLength(1);
    expect(result.assistantText).toBe('single answer');
    const round2 = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[1]?.[0]
      .input as Array<Record<string, unknown>>;
    expect(round2).toHaveLength(1);
    expect(round2[0]?.call_id).toBe('call_a');
  });
});

describe('runResponsesWithToolLoop — temperature gating (B0-606)', () => {
  beforeEach(() => {
    __resetLearnedSamplingSupport();
  });

  const answer = (id: string) => ({ id, output: [], output_text: 'ok' });

  it('omits temperature for gpt-5.6, which rejects it outright', async () => {
    const { client, create } = stubClient([answer('resp_1')]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-5.6',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'what dilution?',
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const params = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    // Absent, not undefined — the API rejects the parameter on presence, not on value.
    expect('temperature' in (params ?? {})).toBe(false);
  });

  it('still sends temperature for gpt-4.1', async () => {
    const { client, create } = stubClient([answer('resp_1')]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'what dilution?',
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const params = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(params?.temperature).toBe(0.2);
  });

  it('replays once without temperature when an unknown model rejects it', async () => {
    const rejection = Object.assign(
      new Error("400 Unsupported parameter: 'temperature' is not supported with this model."),
      { status: 400 },
    );
    const { client, create } = scriptedClient([
      { throws: rejection },
      { id: 'resp_1', output: [], output_text: 'recovered' },
    ]);

    const result = await runResponsesWithToolLoop({
      client,
      model: 'mystery-future-model',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'what dilution?',
      retry: testRetry,
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    // The turn survives instead of failing the whole run.
    expect(result.assistantText).toBe('recovered');
    expect(create).toHaveBeenCalledTimes(2);

    const calls = create.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls[0]?.[0]?.temperature).toBe(0.2);
    expect('temperature' in (calls[1]?.[0] ?? {})).toBe(false);
  });

  it('does not replay for an unrelated 400 — that must surface, not be swallowed', async () => {
    const badRequest = Object.assign(new Error('Invalid schema for function'), { status: 400 });
    const { client, create } = scriptedClient([{ throws: badRequest }]);

    await expect(
      runResponsesWithToolLoop({
        client,
        model: 'mystery-future-model',
        instructions: 'stable prefix',
        tools: [],
        userMessage: 'what dilution?',
        retry: testRetry,
        executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
      }),
    ).rejects.toThrow(/Invalid schema for function/);

    expect(create).toHaveBeenCalledTimes(1);
  });
});
