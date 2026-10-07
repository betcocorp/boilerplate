import { describe, expect, it } from 'vitest';

import {
  extractAssistantTextFromOutput,
  extractFunctionCalls,
} from '~/lib/openai/response-item-parsing';

describe('response-item-parsing', () => {
  it('extracts function calls from mixed output', () => {
    const calls = extractFunctionCalls([
      {
        type: 'function_call',
        call_id: 'c1',
        name: 'search_product_docs',
        arguments: '{"productName":"X"}',
      },
      {
        type: 'message',
        id: 'm1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hi', annotations: [] }],
      },
    ] as never[]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('search_product_docs');
    expect(calls[0]!.call_id).toBe('c1');
  });

  it('extracts assistant text from message items', () => {
    const text = extractAssistantTextFromOutput([
      {
        type: 'message',
        id: 'm1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Line one', annotations: [] }],
      },
    ] as never[]);

    expect(text).toBe('Line one');
  });
});
