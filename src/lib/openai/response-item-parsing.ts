import type {
  Response,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseOutputMessage,
} from 'openai/resources/responses/responses';

function isFunctionCall(item: ResponseOutputItem): item is ResponseFunctionToolCall {
  return (item as ResponseFunctionToolCall).type === 'function_call';
}

function isOutputMessage(item: ResponseOutputItem): item is ResponseOutputMessage {
  return (item as ResponseOutputMessage).type === 'message';
}

export function extractFunctionCalls(
  output: ResponseOutputItem[],
): Array<Pick<ResponseFunctionToolCall, 'call_id' | 'name' | 'arguments'>> {
  const calls: Array<Pick<ResponseFunctionToolCall, 'call_id' | 'name' | 'arguments'>> = [];

  for (const item of output) {
    if (isFunctionCall(item) && item.call_id && item.name) {
      calls.push({
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments ?? '{}',
      });
    }
  }

  return calls;
}

export function extractAssistantTextFromOutput(output: ResponseOutputItem[]): string {
  const parts: string[] = [];

  for (const item of output) {
    if (!isOutputMessage(item)) {
      continue;
    }

    for (const block of item.content) {
      if (block.type === 'output_text' && 'text' in block) {
        parts.push(block.text);
      }
      if (block.type === 'refusal' && 'refusal' in block) {
        parts.push(`Refusal: ${block.refusal}`);
      }
    }
  }

  return parts.join('\n').trim();
}

export function extractAssistantText(response: Response): string {
  const fromField = response.output_text?.trim();
  if (fromField) {
    return fromField;
  }

  return extractAssistantTextFromOutput(response.output);
}
