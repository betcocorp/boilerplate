import type OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import { describe, expect, it, vi } from 'vitest';

import { runResponsesWithToolLoop } from '~/lib/openai/responses-runtime';
import type { ToolTraceEntry } from '~/lib/audit/trace';

type StubResponse = {
  id: string;
  output: Array<Record<string, unknown>>;
  output_text?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { cached_tokens: number };
  };
};

function stubClient(responses: StubResponse[]) {
  const create = vi.fn(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error('stub client ran out of responses');
    }
    return next as unknown as Response;
  });

  return {
    client: { responses: { create } } as unknown as OpenAI,
    create,
  };
}

const trace = (name: string): ToolTraceEntry => ({
  toolName: name,
  callId: 'call_1',
  argumentsPreview: '',
  outputPreview: '',
  ok: true,
  durationMs: 0,
});

describe('runResponsesWithToolLoop — prompt caching telemetry (B0-324)', () => {
  it('accumulates cached prompt tokens and reports usage per model call', async () => {
    const { client } = stubClient([
      {
        id: 'resp_1',
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'search_product_docs',
            arguments: '{"topic":"dilution"}',
          },
        ],
        usage: {
          input_tokens: 3200,
          output_tokens: 20,
          total_tokens: 3220,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
      {
        id: 'resp_2',
        output: [],
        output_text: 'Dilute 2 oz per gallon.',
        usage: {
          input_tokens: 3400,
          output_tokens: 40,
          total_tokens: 3440,
          input_tokens_details: { cached_tokens: 3072 },
        },
      },
    ]);

    const result = await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'dilution for Green Earth?',
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    expect(result.assistantText).toBe('Dilute 2 oz per gallon.');
    expect(result.usage).toEqual({
      promptTokens: 6600,
      completionTokens: 60,
      totalTokens: 6660,
      cachedPromptTokens: 3072,
    });
    // Per-call breakdown proves the 2nd model call in the loop reused the cached prefix.
    expect(result.usageByCall.map((call) => call.cachedPromptTokens)).toEqual([0, 3072]);
  });

  it('forwards promptCacheKey on every model call so the loop hits one cache pool', async () => {
    const { client, create } = stubClient([
      {
        id: 'resp_1',
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'search_product_docs',
            arguments: '{}',
          },
        ],
      },
      { id: 'resp_2', output: [], output_text: 'done' },
    ]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'hello',
      promptCacheKey: 'bex-product-support:orchestrator:product',
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    expect(create).toHaveBeenCalledTimes(2);
    for (const call of create.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(call[0].prompt_cache_key).toBe('bex-product-support:orchestrator:product');
      // The cached prefix is only reusable while instructions stay byte-identical per call.
      expect(call[0].instructions).toBe('stable prefix');
    }
  });

  it('omits prompt_cache_key when none is supplied', async () => {
    const { client, create } = stubClient([{ id: 'resp_1', output: [], output_text: 'hi' }]);

    await runResponsesWithToolLoop({
      client,
      model: 'gpt-4.1',
      instructions: 'stable prefix',
      tools: [],
      userMessage: 'hello',
      executeTool: async ({ name }) => ({ output: '{}', trace: trace(name) }),
    });

    const params = (create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(params && 'prompt_cache_key' in params).toBe(false);
  });
});
