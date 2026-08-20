import type OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  Tool,
} from 'openai/resources/responses/responses';
import type { ResponseInputItem } from 'openai/resources/responses/responses';

import { extractAssistantText, extractFunctionCalls } from '~/lib/openai/response-item-parsing';
import {
  resolveOpenAiRequestTimeoutMs,
  retryTransportFaults,
  type TransportRetryTuning,
} from '~/lib/openai/transport-retry';
import { logWarn } from '~/lib/observability/logger';
import { getErrorMessage } from '~/lib/utils';
import type { ToolTraceEntry } from '~/lib/audit/trace';

export type ExecuteToolFn = (input: {
  name: string;
  argumentsJson: string;
  callId: string;
}) => Promise<{
  output: string;
  /**
   * B0-437 — slimmer projection of `output` for the model only (see `~/lib/tools/model-tool-payload`).
   * The runtime sends `modelOutput ?? output` to the model; the caller persists the full `output`, so
   * the validator and the regulated-claim guardrail keep seeing the complete evidence.
   */
  modelOutput?: string;
  trace: ToolTraceEntry;
}>;

/**
 * B0-436 — evidence retrieved BEFORE the first model call (speculative retrieval), handed to that
 * call so it can be the *answering* call instead of a round spent selecting the one obvious tool.
 *
 * It is appended to round 1's `input` as its own message item, deliberately NOT merged into
 * `instructions` and NOT reflected in `promptCacheKey`: those two form the stable cache prefix
 * (see `promptCacheKey` below) and a per-request value in either collapses prompt caching.
 */
export type PreloadedEvidence = {
  /** Where the evidence came from, e.g. `search_product_docs (pre-fetched)`. */
  label: string;
  /** The tool payload exactly as the model would have received it from a real tool call. */
  text: string;
};

/**
 * Renders `PreloadedEvidence` as the single message item both runtimes inject. Shared so the
 * Responses and AI SDK paths present byte-identical evidence to the model.
 *
 * The wording matters: the product-support system prompt hard-requires a retrieval call before
 * answering, so this block states plainly that the retrieval already ran (and what to do when it is
 * not enough) — otherwise the model reads "you have not retrieved yet" and burns the round anyway.
 */
export function formatPreloadedEvidence(evidence: PreloadedEvidence): string {
  return [
    '## Retrieved evidence (pre-fetched)',
    '',
    `A retrieval tool was already run on your behalf for this message: \`${evidence.label}\`.`,
    'This IS the mandatory retrieval call — treat the result below exactly as if you had called the tool yourself, and cite from it.',
    'If it does not contain what you need, call the appropriate tool(s) now before answering.',
    '',
    evidence.text,
  ].join('\n');
}

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
   */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
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
  executeTool: ExecuteToolFn;
};

/** LLM token usage summed across every model call in a run (B0-117 cost attribution). */
export type LlmTokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * B0-324 — prompt tokens the provider served from its automatic prompt cache
   * (`usage.input_tokens_details.cached_tokens`). Non-zero on the 2nd+ model call of a
   * multi-round tool loop means the stable prefix (instructions + tool schemas) is being reused.
   */
  cachedPromptTokens: number;
};

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

const TOOL_ROUNDS_EXHAUSTED_INSTRUCTION =
  'You have reached the tool-call limit for this turn — no further tool calls will be executed. ' +
  'Answer the user\'s question NOW using only the evidence already gathered above. ' +
  'If the gathered evidence is not sufficient for a complete verified answer, say plainly which part ' +
  'you could not verify instead of guessing or inventing values.';

/**
 * B0-381 — last-resort answer when even the forced `tool_choice: 'none'` request produces no text.
 * Exhaustion must never surface an empty `assistantText`.
 */
export const TOOL_ROUNDS_EXHAUSTED_FALLBACK_TEXT =
  'I hit the tool-call limit for this request before I could finish gathering evidence, so I can\'t ' +
  'give a complete verified answer. Please narrow the question (one product or one topic at a time) ' +
  'and ask again.';

export async function runResponsesWithToolLoop(
  opts: ResponsesRuntimeOptions,
): Promise<ResponsesRuntimeResult> {
  const maxRounds = opts.maxToolRounds ?? 16;
  const toolTrace: ToolTraceEntry[] = [];
  const responseIds: string[] = [];

  // B0-429 — either sink needs token events, so either one selects the streaming transport.
  const wantsTokenEvents = Boolean(opts.onAssistantDelta || opts.observeAssistantDelta);

  let chainPrev: string | undefined = opts.previousResponseId?.trim() || undefined;
  let toolOutputs: ResponseInputItem[] | null = null;

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
              if (opts.onAssistantDelta) {
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
    const input: ResponseInputItem[] =
      toolOutputs ??
      [
        // B0-519 — capped prior turns, replayed as explicit messages ONLY when this call is NOT
        // chaining via `previousResponseId` (an intentional chain break to bound token growth — see
        // `history`'s doc comment above). Never present alongside a real `previousResponseId`: the
        // server already remembers that conversation, so this would duplicate it.
        ...(!opts.previousResponseId && opts.history
          ? opts.history
              .filter((message) => message.content.trim().length > 0)
              .map(
                (message): ResponseInputItem => ({
                  role: message.role,
                  content: message.content,
                  type: 'message',
                }),
              )
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

    const params: ResponseCreateParamsNonStreaming = {
      model: opts.model,
      instructions: opts.instructions,
      tools: opts.tools,
      tool_choice: i === 0 ? resolveRoundZeroToolChoice(opts) : 'auto',
      parallel_tool_calls: true,
      store: true,
      stream: false,
      temperature: opts.temperature ?? 0.2,
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

    const calls = extractFunctionCalls(response.output);

    if (calls.length === 0) {
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
      outputs.push({
        type: 'function_call_output',
        call_id: call.call_id,
        // B0-437 — the model gets the slimmed variant when the tool produced one.
        output: result.modelOutput ?? result.output,
      });
    }

    toolOutputs = outputs;
  }

  // Reachable only when maxToolRounds < 1 — every round either returns an answer, returns the
  // exhaustion answer, or continues with tool outputs.
  throw new Error('Responses tool loop exited without a model response.');
}
