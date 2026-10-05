import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolTraceEntry } from '~/lib/audit/trace';
import type { Tool as OpenAiTool } from 'openai/resources/responses/responses';

// The runtime resolves its model via resolveAiSdkLanguageModel; swap in a mock model per test.
const modelRef = vi.hoisted(() => ({ current: null as MockLanguageModelV3 | null }));

vi.mock('~/lib/bex/ai-sdk-adapters', () => ({
  resolveAiSdkLanguageModel: () => modelRef.current,
}));

/**
 * B0-913 — the Anthropic path reads the `BEX_GENERATION_EFFORT` row. Mocked so no test touches
 * Supabase and the default stays the `provider_default` sentinel (send nothing) unless a case
 * overrides it.
 */
const { mockGetStringSetting } = vi.hoisted(() => ({
  mockGetStringSetting: vi.fn(async (_key: string, fallback: string) => fallback),
}));
vi.mock('~/lib/settings/settings-service', () => ({
  getStringSetting: mockGetStringSetting,
}));

beforeEach(() => {
  mockGetStringSetting.mockReset();
  mockGetStringSetting.mockImplementation(async (_key: string, fallback: string) => fallback);
});

import { runAiSdkWithToolLoop } from '~/lib/bex/ai-sdk-runtime';
import {
  formatPriorTurnToolContext,
  PRIOR_TURN_TOOL_CONTEXT_HEADER,
  RETRIEVAL_EXHAUSTED_INSTRUCTION,
  TOOL_ROUNDS_EXHAUSTED_FALLBACK_TEXT,
  TOOL_ROUNDS_EXHAUSTED_INSTRUCTION,
  UNPRODUCTIVE_RETRIEVAL_CALL_LIMIT,
} from '~/lib/openai/responses-runtime';
import {
  isUpstreamTransportError,
  UPSTREAM_RETRY_USER_MESSAGE,
} from '~/lib/openai/transport-retry';

function textOnlyModel(deltas: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '0' },
          ...deltas.map((delta) => ({ type: 'text-delta', id: '0', delta }) as const),
          { type: 'text-end', id: '0' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      }),
    }),
  });
}

const noopExecuteTool = async () => ({
  output: '{}',
  trace: { toolName: 'noop', callId: 'c', argumentsPreview: '', outputPreview: '', ok: true, durationMs: 0 } as ToolTraceEntry,
});

describe('runAiSdkWithToolLoop', () => {
  it('streams text deltas and returns the assembled assistant text', async () => {
    modelRef.current = textOnlyModel(['Hello', ', ', 'world!']);
    const deltas: string[] = [];

    const result = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      onAssistantDelta: (delta) => deltas.push(delta),
      executeTool: noopExecuteTool,
    });

    expect(deltas.join('')).toBe('Hello, world!');
    expect(result.assistantText).toBe('Hello, world!');
    expect(result.finalResponseId).toBeNull();
    expect(result.responseIds.length).toBeGreaterThanOrEqual(1);
    // B0-117 — usage is surfaced on the result (numeric fields; the mock reports zeros).
    // B0-324 — plus the prompt-cache read count.
    expect(result.usage).toEqual({
      promptTokens: expect.any(Number),
      completionTokens: expect.any(Number),
      totalTokens: expect.any(Number),
      cachedPromptTokens: expect.any(Number),
    });
  });

  /** B0-429 — TTFT is measured on every run, including callers that consume no deltas. */
  it('feeds the measurement-only observer with no caller sink attached', async () => {
    modelRef.current = textOnlyModel(['Hello', ', ', 'world!']);
    const observed: string[] = [];

    const result = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      observeAssistantDelta: (delta) => observed.push(delta),
      executeTool: noopExecuteTool,
    });

    expect(observed).toEqual(['Hello', ', ', 'world!']);
    expect(result.assistantText).toBe('Hello, world!');
  });

  it('runs the tool loop: executes the forced tool, then streams the final answer', async () => {
    let call = 0;
    modelRef.current = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'tool-call',
                  toolCallId: 't1',
                  toolName: 'lookup_cross_reference',
                  input: JSON.stringify({ brand: 'Spartan', productName: 'BNC-15' }),
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ] as const,
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: 'Triforce (#333)' },
              { type: 'text-end', id: '0' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ] as const,
          }),
        };
      },
    });

    const executeTool = vi.fn(async ({ name }: { name: string; argumentsJson: string; callId: string }) => ({
      output: JSON.stringify({ ok: true, matches: [{ betcoProduct: 'Triforce #333' }] }),
      trace: { toolName: name, callId: 't1', argumentsPreview: '', outputPreview: '', ok: true, durationMs: 0 } as ToolTraceEntry,
    }));

    const result = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [{ role: 'user', content: 'earlier turn' }],
      userMessage: 'Spartan BNC-15 equivalent?',
      toolChoice: { type: 'function', name: 'lookup_cross_reference' },
      executeTool,
    });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0]?.[0].name).toBe('lookup_cross_reference');
    expect(result.assistantText).toBe('Triforce (#333)');
    expect(result.toolTrace).toHaveLength(1);
    expect(result.responseIds.length).toBeGreaterThanOrEqual(2);
    // B0-117 — usage is surfaced on the result (numeric total).
    expect(typeof result.usage.totalTokens).toBe('number');
    // B0-324 — one usage entry per model call, so prompt-cache reuse per round is verifiable.
    expect(result.usageByCall).toHaveLength(result.responseIds.length);
  });

  it('executes the tool calls of one step concurrently (B0-379 parity)', async () => {
    let call = 0;
    modelRef.current = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        const finish = (finishReason: 'stop' | 'tool-calls') =>
          ({
            type: 'finish',
            finishReason,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }) as const;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'tool-call', toolCallId: 't1', toolName: 'lookup_cross_reference', input: '{"brand":"A","productName":"1"}' },
                { type: 'tool-call', toolCallId: 't2', toolName: 'lookup_cross_reference', input: '{"brand":"B","productName":"2"}' },
                finish('tool-calls'),
              ] as const,
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: 'done' },
              { type: 'text-end', id: '0' },
              finish('stop'),
            ] as const,
          }),
        };
      },
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const executeTool = vi.fn(async ({ name, callId }: { name: string; argumentsJson: string; callId: string }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return {
        output: '{}',
        trace: { toolName: name, callId, argumentsPreview: '', outputPreview: '', ok: true, durationMs: 0 } as ToolTraceEntry,
      };
    });

    await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'compare two products',
      executeTool,
    });

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(2);
  });

  it('surfaces provider prompt-cache reads per model call (B0-324)', async () => {
    let call = 0;
    modelRef.current = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'tool-call',
                  toolCallId: 't1',
                  toolName: 'search_product_docs',
                  input: JSON.stringify({ topic: 'dilution' }),
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: {
                    inputTokens: { total: 5000, noCache: 5000, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 20, text: 20, reasoning: 0 },
                  },
                },
              ] as const,
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: 'Answer' },
              { type: 'text-end', id: '0' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: {
                  inputTokens: { total: 5600, noCache: 480, cacheRead: 5120, cacheWrite: 0 },
                  outputTokens: { total: 30, text: 30, reasoning: 0 },
                },
              },
            ] as const,
          }),
        };
      },
    });

    const result = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'What is the dilution for Green Earth?',
      executeTool: noopExecuteTool,
    });

    expect(result.usageByCall).toHaveLength(2);
    expect(result.usageByCall[0]?.cachedPromptTokens).toBe(0);
    // The 2nd+ call in the loop replays the identical instructions + tool schemas prefix.
    expect(result.usageByCall[1]?.cachedPromptTokens).toBe(5120);
    expect(result.usage.cachedPromptTokens).toBe(5120);
  });

  it('forwards the OpenAI promptCacheKey provider option (B0-324)', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    modelRef.current = new MockLanguageModelV3({
      doStream: async (options) => {
        seen.push(options.providerOptions);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: 'ok' },
              { type: 'text-end', id: '0' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ] as const,
          }),
        };
      },
    });

    await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      promptCacheKey: 'bex-product-support:orchestrator:product',
      executeTool: noopExecuteTool,
    });

    expect(seen[0]?.openai).toEqual({
      promptCacheKey: 'bex-product-support:orchestrator:product',
    });
  });
});


/**
 * B0-370 — the retry boundary here is one `doStream` call inside the tool loop, installed as
 * middleware. These tests pin the two properties that matter: transient faults recover, and a
 * recovery never replays a tool that already ran.
 */
describe('runAiSdkWithToolLoop — bounded transport retry (B0-370)', () => {
  /** Mirrors undici: `TypeError: fetch failed` wrapping the socket error. */
  function fetchFailed(): Error {
    return new TypeError('fetch failed', {
      cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }),
    });
  }

  /** No real timers, no jitter randomness. */
  const testRetry = { sleep: async () => undefined, random: () => 0.5 };

  const textStream = (text: string) =>
    simulateReadableStream({
      chunks: [
        { type: 'text-start', id: '0' },
        { type: 'text-delta', id: '0', delta: text },
        { type: 'text-end', id: '0' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ] as const,
    });

  const toolCallStream = (toolName: string, input: unknown) =>
    simulateReadableStream({
      chunks: [
        { type: 'tool-call', toolCallId: 't1', toolName, input: JSON.stringify(input) },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ] as const,
    });

  it('retries a network fault and succeeds', async () => {
    const doStream = vi.fn(async () => {
      if (doStream.mock.calls.length === 1) {
        throw fetchFailed();
      }
      return { stream: textStream('Use a neutral cleaner.') };
    });
    modelRef.current = new MockLanguageModelV3({ doStream });

    const result = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'what cleaner is best for gym floors',
      retry: testRetry,
      executeTool: noopExecuteTool,
    });

    expect(doStream).toHaveBeenCalledTimes(2);
    expect(result.assistantText).toBe('Use a neutral cleaner.');
  });

  it('times out a request that never produces a first chunk and retries it (B0-550 parity)', async () => {
    vi.stubEnv('BEX_OPENAI_REQUEST_TIMEOUT_MS', '20');
    try {
      const doStream = vi.fn(async (options: { abortSignal?: AbortSignal }) => {
        if (doStream.mock.calls.length === 1) {
          // A hung request: only the per-attempt abort ends it.
          await new Promise((_, reject) => {
            options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason));
          });
        }
        return { stream: textStream('Use a neutral cleaner.') };
      });
      modelRef.current = new MockLanguageModelV3({ doStream });

      const result = await runAiSdkWithToolLoop({
        modelTag: 'gpt-4.1',
        instructions: 'You are Bex.',
        history: [],
        userMessage: 'what cleaner is best for gym floors',
        retry: testRetry,
        executeTool: noopExecuteTool,
      });

      expect(doStream).toHaveBeenCalledTimes(2);
      expect(result.assistantText).toBe('Use a neutral cleaner.');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not re-run a tool when the model call after it is retried', async () => {
    // Step 1 calls a tool; the step-2 model request then faults. Retrying that request must not
    // replay the tool — the AI SDK executes tools above the middleware, so the replay only
    // re-sends the prompt (which already carries the tool result as a message).
    const doStream = vi.fn(async () => {
      const call = doStream.mock.calls.length;
      if (call === 1) {
        return { stream: toolCallStream('lookup_cross_reference', { brand: 'Spartan', productName: 'BNC-15' }) };
      }
      if (call === 2) {
        throw fetchFailed();
      }
      return { stream: textStream('Triforce (#333)') };
    });
    modelRef.current = new MockLanguageModelV3({ doStream });

    const executeTool = vi.fn(async ({ name }: { name: string; argumentsJson: string; callId: string }) => ({
      output: JSON.stringify({ ok: true }),
      trace: { toolName: name, callId: 't1', argumentsPreview: '', outputPreview: '', ok: true, durationMs: 0 } as ToolTraceEntry,
    }));

    const result = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'Spartan BNC-15 equivalent?',
      toolChoice: { type: 'function', name: 'lookup_cross_reference' },
      retry: testRetry,
      executeTool,
    });

    // The acceptance criterion: exactly one tool invocation across the retry.
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.toolTrace).toHaveLength(1);
    expect(doStream).toHaveBeenCalledTimes(3);
    expect(result.assistantText).toBe('Triforce (#333)');
  });

  it('does not retry a 4xx validation error', async () => {
    const badRequest = Object.assign(new Error('Invalid schema for function'), { statusCode: 400 });
    const doStream = vi.fn(async () => {
      throw badRequest;
    });
    modelRef.current = new MockLanguageModelV3({ doStream });

    const error = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hello',
      retry: testRetry,
      executeTool: noopExecuteTool,
    }).catch((err: unknown) => err);

    expect(doStream).toHaveBeenCalledTimes(1);
    // Not rewritten into the retry-able wording: a real defect must stay legible.
    expect(isUpstreamTransportError(error)).toBe(false);
  });

  it('fails cleanly with the user-facing message after exhausting retries', async () => {
    const doStream = vi.fn(async () => {
      throw fetchFailed();
    });
    modelRef.current = new MockLanguageModelV3({ doStream });

    const error = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hello',
      retry: testRetry,
      executeTool: noopExecuteTool,
    }).catch((err: unknown) => err);

    expect(doStream).toHaveBeenCalledTimes(3);
    expect(isUpstreamTransportError(error)).toBe(true);
    expect((error as Error).message).toBe(UPSTREAM_RETRY_USER_MESSAGE);
  });

  it('retries when the fault arrives as the first stream chunk instead of a rejection', async () => {
    // A fault after response headers but before the first token surfaces as an `error` part. The
    // first-chunk peek turns it into a rejection while nothing has been emitted, so it is still
    // safely retryable.
    const doStream = vi.fn(async () => {
      if (doStream.mock.calls.length === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [{ type: 'error', error: fetchFailed() }] as const,
          }),
        };
      }
      return { stream: textStream('Recovered answer') };
    });
    modelRef.current = new MockLanguageModelV3({ doStream });

    const deltas: string[] = [];
    const result = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hello',
      retry: testRetry,
      onAssistantDelta: (delta) => deltas.push(delta),
      executeTool: noopExecuteTool,
    });

    expect(doStream).toHaveBeenCalledTimes(2);
    expect(result.assistantText).toBe('Recovered answer');
    // The failed attempt emitted nothing, so no text is duplicated for the user.
    expect(deltas).toEqual(['Recovered answer']);
  });
});
describe('runAiSdkWithToolLoop — preloaded evidence (B0-436)', () => {
  it('appends the evidence as the last message of the prompt, after the user message', async () => {
    const prompts: unknown[] = [];
    modelRef.current = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: '2 oz per gallon.' },
              { type: 'text-end', id: '0' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ] as const,
          }),
        };
      },
    });

    const result = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [{ role: 'user', content: 'earlier turn' }],
      userMessage: 'dilution for Green Earth?',
      preloadedEvidence: {
        label: 'search_product_docs({"freeformQuery":"dilution for Green Earth?"})',
        text: '{"ok":true,"sources":[{"documentId":"doc-1"}]}',
      },
      executeTool: noopExecuteTool,
    });

    expect(result.assistantText).toBe('2 oz per gallon.');

    const messages = prompts[0] as Array<{ role: string; content: unknown }>;
    const last = messages.at(-1);
    const secondToLast = messages.at(-2);
    expect(secondToLast?.role).toBe('user');
    expect(JSON.stringify(secondToLast?.content)).toContain('dilution for Green Earth?');
    expect(last?.role).toBe('user');
    expect(JSON.stringify(last?.content)).toContain('## Retrieved evidence (pre-fetched)');
    expect(JSON.stringify(last?.content)).toContain('doc-1');
    // The stable, cacheable prefix must not carry the per-request evidence.
    const system = messages.find((message) => message.role === 'system');
    expect(JSON.stringify(system?.content ?? '')).not.toContain('Retrieved evidence');
  });
});

describe('runAiSdkWithToolLoop — model vs persisted tool output (B0-437)', () => {
  it('feeds `modelOutput` back into the next step, not the full persisted output', async () => {
    const prompts: unknown[] = [];
    let call = 0;
    modelRef.current = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'tool-call',
                  toolCallId: 't1',
                  toolName: 'search_product_docs',
                  input: JSON.stringify({ freeformQuery: 'pH7Q first aid' }),
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ] as const,
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: 'Rinse cautiously with water.' },
              { type: 'text-end', id: '0' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ] as const,
          }),
        };
      },
    });

    await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'pH7Q first aid',
      executeTool: async ({ name }) => ({
        output: '{"sources":[{"snippet":"...","documentBody":"FULL BODY"}]}',
        modelOutput: '{"sources":[{"documentBody":"SLIM"}]}',
        trace: {
          toolName: name,
          callId: 't1',
          argumentsPreview: '',
          outputPreview: '',
          ok: true,
          durationMs: 0,
        } as ToolTraceEntry,
      }),
    });

    const step2 = JSON.stringify(prompts[1]);
    expect(step2).toContain('SLIM');
    expect(step2).not.toContain('FULL BODY');
  });
});

/**
 * B0-378 — the fidelity gap this ticket closes. Before it, `history` was user/assistant TEXT only,
 * so every prior turn's tool activity was dropped on this runtime while the Responses
 * `previous_response_id` chain kept it server-side.
 */
describe('runAiSdkWithToolLoop — prior-turn tool context replay (B0-378)', () => {
  function capturingModel(prompts: unknown[]): MockLanguageModelV3 {
    return new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: 'ok' },
              { type: 'text-end', id: '0' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ] as const,
          }),
        };
      },
    });
  }

  const toolContext = formatPriorTurnToolContext({
    toolNames: ['search_product_docs', 'get_efficacy_data'],
    sourceTitles: ['pH7Q Dual Label (US)'],
  });

  it('replays an assistant turn\'s tool context as its own message, immediately after that turn', async () => {
    const prompts: unknown[] = [];
    modelRef.current = capturingModel(prompts);

    await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [
        { role: 'user', content: 'Is pH7Q effective against norovirus?' },
        { role: 'assistant', content: 'Yes — see the label.', toolContext: toolContext! },
      ],
      userMessage: 'And what dilution did that use?',
      executeTool: noopExecuteTool,
    });

    const messages = prompts[0] as Array<{ role: string; content: unknown }>;
    const nonSystem = messages.filter((message) => message.role !== 'system');

    expect(nonSystem.map((message) => message.role)).toEqual([
      'user', // prior user turn
      'assistant', // prior assistant turn
      'user', // B0-378 — its tool context, replayed right after it
      'user', // this turn's message
    ]);
    const replayed = JSON.stringify(nonSystem[2]?.content);
    expect(replayed).toContain(PRIOR_TURN_TOOL_CONTEXT_HEADER);
    expect(replayed).toContain('search_product_docs');
    expect(replayed).toContain('get_efficacy_data');
    expect(replayed).toContain('pH7Q Dual Label (US)');
    expect(JSON.stringify(nonSystem.at(-1)?.content)).toContain('And what dilution did that use?');
  });

  it('never fabricates tool-call or tool-result parts for a replayed turn', async () => {
    const prompts: unknown[] = [];
    modelRef.current = capturingModel(prompts);

    await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [
        { role: 'assistant', content: 'Earlier answer.', toolContext: toolContext! },
      ],
      userMessage: 'follow-up',
      executeTool: noopExecuteTool,
    });

    const messages = prompts[0] as Array<{ role: string; content: unknown }>;
    // Replaying invented tool parts (with invented call ids, and a truncated preview posing as the
    // full payload) would be worse than summarising: the model would believe it holds the evidence.
    expect(JSON.stringify(messages)).not.toContain('"tool-call"');
    expect(JSON.stringify(messages)).not.toContain('"tool-result"');
    expect(messages.some((message) => message.role === 'tool')).toBe(false);
  });

  it('emits nothing extra for a prior turn that recorded no tool activity', async () => {
    const prompts: unknown[] = [];
    modelRef.current = capturingModel(prompts);

    await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [{ role: 'assistant', content: 'Earlier answer.' }],
      userMessage: 'follow-up',
      executeTool: noopExecuteTool,
    });

    const messages = prompts[0] as Array<{ role: string; content: unknown }>;
    const nonSystem = messages.filter((message) => message.role !== 'system');
    expect(nonSystem.map((message) => message.role)).toEqual(['assistant', 'user']);
  });
});

/* -------------------------------------------------------------------------- *
 * B0-908 — provider-aware request options
 * -------------------------------------------------------------------------- */

describe('provider-aware request options (B0-908)', () => {
  type DoStreamParams = Parameters<NonNullable<MockLanguageModelV3['doStream']>>[0];

  function capturingModel(modelId: string, seen: DoStreamParams[]): MockLanguageModelV3 {
    return new MockLanguageModelV3({
      modelId,
      doStream: async (params) => {
        seen.push(params);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: 'ok' },
              { type: 'text-end', id: '0' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ] as const,
          }),
        };
      },
    });
  }

  it('sends the OpenAI promptCacheKey providerOption for an OpenAI model', async () => {
    const seen: DoStreamParams[] = [];
    modelRef.current = capturingModel('gpt-4.1-mini', seen);

    await runAiSdkWithToolLoop({
      modelTag: 'gpt-4.1-mini',
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      promptCacheKey: 'bex:v1',
      executeTool: noopExecuteTool,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].providerOptions).toEqual({ openai: { promptCacheKey: 'bex:v1' } });
  });

  it('sends no openai providerOptions and no sampling/thinking controls for a claude-* model', async () => {
    const seen: DoStreamParams[] = [];
    modelRef.current = capturingModel('claude-sonnet-5', seen);

    const result = await runAiSdkWithToolLoop({
      modelTag: 'claude-sonnet-5',
      instructions: 'You are Bex.',
      history: [{ role: 'user', content: 'earlier' }],
      userMessage: 'hi',
      promptCacheKey: 'bex:v1',
      executeTool: noopExecuteTool,
    });

    expect(result.assistantText).toBe('ok');
    expect(seen).toHaveLength(1);
    const params = seen[0];
    expect(params.providerOptions?.openai).toBeUndefined();
    // Opus 5 / Sonnet 5 reject temperature/top_p (400) and budget_tokens; nothing is sent so the
    // provider defaults (adaptive thinking on Opus 5, none on Haiku 4.5) apply untouched.
    expect(params.temperature).toBeUndefined();
    expect(params.topP).toBeUndefined();
    expect(params.topK).toBeUndefined();
    // B0-900 / B0-913 — with BEX_GENERATION_EFFORT at its `provider_default` sentinel the only
    // request-level Anthropic provider option is the automatic cache breakpoint; in particular no
    // `thinking`, `effort` or sampling control rides along with it.
    expect(params.providerOptions?.anthropic).toEqual({ cacheControl: { type: 'ephemeral' } });
    // History replay is provider-independent and byte-identical to the OpenAI path.
    expect(params.prompt.filter((message) => message.role === 'user')).toHaveLength(2);
  });

  /**
   * B0-900 — `promptCacheKey` is the caller's "cache the stable prefix" statement; Anthropic has no
   * cache key, so its presence maps to the request-level `cacheControl` breakpoint instead.
   */
  it('maps promptCacheKey to the Anthropic cacheControl provider option for a claude-* model', async () => {
    const seen: DoStreamParams[] = [];
    modelRef.current = capturingModel('claude-opus-5', seen);

    await runAiSdkWithToolLoop({
      modelTag: 'claude-opus-5',
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      promptCacheKey: 'bex-product-support:orchestrator:product',
      executeTool: noopExecuteTool,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
    // The OpenAI key's VALUE never reaches Anthropic — there is no field for it.
    expect(JSON.stringify(seen[0].providerOptions)).not.toContain('bex-product-support');
    expect(seen[0].providerOptions?.openai).toBeUndefined();
  });

  it('sends no cache option at all to a claude-* model when the caller asks for no caching', async () => {
    const seen: DoStreamParams[] = [];
    modelRef.current = capturingModel('claude-sonnet-5', seen);

    await runAiSdkWithToolLoop({
      modelTag: 'claude-sonnet-5',
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      executeTool: noopExecuteTool,
    });

    expect(seen[0].providerOptions).toBeUndefined();
    // No caching → the instructions go as a plain system message with no breakpoint.
    const system = seen[0].prompt.find((message) => message.role === 'system');
    expect(system?.providerOptions).toBeUndefined();
  });

  /**
   * B0-913 — the explicit, NON-TERMINAL cache breakpoint. Anthropic renders `tools` → `system` →
   * `messages`, so `cache_control` on the system text block ends the cacheable prefix after the two
   * parts that are constant for a route, which is what makes the cache readable across turns and
   * eval items rather than only across steps within one turn.
   */
  it('places an explicit 1h cache breakpoint on the system message for a claude-* model', async () => {
    const seen: DoStreamParams[] = [];
    modelRef.current = capturingModel('claude-opus-5', seen);

    await runAiSdkWithToolLoop({
      modelTag: 'claude-opus-5',
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      promptCacheKey: 'bex:v1',
      executeTool: noopExecuteTool,
    });

    const prompt = seen[0].prompt;
    expect(prompt[0]?.role).toBe('system');
    expect(prompt[0]?.content).toBe('You are Bex.');
    expect(prompt[0]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
    });
    // ...alongside, not instead of, the request-level automatic breakpoint that covers the
    // growing per-step tail. Two of Anthropic's four allowed breakpoints.
    expect(seen[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  /**
   * B0-913 — the breakpoint has to survive `prepareStep`, which rewrites `messages` on the
   * exhaustion/withdrawal paths. `system` is a separate top-level option, so every step of the loop
   * re-sends the same marked prefix — that is what makes the prefix readable rather than rewritten.
   */
  it('keeps the system breakpoint on every step of a multi-step run', async () => {
    const seen: DoStreamParams[] = [];
    let call = 0;
    modelRef.current = new MockLanguageModelV3({
      modelId: 'claude-opus-5',
      doStream: async (params) => {
        seen.push(params);
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'tool-call',
                  toolCallId: 't1',
                  toolName: 'lookup_cross_reference',
                  input: JSON.stringify({ brand: 'Spartan', productName: 'BNC-15' }),
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ] as const,
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: 'ok' },
              { type: 'text-end', id: '0' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ] as const,
          }),
        };
      },
    });

    await runAiSdkWithToolLoop({
      modelTag: 'claude-opus-5',
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      promptCacheKey: 'bex:v1',
      executeTool: noopExecuteTool,
    });

    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const params of seen) {
      expect(params.prompt[0]?.role).toBe('system');
      expect(params.prompt[0]?.providerOptions).toEqual({
        anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
      });
    }
  });

  it('leaves the OpenAI system message a plain string with no breakpoint', async () => {
    const seen: DoStreamParams[] = [];
    modelRef.current = capturingModel('gpt-4.1', seen);

    await runAiSdkWithToolLoop({
      modelTag: 'gpt-4.1',
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      promptCacheKey: 'bex:v1',
      executeTool: noopExecuteTool,
    });

    const system = seen[0].prompt.find((message) => message.role === 'system');
    expect(system?.content).toBe('You are Bex.');
    expect(system?.providerOptions).toBeUndefined();
  });

  /**
   * B0-913 — the settings-driven generation effort. `provider_default` (the seeded row value) must
   * send nothing at all; an explicit level rides in `providerOptions.anthropic.effort`, which
   * `@ai-sdk/anthropic` emits as `output_config.effort`.
   */
  it('sends no effort for a claude-* model while BEX_GENERATION_EFFORT is provider_default', async () => {
    const seen: DoStreamParams[] = [];
    modelRef.current = capturingModel('claude-opus-5', seen);

    await runAiSdkWithToolLoop({
      modelTag: 'claude-opus-5',
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      promptCacheKey: 'bex:v1',
      executeTool: noopExecuteTool,
    });

    expect(seen[0].providerOptions?.anthropic).not.toHaveProperty('effort');
  });

  it('forwards an explicit BEX_GENERATION_EFFORT level to a claude-* model', async () => {
    mockGetStringSetting.mockImplementation(async (key: string, fallback: string) =>
      key === 'BEX_GENERATION_EFFORT' ? 'low' : fallback,
    );
    const seen: DoStreamParams[] = [];
    modelRef.current = capturingModel('claude-opus-5', seen);

    await runAiSdkWithToolLoop({
      modelTag: 'claude-opus-5',
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      promptCacheKey: 'bex:v1',
      executeTool: noopExecuteTool,
    });

    expect(seen[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' }, effort: 'low' },
    });
  });

  it('sends the effort with no caching option when the caller asks for no caching', async () => {
    mockGetStringSetting.mockImplementation(async (key: string, fallback: string) =>
      key === 'BEX_GENERATION_EFFORT' ? 'max' : fallback,
    );
    const seen: DoStreamParams[] = [];
    modelRef.current = capturingModel('claude-opus-5', seen);

    await runAiSdkWithToolLoop({
      modelTag: 'claude-opus-5',
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      executeTool: noopExecuteTool,
    });

    expect(seen[0].providerOptions).toEqual({ anthropic: { effort: 'max' } });
  });

  /**
   * `supportsAnthropicAdaptiveThinking` (~/lib/llm/structured-completion.ts) excludes Haiku-class
   * and older Claude ids, which 400 on `output_config.effort`. The row is never even read for them.
   */
  it('never sends effort to a Claude model that rejects output_config.effort', async () => {
    mockGetStringSetting.mockImplementation(async (key: string, fallback: string) =>
      key === 'BEX_GENERATION_EFFORT' ? 'low' : fallback,
    );
    const seen: DoStreamParams[] = [];
    modelRef.current = capturingModel('claude-haiku-4-5', seen);

    await runAiSdkWithToolLoop({
      modelTag: 'claude-haiku-4-5',
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      promptCacheKey: 'bex:v1',
      executeTool: noopExecuteTool,
    });

    expect(seen[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  it('never sends effort to an OpenAI model even when the row names a level', async () => {
    mockGetStringSetting.mockImplementation(async (key: string, fallback: string) =>
      key === 'BEX_GENERATION_EFFORT' ? 'low' : fallback,
    );
    const seen: DoStreamParams[] = [];
    modelRef.current = capturingModel('gpt-5.6', seen);

    await runAiSdkWithToolLoop({
      modelTag: 'gpt-5.6',
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      promptCacheKey: 'bex:v1',
      executeTool: noopExecuteTool,
    });

    expect(seen[0].providerOptions).toEqual({ openai: { promptCacheKey: 'bex:v1' } });
  });

  it('keeps the OpenAI branch byte-identical: no anthropic providerOptions for a gpt model', async () => {
    const seen: DoStreamParams[] = [];
    modelRef.current = capturingModel('gpt-4.1', seen);

    await runAiSdkWithToolLoop({
      modelTag: 'gpt-4.1',
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'hi',
      promptCacheKey: 'bex:v1',
      executeTool: noopExecuteTool,
    });

    expect(seen[0].providerOptions).toEqual({ openai: { promptCacheKey: 'bex:v1' } });
    expect(seen[0].providerOptions?.anthropic).toBeUndefined();
  });

  it('replays the prior-turn tool-context block in the same position for a claude-* model (B0-378 parity)', async () => {
    const seen: DoStreamParams[] = [];
    modelRef.current = capturingModel('claude-sonnet-5', seen);
    const toolContext = formatPriorTurnToolContext({
      toolNames: ['search_product_docs'],
      sourceTitles: ['pH7Q Dual Label (US)'],
    });

    await runAiSdkWithToolLoop({
      modelTag: 'claude-sonnet-5',
      instructions: 'You are Bex.',
      history: [
        { role: 'user', content: 'Is pH7Q effective against norovirus?' },
        { role: 'assistant', content: 'Yes — see the label.', toolContext: toolContext! },
      ],
      userMessage: 'And what dilution did that use?',
      promptCacheKey: 'bex:v1',
      executeTool: noopExecuteTool,
    });

    const nonSystem = seen[0].prompt.filter((message) => message.role !== 'system');
    expect(nonSystem.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(JSON.stringify(nonSystem[2]?.content)).toContain(PRIOR_TURN_TOOL_CONTEXT_HEADER);
    expect(JSON.stringify(nonSystem[2]?.content)).toContain('pH7Q Dual Label (US)');
    expect(JSON.stringify(nonSystem.at(-1)?.content)).toContain('And what dilution did that use?');
    // B0-913 — the explicit breakpoint lives on the SYSTEM message only. No history or user
    // message is given providerOptions, so the replayed conversation stays byte-identical to the
    // OpenAI path (and to the pre-B0-913 Anthropic path).
    expect(JSON.stringify(nonSystem)).not.toContain('cacheControl');
  });
});

/**
 * B0-901 — the three Responses-only loop behaviours, ported. Each case below mirrors the
 * corresponding `responses-runtime.test.ts` case (`— tool-round exhaustion (B0-381)`,
 * `— unproductive-retrieval early stop (B0-635)`, `— temperature gating (B0-606)`) and asserts the
 * same MODEL-VISIBLE text, because the point of the port is that a provider A/B compares models
 * rather than runtimes.
 */
describe('runAiSdkWithToolLoop — ported loop behaviours (B0-901)', () => {
  const functionTool = (name: string): OpenAiTool => ({
    type: 'function',
    name,
    description: name,
    parameters: { type: 'object', properties: {}, required: [] },
    strict: false,
  });

  /** One retrieval tool + one non-retrieval tool, the shape `productSupportToolsForRoute` returns. */
  const offeredTools: OpenAiTool[] = [
    functionTool('search_product_docs'),
    functionTool('lookup_cross_reference'),
  ];

  /**
   * A corpus-SEARCH payload citing exactly these documents (one chunk each), carrying the real
   * `adapter` discriminator — only a search payload can count toward exhaustion. Same fixture text
   * as the Responses case.
   */
  const retrieved = (...documentIds: string[]) =>
    JSON.stringify({
      ok: true,
      adapter: 'rag_corpus_full_document',
      sources: documentIds.map((documentId) => ({
        documentId,
        chunkId: `${documentId}#c1`,
        documentBody: 'FastDraw dilution guidance…',
      })),
    });

  /** A structured point lookup with no facts on file — neutral, never counts toward exhaustion. */
  const noFactsOnFile = () =>
    JSON.stringify({ ok: true, adapter: 'structured_facts_v1', facts: null });

  const searchCallChunks = (id: string) =>
    [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: 'search_product_docs',
        input: JSON.stringify({ freeformQuery: 'cartridge yield' }),
      },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ] as const;

  const answerChunks = (text: string) =>
    [
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: text },
      { type: 'text-end', id: '0' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ] as const;

  /** Records every prepared request so the injected instructions and tool set can be inspected. */
  function recordingModel(
    perCall: Array<ReadonlyArray<Record<string, unknown>>>,
    seen: Array<Record<string, unknown>>,
  ): MockLanguageModelV3 {
    let call = 0;
    return new MockLanguageModelV3({
      doStream: async (options) => {
        seen.push(options as unknown as Record<string, unknown>);
        const chunks = perCall[Math.min(call, perCall.length - 1)]!;
        call += 1;
        return {
          stream: simulateReadableStream({
            chunks: chunks as unknown as Parameters<typeof simulateReadableStream>[0]['chunks'],
          }),
        };
      },
    });
  }

  const promptText = (request: Record<string, unknown>): string =>
    JSON.stringify(request.prompt ?? '');

  const activeToolNames = (request: Record<string, unknown>): string[] =>
    ((request.tools ?? []) as Array<Record<string, unknown>>).map((tool) => String(tool.name));

  it('withdraws retrieval tools after two consecutive calls that surface no new document, and says why', async () => {
    const seen: Array<Record<string, unknown>> = [];
    modelRef.current = recordingModel(
      [
        searchCallChunks('t1'),
        searchCallChunks('t2'),
        searchCallChunks('t3'),
        answerChunks('The cartridge volume is not on file.'),
      ],
      seen,
    );

    // t1 finds doc-a (productive); t2 and t3 re-find only doc-a — the repro pattern from run 5b13095f.
    const outputs = [retrieved('doc-a'), retrieved('doc-a'), retrieved('doc-a')];
    let call = 0;
    const executeTool = vi.fn(async ({ name }: { name: string }) => {
      const output = outputs[call++] ?? '{}';
      return {
        output,
        trace: {
          toolName: name,
          callId: `t${call}`,
          argumentsPreview: '',
          outputPreview: '',
          ok: true,
          durationMs: 0,
        } as ToolTraceEntry,
      };
    });

    const onRetrievalExhausted = vi.fn();
    const result = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'How much does one FastDraw cartridge yield?',
      tools: offeredTools,
      executeTool,
      onRetrievalExhausted,
    });

    // Two unproductive calls trip the limit; the step prepared after them carries the notice…
    const withdrawnRequest = seen.find((request) =>
      promptText(request).includes('Retrieval is exhausted for this turn.'),
    );
    expect(withdrawnRequest).toBeDefined();
    // …with the byte-identical text the Responses loop sends.
    expect(promptText(withdrawnRequest!)).toContain(RETRIEVAL_EXHAUSTED_INSTRUCTION.slice(0, 120));
    // …and retrieval tools gone from that step, every other tool still offered.
    expect(activeToolNames(withdrawnRequest!)).not.toContain('search_product_docs');
    expect(activeToolNames(withdrawnRequest!)).toContain('lookup_cross_reference');
    // The hook fires exactly once, reporting the limit it tripped on.
    expect(onRetrievalExhausted).toHaveBeenCalledTimes(1);
    expect(onRetrievalExhausted.mock.calls[0]?.[0]).toMatchObject({
      unproductiveCallCount: UNPRODUCTIVE_RETRIEVAL_CALL_LIMIT,
    });
    expect(result.assistantText).toBe('The cartridge volume is not on file.');
  });

  it('never counts an empty structured-fact lookup toward withdrawal', async () => {
    const seen: Array<Record<string, unknown>> = [];
    modelRef.current = recordingModel(
      [
        searchCallChunks('t1'),
        searchCallChunks('t2'),
        searchCallChunks('t3'),
        answerChunks('Answer.'),
      ],
      seen,
    );

    // Three point lookups with nothing on file: neutral, so search is never withdrawn.
    const executeTool = vi.fn(async ({ name }: { name: string }) => ({
      output: noFactsOnFile(),
      trace: {
        toolName: name,
        callId: 't',
        argumentsPreview: '',
        outputPreview: '',
        ok: true,
        durationMs: 0,
      } as ToolTraceEntry,
    }));

    const onRetrievalExhausted = vi.fn();
    await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'Efficacy for Push?',
      tools: offeredTools,
      executeTool,
      onRetrievalExhausted,
    });

    expect(onRetrievalExhausted).not.toHaveBeenCalled();
    for (const request of seen) {
      expect(promptText(request)).not.toContain('Retrieval is exhausted for this turn.');
      expect(activeToolNames(request)).toContain('search_product_docs');
    }
  });

  it('forces a final answer with the tool-limit instruction once the tool budget is spent', async () => {
    const seen: Array<Record<string, unknown>> = [];
    // A model that never stops asking for tools, so the budget is always spent.
    modelRef.current = recordingModel([searchCallChunks('t1')], seen);

    const executeTool = vi.fn(async ({ name }: { name: string }) => ({
      // Fresh document each call, so B0-635 never fires and only the round cap can stop this.
      output: retrieved(`doc-${Math.random().toString(36).slice(2, 8)}`),
      trace: {
        toolName: name,
        callId: 't',
        argumentsPreview: '',
        outputPreview: '',
        ok: true,
        durationMs: 0,
      } as ToolTraceEntry,
    }));

    const onToolRoundsExhausted = vi.fn();
    const result = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'Compare everything.',
      tools: offeredTools,
      maxToolRounds: 2,
      executeTool,
      onToolRoundsExhausted,
    });

    // Two tool rounds, then exactly one forced-answer step: three model calls in total.
    expect(seen).toHaveLength(3);
    const finalRequest = seen.at(-1)!;
    expect(promptText(finalRequest)).toContain(
      'You have reached the tool-call limit for this turn',
    );
    expect(promptText(finalRequest)).toContain(TOOL_ROUNDS_EXHAUSTED_INSTRUCTION.slice(0, 120));
    expect(finalRequest.toolChoice).toEqual({ type: 'none' });
    expect(onToolRoundsExhausted).toHaveBeenCalledTimes(1);
    expect(onToolRoundsExhausted.mock.calls[0]?.[0]).toMatchObject({ maxToolRounds: 2 });
    // The forced step still produced no text, so the shared last-resort answer is returned rather
    // than an empty string.
    expect(result.assistantText).toBe(TOOL_ROUNDS_EXHAUSTED_FALLBACK_TEXT);
  });

  /**
   * B0-606 — the Responses loop replays a request without `temperature` when a model rejects it.
   * This loop is satisfied by construction: it never sends a sampling control on EITHER provider,
   * so there is nothing for a rejection to be triggered by. Asserted rather than assumed, because
   * adding a `temperature` here would silently break every Claude call (Opus 5 / Sonnet 5 return
   * 400 on any sampling control).
   */
  it('sends no sampling control on either provider, so a temperature rejection cannot arise', async () => {
    for (const modelTag of ['gpt-4.1-mini', 'claude-sonnet-5']) {
      const seen: Array<Record<string, unknown>> = [];
      modelRef.current = recordingModel([answerChunks('ok')], seen);

      await runAiSdkWithToolLoop({
        modelTag,
        instructions: 'You are Bex.',
        history: [],
        userMessage: 'hi',
        executeTool: noopExecuteTool,
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]!.temperature).toBeUndefined();
      expect(seen[0]!.topP).toBeUndefined();
    }
  });
});
