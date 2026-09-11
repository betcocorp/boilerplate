import type Anthropic from '@anthropic-ai/sdk';

import { getAnthropicClient } from '~/lib/anthropic/client';
import { modelProviderFor, type ModelEffort, type ModelProvider } from '~/lib/constants/models';
import { logError, logInfo, logWarn } from '~/lib/observability/logger';
import { getOpenAIClient } from '~/lib/openai/client';
import type { LlmTokenUsage } from '~/lib/openai/responses-runtime';
import { samplingParamsFor } from '~/lib/openai/model-capabilities';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';
import { getErrorMessage } from '~/lib/utils';

/**
 * B0-819 — one structured-output call, provider-neutral.
 *
 * The run-report grader and synthesizer ask a model one question and require a JSON answer that
 * validates against a strict schema. This is the single place that knows how to ask OpenAI
 * (Responses API, `text.format` json_schema, strict) and Anthropic (Messages API,
 * `output_config.format` json_schema, adaptive thinking, `output_config.effort`) the same thing.
 *
 * Both providers receive the SAME `system`, `user` and `schema` bytes — verified live 2026-09-03 that
 * Anthropic accepts the grader schema verbatim, nullable `type: [..., 'null']` arrays included — so a
 * report graded on Claude and one graded on GPT were asked the same question in the same words with
 * the same field descriptions. Callers parse the returned JSON text with Zod themselves; this layer
 * only guarantees the text is the model's complete structured answer, not a truncation or a refusal.
 *
 * Provider is inferred from the resolved model id (`modelProviderFor`), never from a flag, so a
 * pinned id routes correctly without a registry edit.
 */
export type StructuredCompletionRequest = {
  /** Resolved model id — the string the provider is called with. */
  model: string;
  system: string;
  user: string;
  /**
   * B0-908 — earlier conversation turns, oldest first, sent as real message items ahead of `user`
   * on both providers (OpenAI `input` items / Anthropic `messages`), so a multi-turn classifier
   * prompt keeps the exact shape it had on the Responses API rather than being flattened into text.
   */
  priorMessages?: ReadonlyArray<PriorMessage>;
  /** Name for the schema (OpenAI requires one; Anthropic ignores it). */
  schemaName: string;
  /** Strict JSON schema: `additionalProperties: false`, every property required. Sent verbatim to both providers. */
  schema: Record<string, unknown>;
  /** Output cap. OpenAI `max_output_tokens`; Anthropic `max_tokens` (thinking tokens count against it). */
  maxOutputTokens: number;
  /** OpenAI only, and only for models that accept it (`samplingParamsFor`). Never sent to Anthropic — Opus 5 / Sonnet 5 return 400 on any sampling control. */
  temperature?: number;
  /** Anthropic only (`output_config.effort`); OpenAI ignores it. */
  effort?: ModelEffort;
  /** B0-908 — per-call transport knobs, forwarded to whichever SDK is called. */
  requestOptions?: CompletionRequestOptions;
};

/**
 * B0-908 — per-call SDK transport options. Both SDKs accept `{ maxRetries, timeout }` as the second
 * argument; callers that wrap the call in `retryTransportFaults` pass `maxRetries: 0` so the SDK's
 * own retry does not stack on top of theirs.
 */
export type CompletionRequestOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  /** Cancels the in-flight HTTP request; both SDKs accept it as a request option. */
  signal?: AbortSignal;
};

export type PriorMessage = { role: 'user' | 'assistant'; content: string };

/**
 * B0-908 — a free-text single-shot call: same request minus the schema. For the OpenAI-only call
 * sites that were migrated off `client.responses.create` (revision pass etc.) so a `claude-*` tag can
 * serve them too.
 */
export type TextCompletionRequest = Omit<StructuredCompletionRequest, 'schemaName' | 'schema'>;

/** B0-908 — the answer text plus the usage of the one model call, in the runtime's `LlmTokenUsage` shape. */
export type CompletionResult = {
  text: string;
  usage: LlmTokenUsage;
};

/** The seam every caller talks to a model through. Tests inject a fake; production uses `completeStructured`. */
export type StructuredCompletion = (request: StructuredCompletionRequest) => Promise<string>;

/**
 * Generation was cut off by the output cap. Strict structured output only ever produces invalid
 * JSON this way, so surfacing it as its own error turns a bare `JSON.parse` failure into a clear
 * "raise the cap" message. The message keeps the `max_output_tokens` wording both providers' callers
 * already match on.
 */
export class StructuredOutputTruncatedError extends Error {
  constructor() {
    super('output truncated at max_output_tokens; raise the cap or shrink the input.');
    this.name = 'StructuredOutputTruncatedError';
  }
}

/**
 * Anthropic's safety classifiers declined the request (HTTP 200, `stop_reason: "refusal"`). Surfaced,
 * not silently rerouted: the report must say which model graded every case, so there is deliberately
 * no server-side fallback to another model here — a refused grading call becomes an Unable to
 * Evaluate case with this reason on it.
 */
export class StructuredOutputRefusedError extends Error {
  constructor(
    readonly category: string | null,
    explanation: string | null,
  ) {
    super(
      `model refused the request${category ? ` (${category})` : ''}${explanation ? `: ${explanation}` : ''}`,
    );
    this.name = 'StructuredOutputRefusedError';
  }
}

function logUsage(
  provider: ModelProvider,
  request: TextCompletionRequest & { schemaName?: string },
  usage: { inputTokens?: number | null; outputTokens?: number | null; cachedInputTokens?: number | null },
): void {
  // Grading calls are not `workflow_steps`, so the B0-565 cost views never see them; this line is the
  // only per-call record of what a report cost until they do.
  logInfo('llm_structured_completion', {
    provider,
    model: request.model,
    schema: request.schemaName ?? null,
    effort: provider === 'anthropic' ? (request.effort ?? null) : null,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cachedInputTokens: usage.cachedInputTokens ?? null,
  });
}

/**
 * B0-922 — the one place a failed call on this seam is recorded.
 *
 * Every caller catches, and none of them logged: when B0-910's nullable enums 400'd on Anthropic the
 * router and the turn-signals pass failed on all 106 items of a run, fell back to keyword routing at
 * confidence 0, and the run still reported a clean letter grade with no log line anywhere. Logging
 * centrally rather than per caller means the next call site cannot forget, and the payload matches
 * `logUsage` above so a failure is attributable to the same provider/model/schema triple as a success.
 *
 * Level: a refusal is a *surfaced*, documented outcome — the caller turns it into an Unable to
 * Evaluate case carrying the reason, and there is deliberately no fallback model — so it is `warn`
 * (countable, not alarming). Everything else, including truncation and provider HTTP errors, is
 * `error`. This is observability only: the original error is re-thrown untouched.
 */
function logFailure(
  provider: ModelProvider,
  request: TextCompletionRequest & { schemaName?: string },
  error: unknown,
): void {
  const refusal = error instanceof StructuredOutputRefusedError ? error : null;
  const fields = {
    provider,
    model: request.model,
    schema: request.schemaName ?? null,
    effort: provider === 'anthropic' ? (request.effort ?? null) : null,
    errorName: error instanceof Error ? error.name : typeof error,
    error: getErrorMessage(error),
    ...(refusal ? { refusalCategory: refusal.category } : {}),
  };
  if (refusal) {
    logWarn('llm_structured_completion_refused', fields);
    return;
  }
  logError('llm_structured_completion_failed', fields);
}

function toUsage(usage: {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
}): LlmTokenUsage {
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedPromptTokens: usage.cachedInputTokens ?? 0,
  };
}

function sdkRequestOptions(options: CompletionRequestOptions | undefined) {
  if (!options) return undefined;
  return {
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

/**
 * Anthropic requires `messages[0]` to be a user turn (consecutive same-role turns are fine — the API
 * merges them). A history that opens on an assistant turn (a capped tail) has that lead dropped for
 * Anthropic only; OpenAI accepts any ordering and gets the history verbatim.
 */
function anthropicHistory(prior: ReadonlyArray<PriorMessage> | undefined): PriorMessage[] {
  const turns = [...(prior ?? [])];
  while (turns.length > 0 && turns[0]!.role !== 'user') {
    turns.shift();
  }
  return turns;
}

/**
 * B0-908 — Claude ids that do NOT take `thinking: { type: 'adaptive' }` or `output_config.effort`.
 * Haiku 4.5 still uses the legacy `budget_tokens` form and rejects both; this codebase does not
 * think on Haiku at all, it just omits the parameters. Prefix-matched so dated snapshots are covered.
 */
const ANTHROPIC_ADAPTIVE_UNSUPPORTED_PREFIXES = [
  'claude-haiku-',
  'claude-3',
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
] as const;

export function supportsAnthropicAdaptiveThinking(model: string): boolean {
  const id = model.trim().toLowerCase();
  return !ANTHROPIC_ADAPTIVE_UNSUPPORTED_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Anthropic counts thinking tokens against `max_tokens`; the callers' caps were sized for the JSON
 * answer alone (they mirror OpenAI `max_output_tokens`). This headroom is added on top so a
 * high-effort think can never starve the answer and read as a truncation. Streaming (below) is what
 * makes a cap this size legal — the SDK refuses non-streaming requests above ~21k tokens.
 */
export const ANTHROPIC_THINKING_HEADROOM_TOKENS = 16_000;

type JsonSchemaFormat = { schemaName: string; schema: Record<string, unknown> } | null;

async function runOpenAI(
  request: TextCompletionRequest,
  format: JsonSchemaFormat,
): Promise<CompletionResult> {
  const res = await getOpenAIClient().responses.create(
    {
      model: request.model,
      instructions: request.system,
      input: [
        ...(request.priorMessages ?? []).map((m) => ({
          role: m.role,
          content: m.content,
          type: 'message' as const,
        })),
        { role: 'user', content: request.user, type: 'message' },
      ],
      ...(format
        ? {
            text: {
              format: {
                type: 'json_schema',
                name: format.schemaName,
                strict: true,
                schema: format.schema,
              },
            },
          }
        : {}),
      store: false,
      stream: false,
      max_output_tokens: request.maxOutputTokens,
      ...samplingParamsFor(request.model, { temperature: request.temperature }),
    },
    sdkRequestOptions(request.requestOptions),
  );
  // Strict structured output can only ever be invalid JSON when cut off, so that is surfaced as its
  // own error; a free-text answer that hits the cap is still the model's answer and is returned.
  if (format && res.incomplete_details?.reason === 'max_output_tokens') {
    throw new StructuredOutputTruncatedError();
  }
  const usage = {
    inputTokens: res.usage?.input_tokens,
    outputTokens: res.usage?.output_tokens,
    cachedInputTokens: res.usage?.input_tokens_details?.cached_tokens,
  };
  logUsage('openai', { ...request, schemaName: format?.schemaName }, usage);
  return { text: extractAssistantText(res), usage: toUsage(usage) };
}

async function runAnthropic(
  request: TextCompletionRequest,
  format: JsonSchemaFormat,
): Promise<CompletionResult> {
  const adaptive = supportsAnthropicAdaptiveThinking(request.model);
  const outputConfig = {
    ...(adaptive && request.effort ? { effort: request.effort } : {}),
    ...(format ? { format: { type: 'json_schema' as const, schema: format.schema } } : {}),
  };
  const res = await getAnthropicClient()
    .messages.stream(
      {
        model: request.model,
        // Thinking headroom only matters when the model thinks; Haiku-class ids get the bare cap.
        max_tokens: request.maxOutputTokens + (adaptive ? ANTHROPIC_THINKING_HEADROOM_TOKENS : 0),
        system: request.system,
        messages: [
          ...anthropicHistory(request.priorMessages),
          { role: 'user', content: request.user },
        ],
        // Opus 5 / Sonnet 5: adaptive is the only on-mode; `budget_tokens` and any sampling control
        // (`temperature`, `top_p`) are rejected with a 400, which is why neither appears here.
        ...(adaptive ? { thinking: { type: 'adaptive' as const } } : {}),
        ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
      },
      sdkRequestOptions(request.requestOptions),
    )
    .finalMessage();
  if (format && res.stop_reason === 'max_tokens') {
    throw new StructuredOutputTruncatedError();
  }
  if (res.stop_reason === 'refusal') {
    throw new StructuredOutputRefusedError(
      res.stop_details?.category ?? null,
      res.stop_details?.explanation ?? null,
    );
  }
  const usage = {
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    cachedInputTokens: res.usage.cache_read_input_tokens,
  };
  logUsage('anthropic', { ...request, schemaName: format?.schemaName }, usage);
  // Thinking blocks (empty under the default `display`) are skipped; the answer is the text.
  const text = res.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return { text, usage: toUsage(usage) };
}

async function dispatch(
  request: TextCompletionRequest,
  format: JsonSchemaFormat,
): Promise<CompletionResult> {
  const provider = modelProviderFor(request.model);
  try {
    return await (provider === 'anthropic'
      ? runAnthropic(request, format)
      : runOpenAI(request, format));
  } catch (error) {
    // B0-922 — log once here, then re-throw exactly what was thrown: caller behaviour is unchanged.
    logFailure(provider, { ...request, schemaName: format?.schemaName }, error);
    throw error;
  }
}

/**
 * B0-908 — structured call returning the answer AND its token usage, for call sites that account
 * usage per step (`LlmTokenUsage`). Routes on the model id: `claude-*` to Anthropic, everything else
 * to the OpenAI Responses API.
 */
export function completeStructuredWithUsage(
  request: StructuredCompletionRequest,
): Promise<CompletionResult> {
  return dispatch(request, { schemaName: request.schemaName, schema: request.schema });
}

/** Routes on the model id: `claude-*` to Anthropic, everything else to the OpenAI Responses API. */
export const completeStructured: StructuredCompletion = async (request) =>
  (await completeStructuredWithUsage(request)).text;

/**
 * B0-908 — free-text single-shot call, same routing as `completeStructured`. Truncation at the output
 * cap is NOT an error here (a cut-off prose answer is still returned, matching what the OpenAI-only
 * callers did before); a refusal still is.
 */
export function completeTextWithUsage(request: TextCompletionRequest): Promise<CompletionResult> {
  return dispatch(request, null);
}

export async function completeText(request: TextCompletionRequest): Promise<string> {
  return (await completeTextWithUsage(request)).text;
}
