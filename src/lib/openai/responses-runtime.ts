import type OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  Tool,
} from 'openai/resources/responses/responses';
import type { ResponseInputItem } from 'openai/resources/responses/responses';

import { modelProviderFor } from '~/lib/constants/models';
import { extractAssistantText, extractFunctionCalls } from '~/lib/openai/response-item-parsing';
import {
  DEFAULT_GENERATION_TEMPERATURE,
  isTemperatureUnsupportedError,
  recordTemperatureRejection,
  samplingParamsFor,
} from '~/lib/openai/model-capabilities';
import {
  resolveOpenAiRequestTimeoutMs,
  retryTransportFaults,
  type TransportRetryTuning,
} from '~/lib/openai/transport-retry';
import { logWarn } from '~/lib/observability/logger';
import { getErrorMessage } from '~/lib/utils';
import type { ToolTraceEntry } from '~/lib/audit/trace';
import {
  RETRIEVAL_EXHAUSTED_INSTRUCTION,
  RETRIEVAL_TOOL_NAMES,
  TOOL_ROUNDS_EXHAUSTED_FALLBACK_TEXT,
  TOOL_ROUNDS_EXHAUSTED_INSTRUCTION,
  UNPRODUCTIVE_RETRIEVAL_CALL_LIMIT,
  collectRetrievalEvidenceIds,
  formatPreloadedEvidence,
  isCorpusSearchPayload,
} from '~/lib/llm/generation-shared';
import type {
  ExecuteToolFn,
  FactToolEnforcementOutcome,
  FactToolRequirementCheck,
  LlmTokenUsage,
  PreloadedEvidence,
  ReplayedHistoryMessage,
} from '~/lib/llm/generation-shared';


export type ResponsesRuntimeOptions = {
  client: OpenAI;
  model: string;
  instructions: string;
  tools: Tool[];
  userMessage: string;
  /** Prior completed response id for multi-turn chaining (per conversation). */
  previousResponseId?: string | null;
  /**
   * B0-519 — prior conversation turns to replay as explicit messages instead of chaining via
   * `previousResponseId`. Used ONLY when the caller intentionally omits `previousResponseId`
   * (`null`/`undefined`) to break an over-grown chain — see `capConversationHistory` in
   * `~/lib/workflows/product-support/run-product-support-workflow`. Ignored when a
   * `previousResponseId` IS given: the server already remembers that conversation, so replaying it
   * again here would duplicate it inside the chain. Injected into round 1's `input` only, same as
   * `preloadedEvidence` — later rounds send `toolOutputs` instead.
   *
   * B0-378 — each message may carry a `toolContext` summary, replayed as its own message item
   * directly after the assistant turn it describes. On this runtime that only ever applies to the
   * chain-broken case above: when a real `previousResponseId` IS chained, the server already holds
   * the prior turns' genuine tool calls and outputs, so nothing is summarised or injected.
   */
  history?: ReplayedHistoryMessage[];
  maxToolRounds?: number;
  temperature?: number;
  toolChoice?: ResponseCreateParamsNonStreaming['tool_choice'];
  /**
   * B0-512 — the B0-503 LLM intent classifier's suggested first tool call, threaded in as a hint
   * for round 0's `tool_choice`. Optional and additive, same pattern as `history` (B0-519): omit
   * it and round 0 behaves exactly as it did before this ticket.
   *
   * This is a BIAS, not a hard override — it only ever replaces the GENERIC `'required'`
   * tool_choice (some tool must be called, but the model was otherwise free to pick which) with a
   * named-function pin toward the classifier's pick. It never touches:
   *  - an already-pinned named-function `toolChoice` (the forced cross-reference/recommendations
   *    path in `run-product-support-workflow.ts` sets this explicitly — that forcing must win), or
   *  - an explicit `'auto'` (the B0-436 preloaded-evidence path sets this deliberately, to avoid
   *    forcing a wasted extra tool round when evidence is already in hand).
   * See `resolveRoundZeroToolChoice`.
   */
  suggestedFirstTool?: { name: string; confidence: number } | null;
  /**
   * B0-459 — hard backstop on assistant output length (`max_output_tokens`). Decode time scales
   * linearly with output tokens and was measured at ~85% of total turn time, so this bounds a
   * runaway generation independent of the prompt's own brevity instructions. Generous by design
   * (not the ~250-token target for a simple question) so a legitimate multi-section answer is never
   * cut off mid-value — see `resolveMaxOutputTokens` in `~/lib/workflows/product-support/run-product-support-workflow`.
   */
  maxOutputTokens?: number;
  /**
   * B0-324 — `prompt_cache_key` routes every request sharing the same stable prefix
   * (instructions + tool schemas) to the same cache pool. Without it, identical prompts are
   * load-balanced across machines and OpenAI's automatic prompt caching mostly misses; with it,
   * the 2nd+ call in a tool loop reads the prefix from cache. Must be identical for all calls
   * that share a prefix, and must NOT contain per-request values (run id, timestamp, user text).
   */
  promptCacheKey?: string;
  /**
   * B0-436 — speculatively retrieved evidence for round 1 only. Later rounds send `toolOutputs`, so
   * injecting it again would duplicate it inside the `previous_response_id` chain.
   */
  preloadedEvidence?: PreloadedEvidence;
  /**
   * B0-370 — tuning for the bounded transport retry around each model request. Defaults are fine in
   * production; tests inject `sleep`/`random` to keep the suite fast and deterministic.
   */
  retry?: TransportRetryTuning;
  onRawResponse?: (response: Response) => void;
  /**
   * Caller-visible token sink: whatever is written here has been shown to someone and cannot be
   * retracted, which is why an emission to it closes the retry window (see `canRetry` below).
   */
  onAssistantDelta?: (delta: string) => void;
  /**
   * B0-429 — measurement-only token observer (TTFT). Like `onAssistantDelta` its presence makes
   * this runtime stream, so the first token is observable on *every* run rather than only on runs
   * whose caller wants deltas. Unlike it, an emission here does NOT close the retry window: nothing
   * was shown to anyone, so a replay cannot duplicate visible text.
   */
  observeAssistantDelta?: (delta: string) => void;
  /**
   * B0-381 — invoked once when the loop reaches `maxToolRounds` with the model still requesting
   * tools, right before the forced final answer request. Hook for callers that want to record the
   * event (e.g. an `audit_logs` row); the runtime itself has no audit context, so it only emits a
   * structured log.
   */
  onToolRoundsExhausted?: (info: { maxToolRounds: number; pendingCallCount: number }) => void;
  /**
   * B0-635 — invoked once, at the moment retrieval tools are withdrawn because
   * `UNPRODUCTIVE_RETRIEVAL_CALL_LIMIT` consecutive retrieval calls returned no evidence id the run
   * had not already seen. Same shape of hook as `onToolRoundsExhausted`: the runtime has no audit
   * context, so it only emits a structured log of its own.
   */
  onRetrievalExhausted?: (info: {
    /** How many consecutive retrieval calls produced nothing new (always the limit). */
    unproductiveCallCount: number;
    /** Distinct evidence ids gathered across the whole run at the moment of withdrawal. */
    seenEvidenceIdCount: number;
    /** 1-based tool round the withdrawal was decided on. */
    round: number;
  }) => void;
  /** B0-948 — see `FactToolRequirementCheck`. Omitted → this runtime behaves exactly as before. */
  requireFactTool?: FactToolRequirementCheck;
  /** B0-948 — fires exactly once per run when `requireFactTool` is supplied. */
  onFactToolEnforced?: (outcome: FactToolEnforcementOutcome) => void;
  executeTool: ExecuteToolFn;
};

/** LLM token usage summed across every model call in a run (B0-117 cost attribution). */
/** B0-563 — the one place `Response.usage` is mapped to `LlmTokenUsage`, reused by every other model-calling call site (intent classifier, competitor extraction) so a step's usage is directly comparable to this runtime's. */
export function usageFromResponse(response: Response): LlmTokenUsage {
  return {
    promptTokens: response.usage?.input_tokens ?? 0,
    completionTokens: response.usage?.output_tokens ?? 0,
    totalTokens: response.usage?.total_tokens ?? 0,
    cachedPromptTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
  };
}

export type ResponsesRuntimeResult = {
  lastResponse: Response;
  finalResponseId: string;
  assistantText: string;
  toolTrace: ToolTraceEntry[];
  responseIds: string[];
  usage: LlmTokenUsage;
  /** B0-324 — per-model-call usage, in call order, so prompt-cache reuse per round is verifiable. */
  usageByCall: LlmTokenUsage[];
};

/**
 * B0-512 — minimum classifier confidence before `suggestedFirstTool` is allowed to bias round 0's
 * `tool_choice`. `0.6` matches `LOW_SIMILARITY_THRESHOLD` (`~/lib/recommendations/recommendation-gate.ts`)
 * — the "reasonably confident" bar already established elsewhere in this codebase for a 0-1
 * classifier score, rather than inventing a new number for this one call site.
 */
export const DEFAULT_SUGGESTED_TOOL_MIN_CONFIDENCE = 0.6;

/**
 * B0-512 — round 0's `tool_choice`, biased by the classifier's `suggestedFirstTool` when eligible.
 *
 * Eligible means ALL of:
 *  - the caller's own `toolChoice` resolves to the generic `'required'` (no speculative evidence
 *    was preloaded, and this is not a forced cross-reference/recommendations turn — see the
 *    `suggestedFirstTool` doc comment above for why `'auto'` and a named-function pin are excluded);
 *  - a suggestion was actually supplied;
 *  - its confidence clears `DEFAULT_SUGGESTED_TOOL_MIN_CONFIDENCE`;
 *  - its tool name is one of the tools actually offered this round (a stale/mismatched suggestion
 *    must never be sent as a `tool_choice` the API doesn't recognize).
 * Otherwise the caller's own `toolChoice` (or the existing `'auto'` default) passes through
 * unchanged.
 */
function resolveRoundZeroToolChoice(
  opts: Pick<ResponsesRuntimeOptions, 'toolChoice' | 'suggestedFirstTool' | 'tools'>,
): ResponseCreateParamsNonStreaming['tool_choice'] {
  const base = opts.toolChoice ?? 'auto';
  if (base !== 'required') {
    return base;
  }

  const suggestion = opts.suggestedFirstTool;
  if (!suggestion || suggestion.confidence < DEFAULT_SUGGESTED_TOOL_MIN_CONFIDENCE) {
    return base;
  }

  const toolExists = opts.tools.some((tool) => 'name' in tool && tool.name === suggestion.name);
  if (!toolExists) {
    return base;
  }

  return { type: 'function', name: suggestion.name };
}

/**
 * B0-381 — synthetic `function_call_output` for tool calls requested on the final round, which are
 * deliberately NOT executed (their outputs could never inform another tool choice, only the final
 * answer, and executing them would add a whole tool round to an already-pathological run). Sending
 * these keeps the `previous_response_id` chain valid: every pending `function_call` gets an output.
 */
export const TOOL_ROUNDS_EXHAUSTED_TOOL_OUTPUT = JSON.stringify({
  ok: false,
  error:
    'Tool-call limit reached for this turn; this call was not executed. Answer from the evidence already gathered.',
});

export async function runResponsesWithToolLoop(
  opts: ResponsesRuntimeOptions,
): Promise<ResponsesRuntimeResult> {
  /**
   * B0-899 — this loop IS the OpenAI Responses API; a Claude id has no route through it. The
   * workflow already forks on `modelProviderFor` before choosing a runtime (B0-908), so this is a
   * guard against a caller that resolved a model and picked the loop by hand — failing here, before
   * any request or tool call is paid for, beats a 404 from OpenAI for an unknown model id.
   */
  if (modelProviderFor(opts.model) === 'anthropic') {
    throw new Error(
      `Model "${opts.model}" is an Anthropic (claude-*) id and cannot run on the OpenAI Responses ` +
        'loop; claude ids must run on the AI SDK loop (runAiSdkWithToolLoop, ~/lib/bex/ai-sdk-runtime).',
    );
  }

  const maxRounds = opts.maxToolRounds ?? 16;
  const toolTrace: ToolTraceEntry[] = [];
  const responseIds: string[] = [];

  // B0-429 — either sink needs token events, so either one selects the streaming transport.
  const wantsTokenEvents = Boolean(opts.onAssistantDelta || opts.observeAssistantDelta);

  let chainPrev: string | undefined = opts.previousResponseId?.trim() || undefined;
  let toolOutputs: ResponseInputItem[] | null = null;

  /**
   * B0-635 — early stop for retrieval that has stopped producing information.
   *
   * `maxRounds` (16) bounds a runaway loop but never engaged on the pathological runs: the model
   * stopped on its own after 7 calls, having spent the last two on progressively broader generic
   * queries that returned already-seen or unrelated documents. The signal used here is deliberately
   * the objective one — "this call yielded zero evidence ids the run had not already seen" — never
   * query-text similarity, embedding distance, or any guess at intent.
   */
  const seenEvidenceIds = new Set<string>();
  let consecutiveUnproductiveRetrievalCalls = 0;
  let retrievalWithdrawn = false;
  /** Set with `retrievalWithdrawn`, consumed by the very next request so the model is told why. */
  let retrievalExhaustedNoticePending = false;

  /**
   * B0-948 — fact-tool enforcement state. `factToolCheckUsed` latches on the FIRST finished draft,
   * so the policy is consulted at most once and the loop can never re-force: one extra round-trip
   * per turn, never a loop.
   */
  let factToolCheckUsed = false;
  /** The forced call to make on the NEXT request; consumed by it (same shape as the notice above). */
  let pendingFactToolEnforcement: { toolName: string; instruction: string } | null = null;
  // B0-984 — the finished draft that opened the forced round, reported on its outcome.
  let preEnforcementDraft: string | null = null;
  /** The forcing whose round is executing right now; consumed when that round's tools return. */
  let activeFactToolEnforcement: { toolName: string } | null = null;
  /**
   * B0-948 — latched with the forcing: the first draft has already been streamed to the caller and
   * cannot be retracted, so the re-draft that replaces it must NOT be appended to the visible
   * stream. The turn's returned/persisted `assistantText` is the re-draft — the same
   * streamed-text-vs-final-answer reconciliation the regulated-claim guardrail's decline already
   * relies on. The measurement-only observer keeps seeing everything.
   */
  let suppressVisibleDeltas = false;

  const usage: LlmTokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
  };
  const usageByCall: LlmTokenUsage[] = [];
  const accumulateUsage = (response: Response) => {
    const call = usageFromResponse(response);
    usageByCall.push(call);
    usage.promptTokens += call.promptTokens;
    usage.completionTokens += call.completionTokens;
    usage.totalTokens += call.totalTokens;
    usage.cachedPromptTokens += call.cachedPromptTokens;
  };

  /**
   * B0-370 — retry boundary: **one model request, within a single loop iteration.**
   *
   * Why this cannot duplicate a tool call, even though this path is stateful:
   * 1. `params` is built by the caller, never mutated, and replayed identically —
   *    `previous_response_id` included.
   *    A failed attempt never returned a response, so `chainPrev` is still the same id — the
   *    replay resumes from exactly the server-side state the failed attempt targeted, so the
   *    provider does not re-run anything on its side either.
   * 2. Tools for a round run strictly *after* this await resolves. At retry time no tool of
   *    that round has executed, and earlier rounds are never re-entered (the loop only moves
   *    forward), so no tool side effect exists to repeat.
   * 3. Every piece of accumulated state (`accumulateUsage`, `responseIds.push`, `chainPrev`,
   *    `toolOutputs`) is mutated only after success, so a retry cannot double-count usage or
   *    push a duplicate response id.
   *
   * `maxRetries: 0` disables the OpenAI SDK's own default of 2 retries per request. Without it
   * the two policies would stack multiplicatively (3 × 3 = 9 upstream attempts); this keeps the
   * bound at `attempts` and puts the jitter under our control.
   */
  const requestModel = async (
    params: ResponseCreateParamsNonStreaming,
    label: string,
  ): Promise<Response> => {
    /**
     * B0-606 — safety net for a model whose sampling support we do not yet know about.
     *
     * `samplingParamsFor` already strips `temperature` for every model verified to reject it, but
     * that list is a point-in-time snapshot and a stale parameter list is exactly what caused
     * B0-606. If the API rejects `temperature` anyway, remember it for the process and replay the
     * request once without it, so an unfamiliar model costs one failed request instead of failing
     * every turn on that model.
     *
     * Deliberately outside `retryTransportFaults`: this is a deterministic 4xx, not a transport
     * fault, so it must not consume that policy's attempts. `recordTemperatureRejection` returns
     * false once already known, which is what bounds this to a single replay.
     */
    try {
      return await requestModelOnce(params, label);
    } catch (err) {
      if (
        params.temperature === undefined ||
        !isTemperatureUnsupportedError(err) ||
        !recordTemperatureRejection(params.model as string)
      ) {
        throw err;
      }
      const withoutTemperature: ResponseCreateParamsNonStreaming = { ...params };
      // Deleted, not set to undefined: the API rejects the parameter on presence, not on value.
      delete withoutTemperature.temperature;
      return await requestModelOnce(
        withoutTemperature,
        `${label} (retry without temperature)`,
      );
    }
  };

  const requestModelOnce = async (
    params: ResponseCreateParamsNonStreaming,
    label: string,
  ): Promise<Response> => {
    let visibleDeltaEmittedThisAttempt = false;
    return retryTransportFaults(
      async () => {
        visibleDeltaEmittedThisAttempt = false;
        // B0-550 — explicit per-attempt timeout (see `resolveOpenAiRequestTimeoutMs`'s doc
        // comment): without it, a hung request has no bound short of the SDK's own 10-minute
        // default, which the SDK's default `maxRetries` would then retry on top of.
        const requestOptions = {
          maxRetries: 0,
          timeout: resolveOpenAiRequestTimeoutMs(),
        };
        if (wantsTokenEvents) {
          const stream = opts.client.responses.stream(
            {
              ...params,
              stream: true,
            } as Parameters<typeof opts.client.responses.stream>[0],
            requestOptions,
          );
          for await (const event of stream) {
            if (event.type === 'response.output_text.delta') {
              // B0-948 — `suppressVisibleDeltas` silences the caller-visible sink for the re-draft.
              if (opts.onAssistantDelta && !suppressVisibleDeltas) {
                visibleDeltaEmittedThisAttempt = true;
                opts.onAssistantDelta(event.delta);
              }
              opts.observeAssistantDelta?.(event.delta);
            }
          }
          return await stream.finalResponse();
        }
        return await opts.client.responses.create(params, requestOptions);
      },
      {
        runtime: 'responses',
        label,
        // A replay would re-stream text the user has already seen (the delta sink is write-only —
        // there is no way to retract it), so a fault after the first visible token fails cleanly
        // instead of retrying. Transport faults land at connection time, before any token, which
        // is where all ten production failures occurred.
        //
        // B0-429 — gated on *visible* deltas only. A measurement-only observer (TTFT) streams
        // without showing anyone anything, so it must not narrow this window for callers that
        // consume no deltas.
        canRetry: () => !visibleDeltaEmittedThisAttempt,
        ...opts.retry,
      },
    );
  };

  const transport = wantsTokenEvents ? 'stream' : 'create';

  for (let i = 0; i < maxRounds; i += 1) {
    const input: ResponseInputItem[] = pendingFactToolEnforcement
      ? // B0-948 — the forced round carries ONLY the instruction: the chain (or, on a chain-broken
        // run, the round-1 input already sent) still holds the user message and every tool output,
        // so re-sending them here would duplicate them inside the conversation.
        [
          {
            role: 'user' as const,
            content: pendingFactToolEnforcement.instruction,
            type: 'message' as const,
          },
        ]
      : (toolOutputs
        ? [
            ...toolOutputs,
            // B0-635 — the withdrawal notice rides along with the tool outputs of the round that
            // tripped it, as its own message item (the same shape the B0-381 exhaustion path uses).
            ...(retrievalExhaustedNoticePending
              ? [
                  {
                    role: 'user' as const,
                    content: RETRIEVAL_EXHAUSTED_INSTRUCTION,
                    type: 'message' as const,
                  },
                ]
              : []),
          ]
        : null) ??
      [
        // B0-519 — capped prior turns, replayed as explicit messages ONLY when this call is NOT
        // chaining via `previousResponseId` (an intentional chain break to bound token growth — see
        // `history`'s doc comment above). Never present alongside a real `previousResponseId`: the
        // server already remembers that conversation, so this would duplicate it.
        ...(!opts.previousResponseId && opts.history
          ? opts.history
              .filter((message) => message.content.trim().length > 0)
              .flatMap((message): ResponseInputItem[] => [
                {
                  role: message.role,
                  content: message.content,
                  type: 'message',
                },
                // B0-378 — the assistant turn's summarised tool activity, replayed right after it
                // as its own message item (same shape the B0-436 evidence block uses). Present only
                // on this chain-broken path: a live `previous_response_id` already carries the real
                // tool calls server-side, so there is nothing here to restore.
                ...(message.role === 'assistant' && message.toolContext?.trim()
                  ? [
                      {
                        role: 'user' as const,
                        content: message.toolContext,
                        type: 'message' as const,
                      },
                    ]
                  : []),
              ])
          : []),
        {
          role: 'user',
          content: opts.userMessage,
          type: 'message',
        },
        // B0-436 — a plain message item, not a `function_call_output`: there is no matching
        // `function_call` in the chain for a speculative run, so a function output item would be
        // rejected by the Responses API.
        ...(opts.preloadedEvidence
          ? [
              {
                role: 'user' as const,
                content: formatPreloadedEvidence(opts.preloadedEvidence),
                type: 'message' as const,
              },
            ]
          : []),
      ];

    /**
     * B0-635 — once retrieval is exhausted its tools stop being offered for the rest of the run;
     * every other tool stays available. Round 0 can never be withdrawn (nothing has been retrieved
     * yet), so `resolveRoundZeroToolChoice`'s view of `opts.tools` remains accurate.
     */
    const roundTools = retrievalWithdrawn
      ? opts.tools.filter((tool) => !('name' in tool) || !RETRIEVAL_TOOL_NAMES.has(tool.name))
      : opts.tools;

    const params: ResponseCreateParamsNonStreaming = {
      model: opts.model,
      instructions: opts.instructions,
      tools: roundTools,
      tool_choice: pendingFactToolEnforcement
        ? // B0-948 — pinned to the one tool the draft's claims needed and never called.
          { type: 'function', name: pendingFactToolEnforcement.toolName }
        : i === 0
          ? resolveRoundZeroToolChoice(opts)
          : // Nothing left to call (every offered tool was a retrieval tool) — say so explicitly
            // rather than sending 'auto' against an empty tool list.
            roundTools.length === 0
            ? 'none'
            : 'auto',
      parallel_tool_calls: true,
      store: true,
      stream: false,
      // B0-606 — gpt-5.5/gpt-5.6 (and the o-series) reject `temperature` outright, which failed
      // every run on those models in the agent loop, after a retrieval tool call had already
      // been paid for. Omitted entirely for those models rather than sent-and-ignored.
      ...samplingParamsFor(opts.model, { temperature: opts.temperature ?? DEFAULT_GENERATION_TEMPERATURE }),
      input,
      ...(opts.promptCacheKey ? { prompt_cache_key: opts.promptCacheKey } : {}),
      ...(chainPrev ? { previous_response_id: chainPrev } : {}),
      ...(opts.maxOutputTokens ? { max_output_tokens: opts.maxOutputTokens } : {}),
    };

    const response: Response = await requestModel(params, `responses.${transport} round ${i + 1}`);

    accumulateUsage(response);
    opts.onRawResponse?.(response);
    responseIds.push(response.id);
    chainPrev = response.id;
    toolOutputs = null;
    // B0-635 — consumed by the request above; mutated only after it succeeded, so a transport
    // replay (which re-sends the identical `params`) still carries the notice exactly once.
    retrievalExhaustedNoticePending = false;
    // B0-948 — same rule: the pin is consumed by the request that just succeeded, and the round it
    // opened is now the active one.
    activeFactToolEnforcement = pendingFactToolEnforcement
      ? { toolName: pendingFactToolEnforcement.toolName }
      : null;
    pendingFactToolEnforcement = null;

    const calls = extractFunctionCalls(response.output);

    if (calls.length === 0) {
      /**
       * B0-948 — the model has finished a draft. Before it stands, check whether it asserts a fact
       * whose owning tool was never called this turn, and if so force that ONE call and re-draft.
       * `factToolCheckUsed` latches here, so this can happen at most once per run; a model that
       * ignores the pin, a tool this run was not offered, withdrawn retrieval (B0-635) and a
       * budget with no room for the extra round all fall through to the draft as-is — the
       * regulated-claim guardrail still judges whatever is returned.
       */
      if (activeFactToolEnforcement) {
        opts.onFactToolEnforced?.({
          requiredTool: activeFactToolEnforcement.toolName,
          enforced: false,
          reason: 'model_declined_call',
          toolSucceeded: null,
          ...(preEnforcementDraft !== null ? { preEnforcementDraft } : {}),
        });
        activeFactToolEnforcement = null;
      } else if (opts.requireFactTool && !factToolCheckUsed) {
        factToolCheckUsed = true;
        const draftAnswer = extractAssistantText(response);
        const required = opts.requireFactTool({
          draftAnswer,
          toolNames: toolTrace.map((entry) => entry.toolName),
        });
        if (required) {
          const offered = roundTools.some(
            (tool) => 'name' in tool && tool.name === required.toolName,
          );
          // The forced call needs a round to execute in AND a round to re-draft in.
          const roundsRemaining = maxRounds - 1 - i;
          const blockedReason = !offered
            ? ('tool_not_offered' as const)
            : retrievalWithdrawn
              ? ('retrieval_withdrawn' as const)
              : roundsRemaining < 2
                ? ('no_rounds_remaining' as const)
                : null;
          if (blockedReason) {
            opts.onFactToolEnforced?.({
              requiredTool: required.toolName,
              enforced: false,
              reason: blockedReason,
              toolSucceeded: null,
            });
          } else {
            pendingFactToolEnforcement = required;
            preEnforcementDraft = draftAnswer;
            suppressVisibleDeltas = true;
            continue;
          }
        } else {
          opts.onFactToolEnforced?.({
            requiredTool: null,
            enforced: false,
            toolSucceeded: null,
          });
        }
      }

      return {
        lastResponse: response,
        finalResponseId: response.id,
        assistantText: extractAssistantText(response),
        toolTrace,
        responseIds,
        usage,
        usageByCall,
      };
    }

    /**
     * B0-381 — final-round overflow: the model is still requesting tools with no round left to
     * return their outputs in. Previously the loop executed them anyway and exited with whatever
     * the previous response's text held — usually nothing, since a tool-calling response
     * carries no answer text. Instead: skip execution (no tool round may run whose outputs are
     * never returned to the model), answer every pending call with a synthetic "not executed"
     * output to keep the chain valid, and force one final answer with `tool_choice: 'none'`.
     */
    if (i === maxRounds - 1) {
      logWarn('tool_rounds_exhausted', {
        model: opts.model,
        max_tool_rounds: maxRounds,
        pending_call_count: calls.length,
        response_id: response.id,
      });
      opts.onToolRoundsExhausted?.({
        maxToolRounds: maxRounds,
        pendingCallCount: calls.length,
      });

      const finalParams: ResponseCreateParamsNonStreaming = {
        ...params,
        tool_choice: 'none',
        previous_response_id: chainPrev,
        input: [
          ...calls.map(
            (call): ResponseInputItem => ({
              type: 'function_call_output',
              call_id: call.call_id,
              output: TOOL_ROUNDS_EXHAUSTED_TOOL_OUTPUT,
            }),
          ),
          {
            role: 'user',
            content: TOOL_ROUNDS_EXHAUSTED_INSTRUCTION,
            type: 'message',
          },
        ],
      };

      const finalResponse = await requestModel(
        finalParams,
        `responses.${transport} final (tool rounds exhausted)`,
      );
      accumulateUsage(finalResponse);
      opts.onRawResponse?.(finalResponse);
      responseIds.push(finalResponse.id);

      const finalText = extractAssistantText(finalResponse);
      return {
        lastResponse: finalResponse,
        finalResponseId: finalResponse.id,
        // Exhaustion must never yield an empty answer, even if the forced request returns nothing.
        assistantText: finalText.trim() ? finalText : TOOL_ROUNDS_EXHAUSTED_FALLBACK_TEXT,
        toolTrace,
        responseIds,
        usage,
        usageByCall,
      };
    }

    /**
     * B0-379 — the request is sent with `parallel_tool_calls: true`, so a multi-call round now
     * executes concurrently instead of serially. Per-call isolation: a rejection is captured into
     * that call's own `{ok:false,error}` output + `ok:false` trace entry (belt-and-braces —
     * `executeToolCall` already serializes its own failures), so one failing call never aborts its
     * siblings. Ordering stays deterministic: traces and `function_call_output` items are appended
     * in the model's own call order, keyed by `call_id`, regardless of settle order.
     */
    const executed = await Promise.all(
      calls.map(async (call): Promise<Awaited<ReturnType<ExecuteToolFn>>> => {
        try {
          return await opts.executeTool({
            name: call.name,
            argumentsJson: call.arguments,
            callId: call.call_id,
          });
        } catch (err) {
          const output = JSON.stringify({ ok: false, error: getErrorMessage(err) });
          return {
            output,
            trace: {
              toolName: call.name,
              callId: call.call_id,
              // Mirrors the preview budgets in `~/lib/tools/execute-tool-call` (B0-390).
              argumentsPreview: (call.arguments ?? '').slice(0, 1_800),
              outputPreview: output.slice(0, 4_000),
              ok: false,
              durationMs: 0,
            },
          };
        }
      }),
    );

    const outputs: ResponseInputItem[] = [];
    for (const [index, call] of calls.entries()) {
      const result = executed[index]!;
      toolTrace.push(result.trace);

      /**
       * B0-635 — productivity of THIS retrieval call, in the model's own call order. Ids are added
       * to the run-wide set as each call is scored, so within a parallel round the second of two
       * calls returning the same documents is correctly scored as having added nothing.
       */
      if (!retrievalWithdrawn && RETRIEVAL_TOOL_NAMES.has(call.name)) {
        const ids = collectRetrievalEvidenceIds(result.output);
        const producedSomethingNew = ids.some((id) => !seenEvidenceIds.has(id));
        for (const id of ids) {
          seenEvidenceIds.add(id);
        }
        if (producedSomethingNew) {
          consecutiveUnproductiveRetrievalCalls = 0;
        } else if (isCorpusSearchPayload(result.output)) {
          // Only a fruitless corpus SEARCH counts toward exhaustion. An empty structured-fact
          // lookup is neutral — see `isCorpusSearchPayload`.
          consecutiveUnproductiveRetrievalCalls += 1;
        }
      }

      outputs.push({
        type: 'function_call_output',
        call_id: call.call_id,
        // B0-437 — the model gets the slimmed variant when the tool produced one.
        output: result.modelOutput ?? result.output,
      });
    }

    // B0-948 — the forced round has executed; report what the pinned tool actually did. Reported
    // once, from the round the pin opened, so a later round can never re-trigger it.
    if (activeFactToolEnforcement) {
      const forcedIndex = calls.findIndex(
        (call) => call.name === activeFactToolEnforcement?.toolName,
      );
      opts.onFactToolEnforced?.({
        requiredTool: activeFactToolEnforcement.toolName,
        enforced: true,
        toolSucceeded: forcedIndex >= 0 ? (executed[forcedIndex]?.trace.ok ?? false) : false,
        ...(preEnforcementDraft !== null ? { preEnforcementDraft } : {}),
      });
      activeFactToolEnforcement = null;
    }

    // B0-635 — trip the early stop once, after the whole round has been scored.
    if (
      !retrievalWithdrawn &&
      consecutiveUnproductiveRetrievalCalls >= UNPRODUCTIVE_RETRIEVAL_CALL_LIMIT
    ) {
      retrievalWithdrawn = true;
      retrievalExhaustedNoticePending = true;
      logWarn('retrieval_exhausted_early_stop', {
        model: opts.model,
        round: i + 1,
        unproductive_call_count: consecutiveUnproductiveRetrievalCalls,
        seen_evidence_id_count: seenEvidenceIds.size,
        response_id: response.id,
      });
      opts.onRetrievalExhausted?.({
        unproductiveCallCount: consecutiveUnproductiveRetrievalCalls,
        seenEvidenceIdCount: seenEvidenceIds.size,
        round: i + 1,
      });
    }

    toolOutputs = outputs;
  }

  // Reachable only when maxToolRounds < 1 — every round either returns an answer, returns the
  // exhaustion answer, or continues with tool outputs.
  throw new Error('Responses tool loop exited without a model response.');
}
