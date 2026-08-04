import {
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolChoice,
  type ToolSet,
} from 'ai';

import { resolveAiSdkLanguageModel } from '~/lib/bex/ai-sdk-adapters';
import type {
  ExecuteToolFn,
  LlmTokenUsage,
  ResponsesRuntimeResult,
} from '~/lib/openai/responses-runtime';
import { productSupportTools } from '~/lib/tools/definitions';
import type { ToolTraceEntry } from '~/lib/audit/trace';

/**
 * A prior conversation turn replayed to the model. The AI SDK is stateless, so
 * replaying history here replaces the OpenAI Responses `previous_response_id` chain.
 */
export type AiSdkHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

/** Responses-style tool choice (what the workflow already computes), mapped to the AI SDK shape internally. */
export type ResponsesToolChoice =
  | 'auto'
  | 'required'
  | { type: 'function'; name: string };

export type AiSdkRuntimeOptions = {
  modelTag?: string;
  instructions: string;
  history: AiSdkHistoryMessage[];
  userMessage: string;
  toolChoice?: ResponsesToolChoice;
  /** B0-324 — see `ResponsesRuntimeOptions.promptCacheKey`; forwarded as the OpenAI `promptCacheKey`. */
  promptCacheKey?: string;
  maxToolRounds?: number;
  onAssistantDelta?: (delta: string) => void;
  executeTool: ExecuteToolFn;
};

/**
 * Same fields the workflow consumes from `runResponsesWithToolLoop`, minus the OpenAI-specific
 * `lastResponse`. `finalResponseId` is null because the AI SDK has no OpenAI response id — the
 * workflow substitutes a synthetic marker.
 */
export type AiSdkRuntimeResult = Pick<
  ResponsesRuntimeResult,
  'assistantText' | 'toolTrace' | 'responseIds' | 'usage' | 'usageByCall'
> & {
  finalResponseId: null;
};

/**
 * Build the AI SDK tool set from the same `productSupportTools` JSON Schema the model already sees,
 * reusing the existing `executeTool` boundary (`executeToolCall` → `executeProductTool`). Each tool's
 * trace is pushed into `toolTrace` to mirror `runResponsesWithToolLoop`.
 */
function buildAiSdkTools(executeTool: ExecuteToolFn, toolTrace: ToolTraceEntry[]): ToolSet {
  const tools: ToolSet = {};

  for (const definition of productSupportTools) {
    if (definition.type !== 'function') {
      continue;
    }

    tools[definition.name] = tool({
      description: definition.description ?? undefined,
      inputSchema: jsonSchema(
        (definition.parameters ?? { type: 'object', properties: {} }) as Parameters<
          typeof jsonSchema
        >[0],
      ),
      execute: async (args, { toolCallId }) => {
        const executed = await executeTool({
          name: definition.name,
          argumentsJson: JSON.stringify(args ?? {}),
          callId: toolCallId,
        });
        toolTrace.push(executed.trace);
        return executed.output;
      },
    });
  }

  return tools;
}

/**
 * B0-324 — cached (prompt-cache read) input tokens for one model call. Providers report this on
 * `inputTokenDetails.cacheReadTokens`; `cachedInputTokens` is the deprecated alias some providers
 * still populate. Mock/unsupported models report neither, hence the 0 fallback.
 */
function readCachedInputTokens(usage: LanguageModelUsage): number {
  return usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens ?? 0;
}

function mapToolChoice(toolChoice: ResponsesToolChoice | undefined): ToolChoice<ToolSet> {
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function') {
    return { type: 'tool', toolName: toolChoice.name };
  }
  if (toolChoice === 'required') {
    return 'required';
  }
  return 'auto';
}

/**
 * AI SDK generation runtime — a drop-in alternative to `runResponsesWithToolLoop`
 * (`~/lib/openai/responses-runtime`). Bounded automatic tool roundtrips come from
 * `stopWhen: stepCountIs(maxToolRounds)`; token deltas are surfaced via `onAssistantDelta`.
 */
export async function runAiSdkWithToolLoop(opts: AiSdkRuntimeOptions): Promise<AiSdkRuntimeResult> {
  const toolTrace: ToolTraceEntry[] = [];
  const tools = buildAiSdkTools(opts.executeTool, toolTrace);

  const messages: ModelMessage[] = [
    ...opts.history
      .filter((message) => message.content.trim().length > 0)
      .map((message): ModelMessage =>
        message.role === 'assistant'
          ? { role: 'assistant', content: message.content }
          : { role: 'user', content: message.content },
      ),
    { role: 'user', content: opts.userMessage },
  ];

  // Match the Responses runtime: force the tool choice on the first step only, then 'auto'.
  const forcedToolChoice = mapToolChoice(opts.toolChoice);
  const result = streamText({
    model: resolveAiSdkLanguageModel(opts.modelTag),
    system: opts.instructions,
    messages,
    tools,
    // B0-324 — pin every step of the loop to the same prompt cache pool so the stable
    // system + tool-schema prefix is read from cache on the 2nd+ step.
    ...(opts.promptCacheKey
      ? { providerOptions: { openai: { promptCacheKey: opts.promptCacheKey } } }
      : {}),
    stopWhen: stepCountIs(opts.maxToolRounds ?? 16),
    prepareStep: ({ stepNumber }) => ({
      toolChoice: stepNumber === 0 ? forcedToolChoice : 'auto',
    }),
  });

  // Always drain the stream so the result promises resolve; forward deltas when a sink is provided.
  for await (const delta of result.textStream) {
    opts.onAssistantDelta?.(delta);
  }

  const [assistantText, steps, totalUsage] = await Promise.all([
    result.text,
    result.steps,
    result.totalUsage,
  ]);

  const promptTokens = totalUsage.inputTokens ?? 0;
  const completionTokens = totalUsage.outputTokens ?? 0;
  // B0-324 — per-step usage makes prompt-cache reuse across the tool loop verifiable. The AI SDK
  // reports cache reads on `inputTokenDetails.cacheReadTokens` (`cachedInputTokens` is deprecated).
  const usageByCall: LlmTokenUsage[] = steps.map((step): LlmTokenUsage => {
    const stepPromptTokens = step.usage.inputTokens ?? 0;
    const stepCompletionTokens = step.usage.outputTokens ?? 0;
    return {
      promptTokens: stepPromptTokens,
      completionTokens: stepCompletionTokens,
      totalTokens: step.usage.totalTokens ?? stepPromptTokens + stepCompletionTokens,
      cachedPromptTokens: readCachedInputTokens(step.usage),
    };
  });

  return {
    assistantText,
    finalResponseId: null,
    toolTrace,
    responseIds: steps.map((_step, index) => `ai_sdk_step_${index}`),
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: totalUsage.totalTokens ?? promptTokens + completionTokens,
      cachedPromptTokens:
        readCachedInputTokens(totalUsage) ||
        usageByCall.reduce((sum, call) => sum + call.cachedPromptTokens, 0),
    },
    usageByCall,
  };
}
