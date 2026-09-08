import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-889 — superlative ("best glass cleaner", "strongest floor stripper") and task-recommendation
 * ("what should I use for greasy kitchen floors") asks were naming 2-4 products out of a whole
 * documented category instead of the full list, because the model answered from whatever chunks the
 * speculative `search_product_docs` call happened to rank top instead of calling the category tool.
 * Exercised through the real workflow (same harness shape as `self-reference-integration.test.ts`
 * and `xref-backstop-integration.test.ts`) so this proves the round-1 `toolChoice` forcing in
 * `run-product-support-workflow.ts`, not just the keyword matcher in `speculative-retrieval.ts`.
 */

type Row = Record<string, unknown>;

function createFakeSupabase() {
  const tables: Record<string, Row[]> = {};
  let sequence = 0;
  const rowsFor = (table: string): Row[] => (tables[table] ??= []);

  const emptySelectChain = {
    select: () => emptySelectChain,
    in: () => emptySelectChain,
    order: () => emptySelectChain,
    then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
      resolve({ data: [], error: null }),
  };

  const client = {
    schema() {
      return { from: () => emptySelectChain };
    },
    from(table: string) {
      return {
        insert(row: Row | Row[]) {
          const incoming = Array.isArray(row) ? row : [row];
          const insertedRows = incoming.map((one) => {
            sequence += 1;
            const inserted: Row = {
              id: `${table}-${sequence}`,
              started_at: new Date().toISOString(),
              completed_at: null,
              output: null,
              error: null,
              ...one,
            };
            rowsFor(table).push(inserted);
            return inserted;
          });
          const result = {
            data: Array.isArray(row) ? insertedRows : insertedRows[0],
            error: null,
          };
          return {
            select: () => ({ single: async () => result }),
            then: (resolve: (value: typeof result) => unknown) => resolve(result),
          };
        },
        update(patch: Row) {
          return {
            async eq(column: string, value: unknown) {
              for (const row of rowsFor(table)) {
                if (row[column] === value) {
                  Object.assign(row, patch);
                }
              }
              return { error: null };
            },
          };
        },
      };
    },
  };

  return { client, tables };
}

let fake = createFakeSupabase();

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => fake.client,
}));

const settingOverrides = new Map<string, boolean | string | number>();

vi.mock('~/lib/settings/settings-service', () => ({
  getBooleanSetting: vi.fn((key: string, fallback: boolean) =>
    Promise.resolve(settingOverrides.has(key) ? (settingOverrides.get(key) as boolean) : fallback),
  ),
  getStringSetting: vi.fn((key: string, fallback: string) =>
    Promise.resolve(settingOverrides.has(key) ? (settingOverrides.get(key) as string) : fallback),
  ),
  getNumberSetting: vi.fn((key: string, fallback: number) =>
    Promise.resolve(settingOverrides.has(key) ? (settingOverrides.get(key) as number) : fallback),
  ),
}));

const openaiResponsesCreateMock = vi.fn();

vi.mock('~/lib/openai/client', () => ({
  getOpenAIClient: () => ({
    responses: { create: (...args: unknown[]) => openaiResponsesCreateMock(...args) },
  }),
  resolveResponsesModel: () => 'gpt-test',
}));

const runResponsesWithToolLoopMock = vi.fn();
const executeProductToolMock = vi.fn();

vi.mock('~/lib/openai/responses-runtime', () => ({
  runResponsesWithToolLoop: (...args: unknown[]) => runResponsesWithToolLoopMock(...args),
  usageFromResponse: () => ({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
  }),
}));

vi.mock('~/lib/bex/ai-sdk-runtime', () => ({
  runAiSdkWithToolLoop: vi.fn(),
}));

vi.mock('~/lib/tools/product-tools', () => ({
  executeProductTool: (...args: unknown[]) => executeProductToolMock(...args),
}));

vi.mock('~/lib/tools/cross-reference-lookup', () => ({
  lookupCrossReference: vi.fn(async () => ({ matches: [], fallbackRecommended: true })),
  fetchRecommendationContext: async () => ({ betcoEpaRegistration: null, alternatives: [] }),
}));

vi.mock('~/lib/recommendations/persist-recommendation', () => ({
  runCrossReferenceRecommendation: vi.fn(async () => ({
    source: 'web',
    answered: false,
    status: 'declined',
    overallConfidence: 0,
    thresholdUsed: 0.8,
    candidates: [],
    evidence: {},
    declineReason: 'not applicable',
    recommendationId: 'rec-none',
  })),
}));

vi.mock('~/lib/rag/entity-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/rag/entity-context')>();
  return {
    ...actual,
    resolveProductEntityByName: vi.fn(async () => ({
      productLineKey: null,
      productKey: null,
      resolutionSource: null,
      ambiguousAlias: false,
      matchedAliasId: null,
      matchedAliasConfidence: null,
    })),
  };
});

vi.mock('~/lib/workflows/product-support/validator', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('~/lib/workflows/product-support/validator')>();
  return {
    ...actual,
    runValidatorPass: vi.fn(),
    runRevisionPass: vi.fn(),
    evaluateRegulatedClaimGrounding: () => ({
      categoriesDetected: [],
      ungroundedCategories: [],
      ungroundedDetails: [],
    }),
  };
});

import { runProductSupportWorkflow } from '~/lib/workflows/product-support/run-product-support-workflow';

const AGENT_USAGE = {
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  cachedPromptTokens: 0,
};

const RAG_SOURCES = {
  sources: [
    {
      documentId: '11111111-1111-4111-8111-111111111111',
      chunkId: '22222222-2222-4222-8222-222222222222',
      title: 'Clear Image Glass Cleaner label',
      snippet: 'A glass and surface cleaner.',
      documentBody: 'A glass and surface cleaner.',
      documentKind: 'label',
      similarity: 0.7,
    },
  ],
};

const CATEGORY_TOOL_CHOICE = { type: 'function', name: 'get_products_in_category' };

function generationCalling(calls: Array<{ name: string; argumentsJson: string; callId: string }>) {
  return async (opts: unknown) => {
    const { executeTool } = opts as {
      executeTool: (input: {
        name: string;
        argumentsJson: string;
        callId: string;
      }) => Promise<{ output: string }>;
    };
    for (const call of calls) {
      await executeTool(call);
    }
    return {
      lastResponse: {},
      finalResponseId: 'resp_final',
      assistantText: 'Full category list answer.',
      toolTrace: [],
      responseIds: ['resp_1'],
      usage: AGENT_USAGE,
      usageByCall: [AGENT_USAGE],
    };
  };
}

function firstToolChoice(): unknown {
  const [opts] = runResponsesWithToolLoopMock.mock.calls[0] as [{ toolChoice: unknown }];
  return opts.toolChoice;
}

async function run(userMessage: string) {
  return runProductSupportWorkflow({
    traceId: 'trace-1',
    conversationId: 'conversation-1',
    userMessage,
    source: 'chat',
  } as Parameters<typeof runProductSupportWorkflow>[0]);
}

beforeEach(() => {
  fake = createFakeSupabase();
  vi.clearAllMocks();
  settingOverrides.clear();
  settingOverrides.set('BEX_AI_SDK_GENERATION_ENABLED', false);
  settingOverrides.set('BEX_LLM_ROUTER_ENABLED', false);
  settingOverrides.set('BEX_LLM_ROUTER_SHADOW_MODE', true);
  settingOverrides.set('BEX_EARLY_DECLINE_GATE_ENABLED', false);

  runResponsesWithToolLoopMock.mockImplementation(
    generationCalling([
      {
        name: 'get_products_in_category',
        argumentsJson: JSON.stringify({ categoryName: 'glass' }),
        callId: 'call_category',
      },
    ]),
  );
  executeProductToolMock.mockImplementation(async () => RAG_SOURCES);
});

describe('category-tool forcing for superlative/task-recommendation asks (B0-889)', () => {
  it('"what is the best glass cleaner?" forces the round-1 tool choice to get_products_in_category', async () => {
    const out = await run('What is the best glass cleaner?');

    expect(firstToolChoice()).toEqual(CATEGORY_TOOL_CHOICE);
    expect(out.answerText).toBe('Full category list answer.');
  });

  it('"what should I use for greasy kitchen floors?" also forces the category tool', async () => {
    const out = await run('What should I use for greasy kitchen floors?');

    expect(firstToolChoice()).toEqual(CATEGORY_TOOL_CHOICE);
    expect(out.answerText).toBe('Full category list answer.');
  });

  it('regression: a NAMED-product dilution question still forces get_efficacy_data (B0-788), never the category tool', async () => {
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling([
        {
          name: 'get_efficacy_data',
          argumentsJson: JSON.stringify({ productId: 'Kitchen Cleaner & Degreaser' }),
          callId: 'call_efficacy',
        },
      ]),
    );

    const out = await run('What is the dilution for Kitchen Cleaner & Degreaser?');

    // "dilution" matches the pre-existing B0-788 exact-efficacy pattern, which takes priority over
    // the new B0-889 category check — a named product's dilution is never answered with a category
    // list. Proves the two forced-tool-choice checks compose correctly, not just that each fires
    // alone.
    expect(firstToolChoice()).toEqual({ type: 'function', name: 'get_efficacy_data' });
    expect(out.answerText).toBe('Full category list answer.');
  });

  it('regression: a plain named-product question with neither keyword shape stays "auto"', async () => {
    const out = await run('What surfaces is Kitchen Cleaner & Degreaser approved for?');

    // Named-product questions never match the superlative/task-recommendation keyword check, so the
    // B0-436 speculative-retrieval "auto" choice (evidence already preloaded) is untouched.
    expect(firstToolChoice()).toBe('auto');
    expect(out.answerText).toBe('Full category list answer.');
  });
});
