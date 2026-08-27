import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

import type { ToolTraceEntry } from '~/lib/audit/trace';

// The runtime resolves its model via resolveAiSdkLanguageModel; swap in a mock model per test.
const modelRef = vi.hoisted(() => ({ current: null as MockLanguageModelV3 | null }));

vi.mock('~/lib/bex/ai-sdk-adapters', () => ({
  resolveAiSdkLanguageModel: () => modelRef.current,
}));

import { runAiSdkWithToolLoop } from '~/lib/bex/ai-sdk-runtime';
import {
  formatPriorTurnToolContext,
  PRIOR_TURN_TOOL_CONTEXT_HEADER,
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
