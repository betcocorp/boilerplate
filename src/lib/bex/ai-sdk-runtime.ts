import {
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  wrapLanguageModel,
  type LanguageModelMiddleware,
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
import {
  classifyTransportError,
  retryTransportFaults,
  type TransportRetryTuning,
} from '~/lib/openai/transport-retry';
import { logError } from '~/lib/observability/logger';
import { productSupportTools } from '~/lib/tools/definitions';
import { getErrorMessage } from '~/lib/utils';
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
  /**
   * B0-370 — tuning for the bounded transport retry around each model request. Defaults are fine in
   * production; tests inject `sleep`/`random` to keep the suite fast and deterministic.
   */
  retry?: TransportRetryTuning;
  onAssistantDelta?: (delta: string) => void;
  /**
   * B0-429 — measurement-only token observer (TTFT), mirroring `ResponsesRuntimeOptions`. This
   * runtime always streams and always drains `textStream`, so observing costs nothing here; the
   * option exists so the workflow can record TTFT identically on both runtimes.
   */
  observeAssistantDelta?: (delta: string) => void;
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

/** The `{ stream, request, response, ... }` object a provider's `doStream` resolves to. */
type ModelStreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware['wrapStream']>>>;
type ModelStreamChunk =
  ModelStreamResult['stream'] extends ReadableStream<infer Chunk> ? Chunk : never;

/**
 * B0-370 — pulls the first chunk before handing the stream to `streamText`, then replays it at the
 * head of an equivalent stream.
 *
 * This is what makes the retry boundary exact. A transport fault can surface either while the
 * request is being made (`doStream` rejects) or after headers but before the first token (the
 * stream errors / emits an `error` part). Peeking converts the second case into a rejection *while
 * nothing has been forwarded to `streamText` yet*, so the retry is still pre-emission. Once the
 * first chunk is handed over, this function is out of the picture and no retry can happen.
 */
async function startModelStreamOrThrow(result: ModelStreamResult): Promise<ModelStreamResult> {
  const reader = result.stream.getReader();

  let first: ReadableStreamReadResult<ModelStreamChunk>;
  try {
    first = await reader.read();
  } catch (err) {
    reader.releaseLock();
    throw err;
  }

  // A provider can report a mid-stream fault as an `error` part rather than by rejecting. When that
  // is the very first thing on the stream, nothing is emitted yet, so a transport fault there is
  // still safely retryable — rethrow it so the retry wrapper decides.
  if (
    !first.done &&
    first.value.type === 'error' &&
    classifyTransportError(first.value.error).retryable
  ) {
    void reader.cancel().catch(() => undefined);
    throw first.value.error;
  }

  const stream = new ReadableStream<ModelStreamChunk>({
    start(controller) {
      if (first.done) {
        controller.close();
        return;
      }
      controller.enqueue(first.value);
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return { ...result, stream };
}

/**
 * B0-370 — retry boundary: **one model request (`doStream`) inside the tool loop.**
 *
 * Why this cannot duplicate a tool call: `streamText` executes tools in its own step machinery,
 * *after* a step's model stream has yielded the tool-call parts. Middleware sits strictly below
 * that — it only re-issues the HTTP request for the current step. A retried request re-sends the
 * identical prepared prompt (`params`), which already contains the tool results of every completed
 * step as plain messages, and our `execute` closures are never re-invoked. Because this runtime is
 * stateless (history is replayed rather than chained through `previous_response_id`), there is also
 * no server-side response chain that a replay could desynchronise.
 *
 * Retrying the whole `streamText` call instead would re-run every tool from step 0 — which is
 * exactly the duplication the ticket warns about, and why the boundary is here.
 */
function createTransportRetryMiddleware(
  tuning: TransportRetryTuning | undefined,
): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    wrapStream: async ({ doStream }) =>
      retryTransportFaults(async () => startModelStreamOrThrow(await doStream()), {
        runtime: 'ai_sdk',
        label: 'streamText.doStream',
        ...tuning,
      }),
  };
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
  /**
   * B0-370 — `streamText` does not reject with the provider's error: it reports the error through
   * `onError` and then fails its result promises with the opaque
   * `AI_NoOutputGeneratedError: No output generated. Check the stream for errors.` (with no `cause`).
   * Capturing it here is what lets the real fault — including the retry-able wording from an
   * exhausted `UpstreamTransportError` — reach the workflow instead of that placeholder.
   */
  let capturedStreamError: unknown;
  const result = streamText({
    model: wrapLanguageModel({
      model: resolveAiSdkLanguageModel(opts.modelTag),
      middleware: createTransportRetryMiddleware(opts.retry),
    }),
    system: opts.instructions,
    messages,
    tools,
    /**
     * B0-370 — the middleware above owns the retry policy. The AI SDK's own default is 2 retries
     * per model request, which would stack multiplicatively with ours (3 × 3 = 9 upstream
     * attempts) and uses unjittered exponential backoff from a 2s base.
     */
    maxRetries: 0,
    // B0-324 — pin every step of the loop to the same prompt cache pool so the stable
    // system + tool-schema prefix is read from cache on the 2nd+ step.
    ...(opts.promptCacheKey
      ? { providerOptions: { openai: { promptCacheKey: opts.promptCacheKey } } }
      : {}),
    stopWhen: stepCountIs(opts.maxToolRounds ?? 16),
    prepareStep: ({ stepNumber }) => ({
      toolChoice: stepNumber === 0 ? forcedToolChoice : 'auto',
    }),
    onError: ({ error }) => {
      capturedStreamError = error;
      // Replaces the AI SDK's default console.error so the fault stays in the structured log.
      logError('ai_sdk_stream_error', { message: getErrorMessage(error) });
    },
  });

  let assistantText: string;
  let steps: Awaited<typeof result.steps>;
  let totalUsage: LanguageModelUsage;
  try {
    // Always drain the stream so the result promises resolve; forward deltas when a sink is provided.
    for await (const delta of result.textStream) {
      opts.onAssistantDelta?.(delta);
      opts.observeAssistantDelta?.(delta);
    }

    [assistantText, steps, totalUsage] = await Promise.all([
      result.text,
      result.steps,
      result.totalUsage,
    ]);
  } catch (err) {
    // Prefer the captured provider error over `NoOutputGeneratedError` (see `capturedStreamError`).
    throw capturedStreamError ?? err;
  }

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
