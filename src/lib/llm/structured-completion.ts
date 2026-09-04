import type Anthropic from '@anthropic-ai/sdk';

import { getAnthropicClient } from '~/lib/anthropic/client';
import { modelProviderFor, type ModelEffort, type ModelProvider } from '~/lib/constants/models';
import { logInfo } from '~/lib/observability/logger';
import { getOpenAIClient } from '~/lib/openai/client';
import { samplingParamsFor } from '~/lib/openai/model-capabilities';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';

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
  request: StructuredCompletionRequest,
  usage: { inputTokens?: number | null; outputTokens?: number | null; cachedInputTokens?: number | null },
): void {
  // Grading calls are not `workflow_steps`, so the B0-565 cost views never see them; this line is the
  // only per-call record of what a report cost until they do.
  logInfo('llm_structured_completion', {
    provider,
    model: request.model,
    schema: request.schemaName,
    effort: provider === 'anthropic' ? (request.effort ?? null) : null,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cachedInputTokens: usage.cachedInputTokens ?? null,
  });
}

const completeWithOpenAI: StructuredCompletion = async (request) => {
  const res = await getOpenAIClient().responses.create({
    model: request.model,
    instructions: request.system,
    input: [{ role: 'user', content: request.user, type: 'message' }],
    text: {
      format: {
        type: 'json_schema',
        name: request.schemaName,
        strict: true,
        schema: request.schema,
      },
    },
    store: false,
    stream: false,
    max_output_tokens: request.maxOutputTokens,
    ...samplingParamsFor(request.model, { temperature: request.temperature }),
  });
  if (res.incomplete_details?.reason === 'max_output_tokens') {
    throw new StructuredOutputTruncatedError();
  }
  logUsage('openai', request, {
    inputTokens: res.usage?.input_tokens,
    outputTokens: res.usage?.output_tokens,
    cachedInputTokens: res.usage?.input_tokens_details?.cached_tokens,
  });
  return extractAssistantText(res);
};

/**
 * Anthropic counts thinking tokens against `max_tokens`; the callers' caps were sized for the JSON
 * answer alone (they mirror OpenAI `max_output_tokens`). This headroom is added on top so a
 * high-effort think can never starve the answer and read as a truncation. Streaming (below) is what
 * makes a cap this size legal — the SDK refuses non-streaming requests above ~21k tokens.
 */
export const ANTHROPIC_THINKING_HEADROOM_TOKENS = 16_000;

const completeWithAnthropic: StructuredCompletion = async (request) => {
  const res = await getAnthropicClient()
    .messages.stream({
      model: request.model,
      max_tokens: request.maxOutputTokens + ANTHROPIC_THINKING_HEADROOM_TOKENS,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      // Opus 5 / Sonnet 5: adaptive is the only on-mode; `budget_tokens` and any sampling control
      // (`temperature`, `top_p`) are rejected with a 400, which is why neither appears here.
      thinking: { type: 'adaptive' },
      output_config: {
        ...(request.effort ? { effort: request.effort } : {}),
        format: { type: 'json_schema', schema: request.schema },
      },
    })
    .finalMessage();
  if (res.stop_reason === 'max_tokens') {
    throw new StructuredOutputTruncatedError();
  }
  if (res.stop_reason === 'refusal') {
    throw new StructuredOutputRefusedError(
      res.stop_details?.category ?? null,
      res.stop_details?.explanation ?? null,
    );
  }
  logUsage('anthropic', request, {
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    cachedInputTokens: res.usage.cache_read_input_tokens,
  });
  // Thinking blocks (empty under the default `display`) are skipped; the structured answer is the text.
  return res.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
};

/** Routes on the model id: `claude-*` to Anthropic, everything else to the OpenAI Responses API. */
export const completeStructured: StructuredCompletion = (request) =>
  modelProviderFor(request.model) === 'anthropic'
    ? completeWithAnthropic(request)
    : completeWithOpenAI(request);
