import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolTraceEntry } from '~/lib/audit/trace';
import type { Tool as OpenAiTool } from 'openai/resources/responses/responses';

// Same harness as `~/lib/bex/ai-sdk-runtime.test.ts`: the runtime resolves its model through the
// adapter, and the Anthropic path reads one settings row.
const modelRef = vi.hoisted(() => ({ current: null as MockLanguageModelV3 | null }));

vi.mock('~/lib/bex/ai-sdk-adapters', () => ({
  resolveAiSdkLanguageModel: () => modelRef.current,
}));

const { mockGetStringSetting, mockGetBooleanSetting } = vi.hoisted(() => ({
  mockGetStringSetting: vi.fn(async (_key: string, fallback: string) => fallback),
  mockGetBooleanSetting: vi.fn(async (_key: string, fallback: boolean) => fallback),
}));
vi.mock('~/lib/settings/settings-service', () => ({
  getStringSetting: mockGetStringSetting,
  getBooleanSetting: mockGetBooleanSetting,
}));

beforeEach(() => {
  mockGetStringSetting.mockImplementation(async (_key: string, fallback: string) => fallback);
  mockGetBooleanSetting.mockImplementation(async (_key: string, fallback: boolean) => fallback);
});

import { runAiSdkWithToolLoop } from '~/lib/bex/ai-sdk-runtime';
import { requireFactToolForDraft } from '~/lib/workflows/product-support/fact-tool-enforcement';

/**
 * B0-948 — the AI SDK loop's half of fact-tool enforcement. `streamText` ends as soon as a step
 * produces text with no tool calls, so the forced call is a SECOND two-step `streamText` over the
 * same shared request rather than another round inside the first. The policy and the model-visible
 * instruction are the SAME ones the Responses loop uses (see
 * `fact-tool-enforcement.test.ts`), so an A/B between the runtimes compares models, not wording.
 */

const COMPAT_SENTENCE =
  'The product is suitable for use on all types of resilient tile, including vinyl composition, vinyl, and linoleum.';

const functionTool = (name: string): OpenAiTool => ({
  type: 'function',
  name,
  description: name,
  parameters: { type: 'object', properties: {}, required: [] },
  strict: false,
});

const offeredTools: OpenAiTool[] = [
  functionTool('search_product_docs'),
  functionTool('list_allowed_surfaces'),
];

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

const toolCallChunks = (toolName: string, id: string) =>
  [
    { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify({ productName: 'X' }) },
    {
      type: 'finish',
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ] as const;

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

const executeToolOk = async ({ name }: { name: string }) => ({
  output: '{"ok":true}',
  trace: {
    toolName: name,
    callId: `call_${name}`,
    argumentsPreview: '',
    outputPreview: '',
    ok: true,
    durationMs: 0,
  } as ToolTraceEntry,
});

describe('runAiSdkWithToolLoop — fact-tool enforcement (B0-948)', () => {
  it('forces the owning tool and re-drafts when the draft claims a surface it never looked up', async () => {
    const seen: Array<Record<string, unknown>> = [];
    modelRef.current = recordingModel(
      [
        answerChunks(`Betco offers several strippers. ${COMPAT_SENTENCE}`),
        toolCallChunks('list_allowed_surfaces', 'forced_1'),
        answerChunks('Rewritten against the approved-surface list.'),
      ],
      seen,
    );
    const onFactToolEnforced = vi.fn();
    const deltas: string[] = [];

    const result = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'What is the strongest wood floor stripper?',
      tools: offeredTools,
      requireFactTool: requireFactToolForDraft,
      onFactToolEnforced,
      onAssistantDelta: (delta) => deltas.push(delta),
      executeTool: executeToolOk,
    });

    // Three model requests: the draft, the forced call, the re-draft.
    expect(seen).toHaveLength(3);
    // The forced request carries the same instruction the Responses loop sends…
    expect(promptText(seen[1]!)).toContain('list_allowed_surfaces');
    expect(promptText(seen[1]!)).toContain('was not called this turn');
    // …and is pinned to that one tool.
    expect(seen[1]!.toolChoice).toEqual({ type: 'tool', toolName: 'list_allowed_surfaces' });

    expect(result.assistantText).toBe('Rewritten against the approved-surface list.');
    expect(result.toolTrace.map((entry) => entry.toolName)).toEqual(['list_allowed_surfaces']);
    expect(onFactToolEnforced).toHaveBeenCalledTimes(1);
    expect(onFactToolEnforced.mock.calls[0]?.[0]).toEqual({
      requiredTool: 'list_allowed_surfaces',
      enforced: true,
      toolSucceeded: true,
    });
    // The first draft was already streamed to the caller and cannot be retracted, so the re-draft
    // is NOT appended to the visible stream — the returned text is the answer of record.
    expect(deltas.join('')).toBe(`Betco offers several strippers. ${COMPAT_SENTENCE}`);
  });

  it('finalizes unchanged when the owning tool was already called', async () => {
    const seen: Array<Record<string, unknown>> = [];
    modelRef.current = recordingModel(
      [
        toolCallChunks('list_allowed_surfaces', 't1'),
        answerChunks(`Betco offers several strippers. ${COMPAT_SENTENCE}`),
      ],
      seen,
    );
    const onFactToolEnforced = vi.fn();

    const result = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'What is the strongest wood floor stripper?',
      tools: offeredTools,
      requireFactTool: requireFactToolForDraft,
      onFactToolEnforced,
      executeTool: executeToolOk,
    });

    expect(seen).toHaveLength(2);
    expect(result.assistantText).toContain(COMPAT_SENTENCE);
    expect(onFactToolEnforced.mock.calls[0]?.[0]).toEqual({
      requiredTool: null,
      enforced: false,
      toolSucceeded: null,
    });
  });

  it('never forces twice — the enforcement pass has no pass of its own', async () => {
    const seen: Array<Record<string, unknown>> = [];
    // Every request answers with a draft that still makes the same unsupported claim.
    modelRef.current = recordingModel([answerChunks(COMPAT_SENTENCE)], seen);
    const onFactToolEnforced = vi.fn();

    await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'Can this go on linoleum?',
      tools: offeredTools,
      requireFactTool: requireFactToolForDraft,
      onFactToolEnforced,
      executeTool: executeToolOk,
    });

    // Draft + the single enforcement pass (which the model answered without calling the tool).
    expect(seen).toHaveLength(2);
    expect(onFactToolEnforced).toHaveBeenCalledTimes(1);
    expect(onFactToolEnforced.mock.calls[0]?.[0]).toMatchObject({
      requiredTool: 'list_allowed_surfaces',
      enforced: false,
      reason: 'model_declined_call',
    });
  });

  it('leaves the draft alone when this route does not offer the owning tool', async () => {
    const seen: Array<Record<string, unknown>> = [];
    modelRef.current = recordingModel([answerChunks(COMPAT_SENTENCE)], seen);
    const onFactToolEnforced = vi.fn();

    const result = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'Can this go on linoleum?',
      tools: [functionTool('search_product_docs')],
      requireFactTool: requireFactToolForDraft,
      onFactToolEnforced,
      executeTool: executeToolOk,
    });

    expect(seen).toHaveLength(1);
    expect(result.assistantText).toBe(COMPAT_SENTENCE);
    expect(onFactToolEnforced.mock.calls[0]?.[0]).toMatchObject({
      requiredTool: 'list_allowed_surfaces',
      enforced: false,
      reason: 'tool_not_offered',
    });
  });

  it('is inert for a caller that supplies no policy (every pre-B0-948 call site)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    modelRef.current = recordingModel([answerChunks(COMPAT_SENTENCE)], seen);

    const result = await runAiSdkWithToolLoop({
      instructions: 'You are Bex.',
      history: [],
      userMessage: 'Can this go on linoleum?',
      tools: offeredTools,
      executeTool: executeToolOk,
    });

    expect(seen).toHaveLength(1);
    expect(result.assistantText).toBe(COMPAT_SENTENCE);
  });
});
