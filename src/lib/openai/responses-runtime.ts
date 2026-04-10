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
  onRawResponse?: (response: Response) => void;
  executeTool: ExecuteToolFn;
};

export type ResponsesRuntimeResult = {
  lastResponse: Response;
  finalResponseId: string;
  assistantText: string;
  toolTrace: ToolTraceEntry[];
  responseIds: string[];
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
      tool_choice: 'auto',
      parallel_tool_calls: true,
      store: true,
      stream: false,
      temperature: opts.temperature ?? 0.2,
      input,
      ...(chainPrev ? { previous_response_id: chainPrev } : {}),
    };

    const response = await opts.client.responses.create(params);
    lastResponse = response;
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
  };
}
