import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

import type { ToolTraceEntry } from '~/lib/audit/trace';

// The runtime resolves its model via resolveAiSdkLanguageModel; swap in a mock model per test.
const modelRef = vi.hoisted(() => ({ current: null as MockLanguageModelV3 | null }));

vi.mock('~/lib/bex/ai-sdk-adapters', () => ({
  resolveAiSdkLanguageModel: () => modelRef.current,
}));

import { runAiSdkWithToolLoop } from '~/lib/bex/ai-sdk-runtime';

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
