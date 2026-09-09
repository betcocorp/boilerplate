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
import { modelProviderFor } from '~/lib/constants/models';
import {
  collectRetrievalEvidenceIds,
  formatPreloadedEvidence,
  isCorpusSearchPayload,
  RETRIEVAL_EXHAUSTED_INSTRUCTION,
  RETRIEVAL_TOOL_NAMES,
  TOOL_ROUNDS_EXHAUSTED_FALLBACK_TEXT,
  TOOL_ROUNDS_EXHAUSTED_INSTRUCTION,
  UNPRODUCTIVE_RETRIEVAL_CALL_LIMIT,
} from '~/lib/openai/responses-runtime';
import type {
  ExecuteToolFn,
  LlmTokenUsage,
  PreloadedEvidence,
  ReplayedHistoryMessage,
  ResponsesRuntimeResult,
} from '~/lib/openai/responses-runtime';
import {
  classifyTransportError,
  retryTransportFaults,
  type TransportRetryTuning,
} from '~/lib/openai/transport-retry';
import { logError, logWarn } from '~/lib/observability/logger';
import { productSupportTools } from '~/lib/tools/definitions';
import { getErrorMessage } from '~/lib/utils';
import type { ToolTraceEntry } from '~/lib/audit/trace';
import type { Tool } from 'openai/resources/responses/responses';

/**
 * A prior conversation turn replayed to the model. The AI SDK is stateless, so
 * replaying history here replaces the OpenAI Responses `previous_response_id` chain.
 *
 * B0-378 — now the same type both runtimes replay (`ReplayedHistoryMessage`), including the
 * optional `toolContext` summary. Before this ticket the AI SDK path replayed user/assistant TEXT
 * only, so every prior turn's tool activity vanished from context while the Responses chain kept
 * it — the same conversation could answer differently depending on which runtime ran it.
 */
export type AiSdkHistoryMessage = ReplayedHistoryMessage;

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
  /**
   * B0-437 — tool schemas to expose, so the caller can send a route-scoped subset instead of all 14.
   * Defaults to the full `productSupportTools`.
   */
  tools?: Tool[];
  /**
   * B0-324 — see `ResponsesRuntimeOptions.promptCacheKey`. The caller's statement that this loop's
   * stable prefix (instructions + tool schemas) should be prompt-cached across steps, mapped to
   * whichever mechanism the provider has:
   *   - OpenAI: forwarded verbatim as `providerOptions.openai.promptCacheKey` (B0-908).
   *   - Anthropic (B0-900): the Anthropic API has no cache KEY — caching is by exact prefix — so the
   *     key's VALUE is never sent. Its presence turns on `providerOptions.anthropic.cacheControl`
   *     (`{ type: 'ephemeral' }`), which `@ai-sdk/anthropic` 3.0.116 emits as the request-level
   *     `cache_control` (automatic caching: Anthropic places the breakpoint at the end of the prompt
   *     itself, so on the 2nd+ step the whole tools + system + prior-steps prefix is a cache read).
   * Omitted entirely → nothing cache-related is sent to either provider.
   */
  promptCacheKey?: string;
  /**
   * B0-436 — see `ResponsesRuntimeOptions.preloadedEvidence`. This runtime is stateless, so the
   * evidence is simply the last message of the initial prompt; `streamText` carries it forward into
   * later steps by itself.
   */
  preloadedEvidence?: PreloadedEvidence;
  maxToolRounds?: number;
  /** B0-459 — see `ResponsesRuntimeOptions.maxOutputTokens`; forwarded as `streamText`'s `maxOutputTokens`. */
  maxOutputTokens?: number;
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
  /** B0-901 — see `ResponsesRuntimeOptions.onToolRoundsExhausted`. Same contract on both loops. */
  onToolRoundsExhausted?: (info: { maxToolRounds: number; pendingCallCount: number }) => void;
  /** B0-901 — see `ResponsesRuntimeOptions.onRetrievalExhausted`. Same contract on both loops. */
  onRetrievalExhausted?: (info: {
    unproductiveCallCount: number;
    seenEvidenceIdCount: number;
    round: number;
  }) => void;
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
 * B0-901 — the B0-635 unproductive-retrieval state, mutated as each tool result lands and read by
 * `prepareStep` when it prepares the next step. Same three facts the Responses loop keeps in local
 * variables; an object because the scoring happens inside the tool `execute` closures.
 */
type RetrievalProductivityState = {
  /** Every evidence id the run has already been given, across all retrieval calls. */
  seenEvidenceIds: Set<string>;
  /** Consecutive retrieval calls that returned nothing new; reset by any productive call. */
  consecutiveUnproductiveCalls: number;
  /** Latched once the limit is hit; retrieval tools stay withdrawn for the rest of the run. */
  withdrawn: boolean;
  /** Set with `withdrawn`, consumed by the very next step so the model is told exactly once. */
  noticePending: boolean;
};

function newRetrievalProductivityState(): RetrievalProductivityState {
  return {
    seenEvidenceIds: new Set<string>(),
    consecutiveUnproductiveCalls: 0,
    withdrawn: false,
    noticePending: false,
  };
}

/**
 * B0-901 / B0-635 — scores one retrieval call exactly as the Responses loop does
 * (`responses-runtime.ts`, "productivity of THIS retrieval call"): reads the FULL tool payload, not
 * the slimmed `modelOutput` the model sees, because the projection drops
 * `documentBodyChunkIds` when it truncates a body and this decision must be made on what was
 * actually retrieved. Ids are added to the run-wide set as each call is scored, so within a
 * parallel round the second of two calls returning the same documents scores as adding nothing.
 */
function scoreRetrievalCall(
  state: RetrievalProductivityState,
  toolName: string,
  fullOutput: string,
): void {
  if (state.withdrawn || !RETRIEVAL_TOOL_NAMES.has(toolName)) {
    return;
  }

  const ids = collectRetrievalEvidenceIds(fullOutput);
  const producedSomethingNew = ids.some((id) => !state.seenEvidenceIds.has(id));
  for (const id of ids) {
    state.seenEvidenceIds.add(id);
  }

  if (producedSomethingNew) {
    state.consecutiveUnproductiveCalls = 0;
  } else if (isCorpusSearchPayload(fullOutput)) {
    // Only a fruitless corpus SEARCH counts toward exhaustion. An empty structured-fact lookup is
    // neutral — see `isCorpusSearchPayload`.
    state.consecutiveUnproductiveCalls += 1;
  }
}

/**
 * Build the AI SDK tool set from the same `productSupportTools` JSON Schema the model already sees,
 * reusing the existing `executeTool` boundary (`executeToolCall` → `executeProductTool`). Each tool's
 * trace is pushed into `toolTrace` to mirror `runResponsesWithToolLoop`.
 *
 * B0-901 — also scores each retrieval result into `retrieval` on the way past. The scoring lives
 * here rather than in `prepareStep` because this is the only place the FULL payload exists: the
 * step results `prepareStep` can see carry the slimmed `modelOutput`, and the `toolTrace` preview is
 * truncated at 4,000 chars.
 */
function buildAiSdkTools(
  executeTool: ExecuteToolFn,
  toolTrace: ToolTraceEntry[],
  definitions: Tool[],
  retrieval: RetrievalProductivityState,
): ToolSet {
  const tools: ToolSet = {};

  for (const definition of definitions) {
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
        // B0-901 — scored on the full payload, in the model's own call order, before the slimmed
        // variant is handed back. Mirrors the ordering in the Responses loop (trace, then score).
        scoreRetrievalCall(retrieval, definition.name, executed.output);
        // B0-437 — the model gets the slimmed variant when the tool produced one; the caller's
        // closure has already logged the full payload for the validator / guardrail.
        return executed.modelOutput ?? executed.output;
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
  // B0-901 — the tool budget, resolved once; the stop condition allows one extra forced-answer
  // step on top of it, mirroring the Responses loop's post-loop final request.
  const maxToolRounds = opts.maxToolRounds ?? 16;
  const retrieval = newRetrievalProductivityState();
  let toolRoundsExhaustedReported = false;
  const tools = buildAiSdkTools(
    opts.executeTool,
    toolTrace,
    opts.tools ?? productSupportTools,
    retrieval,
  );

  const messages: ModelMessage[] = [
    ...opts.history
      .filter((message) => message.content.trim().length > 0)
      .flatMap((message): ModelMessage[] =>
        message.role === 'assistant'
          ? [
              { role: 'assistant', content: message.content },
              /**
               * B0-378 — the prior turn's tool activity, replayed as its own message right after the
               * assistant turn it describes. This is a SUMMARY (tool names + retrieved document
               * titles), NOT the real tool-call/tool-result parts: the persisted message only stores
               * `toolSummary` and `sources`, so genuine parts would require fabricating tool-call ids
               * and passing off a truncated preview as the full payload. See `PriorTurnToolContext`.
               *
               * Emitted as a `user` message rather than a mid-conversation `system` one, matching how
               * both runtimes already inject the B0-436 preloaded-evidence block.
               */
              ...(message.toolContext?.trim()
                ? [{ role: 'user' as const, content: message.toolContext }]
                : []),
            ]
          : [{ role: 'user', content: message.content }],
      ),
    { role: 'user', content: opts.userMessage },
    // B0-436 — appended AFTER the user message, matching the Responses runtime's round-1 input.
    ...(opts.preloadedEvidence
      ? [
          {
            role: 'user' as const,
            content: formatPreloadedEvidence(opts.preloadedEvidence),
          },
        ]
      : []),
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
  /**
   * B0-908 — provider-aware: the resolved model decides which provider serves it (`claude-*` →
   * Anthropic, else OpenAI), read off the model's own id so it cannot disagree with the adapter.
   * Anthropic models get NO sampling controls (Opus 5 / Sonnet 5 reject `temperature`/`top_p`) and
   * NO thinking config (adaptive is the Opus 5 default; Haiku 4.5 rejects it) — provider defaults
   * apply, and every OpenAI-only request field below is gated on `provider`.
   */
  const languageModel = await resolveAiSdkLanguageModel(opts.modelTag);
  const provider = modelProviderFor(languageModel.modelId);
  const result = streamText({
    model: wrapLanguageModel({
      model: languageModel,
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
    // B0-459 — see `ResponsesRuntimeOptions.maxOutputTokens`; omitted (rather than `undefined`) so a
    // caller that does not pass one gets the AI SDK/provider default, matching the Responses runtime.
    ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    // B0-324 — pin every step of the loop to the same prompt cache pool so the stable
    // system + tool-schema prefix is read from cache on the 2nd+ step. Provider-specific (B0-908 /
    // B0-900): OpenAI takes the key itself; Anthropic has no key, so the key's presence enables the
    // request-level `cache_control` breakpoint instead (see `promptCacheKey`'s doc comment).
    ...(opts.promptCacheKey && provider === 'openai'
      ? { providerOptions: { openai: { promptCacheKey: opts.promptCacheKey } } }
      : {}),
    ...(opts.promptCacheKey && provider === 'anthropic'
      ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }
      : {}),
    /**
     * B0-901 / B0-381 — `maxToolRounds` tool-calling steps PLUS one forced-answer step, mirroring
     * the Responses loop, whose `for` runs `maxRounds` times and then makes one extra
     * `tool_choice: 'none'` request when the model is still asking for tools. The extra step only
     * materialises on that pathological path: a run that produces text inside its budget ends when
     * the model stops calling tools, exactly as before.
     */
    stopWhen: stepCountIs(maxToolRounds + 1),
    prepareStep: ({ stepNumber, messages: stepMessages }) => {
      /**
       * B0-901 / B0-381 — the budget is spent and the model is still calling tools (any step that
       * produced text would have ended the loop). Force the answer with `toolChoice: 'none'` and
       * the same instruction the Responses loop sends.
       *
       * One documented divergence: the Responses loop skips executing the tools requested on the
       * final round and answers each pending call with `TOOL_ROUNDS_EXHAUSTED_TOOL_OUTPUT`. Here the
       * AI SDK owns tool execution inside the step, so by the time this hook runs those calls have
       * already executed and their real outputs are in the message list. The model-visible
       * INSTRUCTION is byte-identical, which is what an A/B compares; the pathological run just
       * pays for one extra round of tools it did not need.
       */
      if (stepNumber >= maxToolRounds) {
        if (!toolRoundsExhaustedReported) {
          toolRoundsExhaustedReported = true;
          logWarn('tool_rounds_exhausted', {
            model: languageModel.modelId,
            max_tool_rounds: maxToolRounds,
            runtime: 'ai_sdk',
          });
          opts.onToolRoundsExhausted?.({ maxToolRounds, pendingCallCount: 0 });
        }
        return {
          toolChoice: 'none',
          messages: [
            ...stepMessages,
            { role: 'user' as const, content: TOOL_ROUNDS_EXHAUSTED_INSTRUCTION },
          ],
        };
      }

      /**
       * B0-901 / B0-635 — retrieval has stopped producing information. Withdraw the retrieval tools
       * for the rest of the run (`activeTools` = everything else) and tell the model why, once, in
       * the same words the Responses loop uses. Round 0 can never be withdrawn: nothing has been
       * retrieved yet, so the forced first-step tool choice is always still honoured.
       */
      if (!retrieval.withdrawn && retrieval.consecutiveUnproductiveCalls >= UNPRODUCTIVE_RETRIEVAL_CALL_LIMIT) {
        retrieval.withdrawn = true;
        retrieval.noticePending = true;
        logWarn('retrieval_exhausted_early_stop', {
          model: languageModel.modelId,
          runtime: 'ai_sdk',
          step: stepNumber,
          unproductive_call_count: retrieval.consecutiveUnproductiveCalls,
          seen_evidence_id_count: retrieval.seenEvidenceIds.size,
        });
        opts.onRetrievalExhausted?.({
          unproductiveCallCount: retrieval.consecutiveUnproductiveCalls,
          seenEvidenceIdCount: retrieval.seenEvidenceIds.size,
          round: stepNumber,
        });
      }

      if (!retrieval.withdrawn) {
        return { toolChoice: stepNumber === 0 ? forcedToolChoice : 'auto' };
      }

      const remainingTools = Object.keys(tools).filter(
        (name) => !RETRIEVAL_TOOL_NAMES.has(name),
      );
      const noticeDue = retrieval.noticePending;
      retrieval.noticePending = false;

      return {
        activeTools: remainingTools,
        // Nothing left to call (every offered tool was a retrieval tool) — say so explicitly rather
        // than sending 'auto' against an empty tool list, matching the Responses loop.
        toolChoice: remainingTools.length === 0 ? 'none' : 'auto',
        ...(noticeDue
          ? {
              messages: [
                ...stepMessages,
                { role: 'user' as const, content: RETRIEVAL_EXHAUSTED_INSTRUCTION },
              ],
            }
          : {}),
      };
    },
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
    /**
     * B0-901 / B0-381 — exhaustion must never surface an empty answer. Only substituted on the
     * exhausted path (and only when the forced final step still produced no text), so a normal run
     * that legitimately returns empty text is unchanged. Same string the Responses loop uses.
     */
    assistantText:
      toolRoundsExhaustedReported && !assistantText.trim()
        ? TOOL_ROUNDS_EXHAUSTED_FALLBACK_TEXT
        : assistantText,
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
