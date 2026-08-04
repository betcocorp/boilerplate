import type OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  Tool,
} from 'openai/resources/responses/responses';
import type { ResponseInputItem } from 'openai/resources/responses/responses';

import { extractAssistantText, extractFunctionCalls } from '~/lib/openai/response-item-parsing';
import type { ToolTraceEntry } from '~/lib/audit/trace';

export type ExecuteToolFn = (input: {
  name: string;
  argumentsJson: string;
  callId: string;
}) => Promise<{ output: string; trace: ToolTraceEntry }>;

export type ResponsesRuntimeOptions = {
  client: OpenAI;
  model: string;
  instructions: string;
  tools: Tool[];
  userMessage: string;
  /** Prior completed response id for multi-turn chaining (per conversation). */
  previousResponseId?: string | null;
  maxToolRounds?: number;
  temperature?: number;
  toolChoice?: ResponseCreateParamsNonStreaming['tool_choice'];
  /**
   * B0-324 — `prompt_cache_key` routes every request sharing the same stable prefix
   * (instructions + tool schemas) to the same cache pool. Without it, identical prompts are
   * load-balanced across machines and OpenAI's automatic prompt caching mostly misses; with it,
   * the 2nd+ call in a tool loop reads the prefix from cache. Must be identical for all calls
   * that share a prefix, and must NOT contain per-request values (run id, timestamp, user text).
   */
  promptCacheKey?: string;
  onRawResponse?: (response: Response) => void;
  onAssistantDelta?: (delta: string) => void;
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

export async function runResponsesWithToolLoop(
  opts: ResponsesRuntimeOptions,
): Promise<ResponsesRuntimeResult> {
  const maxRounds = opts.maxToolRounds ?? 16;
  const toolTrace: ToolTraceEntry[] = [];
  const responseIds: string[] = [];

  let chainPrev: string | undefined = opts.previousResponseId?.trim() || undefined;
  let toolOutputs: ResponseInputItem[] | null = null;

  let lastResponse: Response | null = null;
  const usage: LlmTokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
  };
  const usageByCall: LlmTokenUsage[] = [];
  const accumulateUsage = (response: Response) => {
    const call: LlmTokenUsage = {
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
      cachedPromptTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
    };
    usageByCall.push(call);
    usage.promptTokens += call.promptTokens;
    usage.completionTokens += call.completionTokens;
    usage.totalTokens += call.totalTokens;
    usage.cachedPromptTokens += call.cachedPromptTokens;
  };

  for (let i = 0; i < maxRounds; i += 1) {
    const input: ResponseInputItem[] =
      toolOutputs ??
      [
        {
          role: 'user',
          content: opts.userMessage,
          type: 'message',
        },
      ];

    const params: ResponseCreateParamsNonStreaming = {
      model: opts.model,
      instructions: opts.instructions,
      tools: opts.tools,
      tool_choice: i === 0 ? (opts.toolChoice ?? 'auto') : 'auto',
      parallel_tool_calls: true,
      store: true,
      stream: false,
      temperature: opts.temperature ?? 0.2,
      input,
      ...(opts.promptCacheKey ? { prompt_cache_key: opts.promptCacheKey } : {}),
      ...(chainPrev ? { previous_response_id: chainPrev } : {}),
    };

    let response: Response;
    if (opts.onAssistantDelta) {
      const stream = opts.client.responses.stream({
        ...params,
        stream: true,
      } as Parameters<typeof opts.client.responses.stream>[0]);
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          opts.onAssistantDelta(event.delta);
        }
      }
      response = await stream.finalResponse();
    } else {
      response = await opts.client.responses.create(params);
    }

    lastResponse = response;
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

    const outputs: ResponseInputItem[] = [];
    for (const call of calls) {
      const executed = await opts.executeTool({
        name: call.name,
        argumentsJson: call.arguments,
        callId: call.call_id,
      });
      toolTrace.push(executed.trace);
      outputs.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: executed.output,
      });
    }

    toolOutputs = outputs;
  }

  if (!lastResponse) {
    throw new Error('Responses tool loop exited without a model response.');
  }

  return {
    lastResponse,
    finalResponseId: lastResponse.id,
    assistantText: extractAssistantText(lastResponse),
    toolTrace,
    responseIds,
    usage,
    usageByCall,
  };
}
