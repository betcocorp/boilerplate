import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-751 — the competitor self-reference check, exercised through the real workflow against the
 * same in-memory Supabase double as `xref-backstop-integration.test.ts`. The LLM router is ON here
 * (unlike that file) because the check sits between the classifier's verdict and the final routing
 * decision: the classifier is driven through the mocked `client.responses.create`, keyed on the
 * structured-output schema name, and so is `extractCompetitorProduct`, so the test can count how
 * many extraction calls a turn paid for.
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
  // B0-899 — resolveModel resolves the `preview` tag through this getter. Defaults to 'openai' so
  // these fixtures keep resolving preview to the BEX_RESPONSES_MODEL (OpenAI) row as they always
  // have; a test that wants the Anthropic path sets BEX_LLM_PROVIDER in settingOverrides.
  getLlmProvider: vi.fn(() =>
    Promise.resolve(
      settingOverrides.has('BEX_LLM_PROVIDER')
        ? (settingOverrides.get('BEX_LLM_PROVIDER') as 'openai' | 'anthropic')
        : 'openai',
    ),
  ),
}));

/**
 * Both `classifyUserIntent` (schema `intent_classification`) and `extractCompetitorProduct`
 * (schema `competitor_extract`) go through this one call; each test sets the two payloads.
 */
const openaiResponsesCreateMock = vi.fn();

vi.mock('~/lib/openai/client', () => ({
  getOpenAIClient: () => ({
    responses: { create: (...args: unknown[]) => openaiResponsesCreateMock(...args) },
  }),
  resolveResponsesModel: () => 'gpt-test',
}));

const runResponsesWithToolLoopMock = vi.fn();
const executeProductToolMock = vi.fn();
const lookupCrossReferenceMock = vi.fn();
const runCrossReferenceRecommendationMock = vi.fn();
const resolveProductEntityByNameMock = vi.fn();

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
  lookupCrossReference: (...args: unknown[]) => lookupCrossReferenceMock(...args),
  fetchRecommendationContext: async () => ({ betcoEpaRegistration: null, alternatives: [] }),
}));

vi.mock('~/lib/recommendations/persist-recommendation', () => ({
  runCrossReferenceRecommendation: (...args: unknown[]) =>
    runCrossReferenceRecommendationMock(...args),
}));

vi.mock('~/lib/rag/entity-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/rag/entity-context')>();
  return {
    ...actual,
    resolveProductEntityByName: (...args: unknown[]) => resolveProductEntityByNameMock(...args),
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
      // B0-888 — the workflow now reads this field to record `groundingMode` on the gate record.
      keyTermGroundedCategories: [],
    }),
  };
});

import { resetIntentClassifierCache } from '~/lib/orchestrator/intent-classifier';
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
      title: 'Speedex label',
      snippet: 'A heavy duty degreaser.',
      documentBody: 'A heavy duty degreaser.',
      documentKind: 'label',
      similarity: 0.72,
    },
  ],
};

const NO_RESOLUTION = {
  productLineKey: null,
  productKey: null,
  resolutionSource: null,
  ambiguousAlias: false,
  matchedAliasId: null,
  matchedAliasConfidence: null,
};

const PINNED_XREF_TOOL_CHOICE = { type: 'function', name: 'lookup_cross_reference' };

type ExecuteTool = (input: {
  name: string;
  argumentsJson: string;
  callId: string;
}) => Promise<{ output: string }>;

function generationCalling(calls: Array<{ name: string; argumentsJson: string; callId: string }>) {
  return async (opts: unknown) => {
    const { executeTool } = opts as { executeTool: ExecuteTool };
    for (const call of calls) {
      await executeTool(call);
    }
    return {
      lastResponse: {},
      finalResponseId: 'resp_final',
      assistantText: 'Both are Betco products; here is how they differ.',
      toolTrace: [],
      responseIds: ['resp_1'],
      usage: AGENT_USAGE,
      usageByCall: [AGENT_USAGE],
    };
  };
}

type ClassifierEntities = {
  betcoProduct: string | null;
  competitorBrand: string | null;
  competitorProduct: string | null;
  surfaceType: string | null;
  taskDescription: string | null;
};

function classifierPayload(intent: string, entities: Partial<ClassifierEntities> = {}) {
  return {
    intent,
    confidence: 0.87,
    entities: {
      betcoProduct: null,
      competitorBrand: null,
      competitorProduct: null,
      surfaceType: null,
      taskDescription: null,
      brandFamily: null,
      setting: null,
      productCategory: null,
      carriedProduct: null,
      ...entities,
    },
    suggestedTool: null,
  };
}

/** Wires the classifier and the extraction step to the two schema-tagged `responses.create` calls. */
function mockLlmCalls(input: {
  classifier: Record<string, unknown>;
  extraction?: { brand: string | null; product: string | null };
}) {
  openaiResponsesCreateMock.mockImplementation(async (body: unknown) => {
    const schemaName = (body as { text?: { format?: { name?: string } } })?.text?.format?.name;
    if (schemaName === 'intent_classification') {
      return { output_text: JSON.stringify(input.classifier) };
    }
    if (schemaName === 'competitor_extract') {
      if (!input.extraction) {
        throw new Error('competitor_extract was not expected on this turn');
      }
      return {
        output_text: JSON.stringify({ ...input.extraction, otherCompetitorProduct: null }),
      };
    }
    throw new Error(`unmocked responses.create call for schema "${schemaName}"`);
  });
}

function extractionCallCount(): number {
  return openaiResponsesCreateMock.mock.calls.filter(
    ([body]) =>
      (body as { text?: { format?: { name?: string } } })?.text?.format?.name ===
      'competitor_extract',
  ).length;
}

function firstToolChoice(): unknown {
  const [opts] = runResponsesWithToolLoopMock.mock.calls[0] as [{ toolChoice: unknown }];
  return opts.toolChoice;
}

function auditRows(eventType: string): Array<Record<string, unknown>> {
  return (fake.tables.audit_logs ?? [])
    .filter((row) => row.event_type === eventType)
    .map((row) => row.payload as Record<string, unknown>);
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
  // The check sits downstream of the LIVE classifier, so the router is on and shadow mode is off.
  settingOverrides.set('BEX_LLM_ROUTER_ENABLED', true);
  settingOverrides.set('BEX_LLM_ROUTER_SHADOW_MODE', false);
  settingOverrides.set('BEX_EARLY_DECLINE_GATE_ENABLED', false);
  resetIntentClassifierCache();

  runResponsesWithToolLoopMock.mockImplementation(
    generationCalling([
      {
        name: 'search_product_docs',
        argumentsJson: JSON.stringify({ productName: 'Speedex' }),
        callId: 'call_docs',
      },
    ]),
  );
  executeProductToolMock.mockImplementation(async (name: string) =>
    name === 'lookup_cross_reference' ? { matches: [], fallbackRecommended: true } : RAG_SOURCES,
  );
  lookupCrossReferenceMock.mockResolvedValue({ matches: [], fallbackRecommended: true });
  runCrossReferenceRecommendationMock.mockResolvedValue({
    source: 'web',
    answered: true,
    status: 'answered',
    overallConfidence: 0.83,
    thresholdUsed: 0.8,
    candidates: [{ betcoTitle: 'Triforce', url: null, rationale: null, rank: 1, tier: 'primary' }],
    evidence: {},
    declineReason: null,
    recommendationId: 'rec-1',
  });
  resolveProductEntityByNameMock.mockResolvedValue(NO_RESOLUTION);
});

describe('competitor self-reference check (B0-751)', () => {
  it('a Betco product named as the "competitor" is re-routed to product with no pinned tool and no engine', async () => {
    mockLlmCalls({
      classifier: classifierPayload('cross_reference', { competitorProduct: 'Speedex' }),
    });
    resolveProductEntityByNameMock.mockResolvedValue({
      ...NO_RESOLUTION,
      productLineKey: 'speedex-line',
      resolutionSource: 'alias_exact_freeform',
    });

    const out = await run('Is Speedex the same thing as Speedex Concentrate?');

    expect(out.routingDecision).toBe('product');
    expect(firstToolChoice()).not.toEqual(PINNED_XREF_TOOL_CHOICE);
    // Not a cross-reference turn any more: no backstop row, no engine run, no override.
    expect(auditRows('recommendation_backstop')).toEqual([]);
    expect(runCrossReferenceRecommendationMock).not.toHaveBeenCalled();
    expect(out.answerText).toBe('Both are Betco products; here is how they differ.');
    expect(out.activeGates?.crossReferenceSelfReference).toEqual({
      state: 'ran',
      verdict: 'suppressed',
      reason: 'betco_product:speedex',
    });
    expect(auditRows('cross_reference_self_reference_suppressed')[0]).toMatchObject({
      reason: 'betco_product',
      matched: 'speedex',
      product_line_key: 'speedex-line',
      preliminary_route: 'cross_reference',
      final_route: 'product',
    });
    // The classifier extracted the entity, so the freeform resolver saw it and extraction never ran.
    expect(resolveProductEntityByNameMock).toHaveBeenCalledWith('speedex', { mode: 'freeform' });
    expect(extractionCallCount()).toBe(0);
  });

  it('a bare chemistry ("bleach") is suppressed as chemistry_term', async () => {
    mockLlmCalls({
      classifier: classifierPayload('cross_reference', { competitorProduct: 'bleach' }),
    });

    const out = await run('What do you have that replaces bleach?');

    expect(out.routingDecision).toBe('product');
    expect(firstToolChoice()).not.toEqual(PINNED_XREF_TOOL_CHOICE);
    expect(runCrossReferenceRecommendationMock).not.toHaveBeenCalled();
    expect(out.activeGates?.crossReferenceSelfReference).toEqual({
      state: 'ran',
      verdict: 'suppressed',
      reason: 'chemistry_term:bleach',
    });
    // Chemistry is decided before the resolver is consulted.
    expect(resolveProductEntityByNameMock).not.toHaveBeenCalled();
  });

  it('B0-887: "Diversey quat disinfectant" is suppressed as generic_chemistry_description and the draft is replaced with the clarifying question', async () => {
    mockLlmCalls({
      classifier: classifierPayload('cross_reference', {
        competitorBrand: 'Diversey',
        competitorProduct: 'quat disinfectant',
      }),
    });

    const out = await run('I need a Betco replacement for a Diversey quat disinfectant. Which one?');

    expect(out.routingDecision).toBe('product');
    expect(firstToolChoice()).not.toEqual(PINNED_XREF_TOOL_CHOICE);
    expect(runCrossReferenceRecommendationMock).not.toHaveBeenCalled();
    expect(out.activeGates?.crossReferenceSelfReference).toEqual({
      state: 'ran',
      verdict: 'suppressed',
      reason: 'generic_chemistry_description:diversey quat disinfectant',
    });
    // The draft is REPLACED with the clarifying question — never a specific Betco product
    // recommendation (with a regulated dilution ratio) for an unnamed competitor product.
    expect(out.answerProvenance).toBe('generic_chemistry_clarification');
    expect(out.answerText).not.toBe('Both are Betco products; here is how they differ.');
    // Chemistry-class shape is decided before the resolver is consulted.
    expect(resolveProductEntityByNameMock).not.toHaveBeenCalled();
  });

  it('regression: "what replaces quats?" (no brand) stays chemistry_term / product policy, not a clarification', async () => {
    mockLlmCalls({
      classifier: classifierPayload('cross_reference', { competitorProduct: 'quats' }),
    });

    const out = await run('What replaces quats?');

    expect(out.routingDecision).toBe('product');
    expect(firstToolChoice()).not.toEqual(PINNED_XREF_TOOL_CHOICE);
    expect(out.activeGates?.crossReferenceSelfReference).toEqual({
      state: 'ran',
      verdict: 'suppressed',
      reason: 'chemistry_term:quats',
    });
    // Not the B0-887 clarification path — a bare chemistry with no brand keeps answering with the
    // product specialist's alternative-chemistry list (product-support-prompts.ts).
    expect(out.answerProvenance).not.toBe('generic_chemistry_clarification');
  });

  it('a whole-catalog conversion-list ask is suppressed without paying for an extraction call', async () => {
    mockLlmCalls({
      classifier: classifierPayload('cross_reference', { competitorBrand: 'Spartan' }),
    });

    const out = await run(
      'Our distributor asked for a full cross-reference list for their Spartan conversion',
    );

    // Decision: the route leaves `cross_reference` too. Every engine site (`competitorIdentityNeeded`,
    // `useCrossReferencePostProcessing`, the backstop, the engine gate) keys on that route, so
    // staying on it would still let the engine's decline replace the answer.
    expect(out.routingDecision).toBe('product');
    expect(firstToolChoice()).not.toEqual(PINNED_XREF_TOOL_CHOICE);
    expect(runCrossReferenceRecommendationMock).not.toHaveBeenCalled();
    expect(out.activeGates?.crossReferenceSelfReference).toMatchObject({
      state: 'ran',
      verdict: 'suppressed',
      reason: expect.stringMatching(/^conversion_list_ask:/),
    });
    expect(extractionCallCount()).toBe(0);
    expect(resolveProductEntityByNameMock).not.toHaveBeenCalled();
  });

  it('a genuine competitor passes: tool pinned, backstop evaluated, gate ran/passed', async () => {
    mockLlmCalls({
      classifier: classifierPayload('cross_reference', {
        competitorBrand: 'Spartan',
        competitorProduct: 'Spartan Xtreme Blue',
      }),
      extraction: { brand: 'Spartan', product: 'Xtreme Blue' },
    });
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling([
        {
          name: 'lookup_cross_reference',
          argumentsJson: JSON.stringify({ brand: 'Spartan', productName: 'Xtreme Blue' }),
          callId: 'call_xref',
        },
      ]),
    );

    const out = await run("What's the Betco equivalent to Spartan Xtreme Blue?");

    expect(out.routingDecision).toBe('cross_reference');
    expect(firstToolChoice()).toEqual(PINNED_XREF_TOOL_CHOICE);
    expect(auditRows('recommendation_backstop')[0]).toMatchObject({
      fired: true,
      reason: 'legacy_missing_model_skipped',
    });
    expect(runCrossReferenceRecommendationMock).toHaveBeenCalledTimes(1);
    expect(out.activeGates?.crossReferenceSelfReference).toEqual({ state: 'ran', verdict: 'passed' });
    expect(auditRows('cross_reference_self_reference_suppressed')).toEqual([]);
    // A named non-Betco brand settles the question on its own, so no catalog/alias lookup runs at
    // all — the check can never product-match its way past a real competitor.
    expect(resolveProductEntityByNameMock).not.toHaveBeenCalled();
    // Classifier entities fed the check; the B0-357 extraction still ran exactly once downstream.
    expect(extractionCallCount()).toBe(1);
  });

  it('when the classifier extracted no entities, the one extraction call is shared with the engine path', async () => {
    mockLlmCalls({
      classifier: classifierPayload('cross_reference'),
      extraction: { brand: 'BNC', product: 'BNC-15' },
    });
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling([
        {
          name: 'lookup_cross_reference',
          argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC-15' }),
          callId: 'call_xref',
        },
      ]),
    );

    const out = await run('What is the Betco equivalent to BNC-15?');

    expect(out.routingDecision).toBe('cross_reference');
    expect(out.activeGates?.crossReferenceSelfReference).toEqual({ state: 'ran', verdict: 'passed' });
    // Brand 'BNC' is not ours, so the check settles on the brand alone — see the Spartan case.
    expect(resolveProductEntityByNameMock).not.toHaveBeenCalled();
    // Awaited early for the check, then reused as `resolvedCompetitorPromise`: ONE call, not two.
    expect(extractionCallCount()).toBe(1);
    expect(runCrossReferenceRecommendationMock).toHaveBeenCalledWith(
      { competitorProduct: 'BNC-15', competitorBrand: 'BNC' },
      expect.anything(),
      expect.anything(),
    );
  });

  it('when extraction returns a Betco brand, the turn is suppressed as betco_brand', async () => {
    mockLlmCalls({
      classifier: classifierPayload('cross_reference'),
      extraction: { brand: 'Betco', product: 'Grease Solv' },
    });

    const out = await run('Give me a cheaper alternative to Grease Solv.');

    expect(out.routingDecision).toBe('product');
    expect(runCrossReferenceRecommendationMock).not.toHaveBeenCalled();
    expect(out.activeGates?.crossReferenceSelfReference).toEqual({
      state: 'ran',
      verdict: 'suppressed',
      reason: 'betco_brand:betco',
    });
    expect(extractionCallCount()).toBe(1);
  });

  it('a resolver failure fails open: the turn stays cross-reference', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockLlmCalls({
      classifier: classifierPayload('cross_reference', { competitorProduct: 'Speedex' }),
      extraction: { brand: null, product: 'Speedex' },
    });
    resolveProductEntityByNameMock.mockRejectedValue(new Error('alias table unavailable'));

    const out = await run('Is Speedex the same thing as Speedex Concentrate?');

    expect(out.routingDecision).toBe('cross_reference');
    expect(firstToolChoice()).toEqual(PINNED_XREF_TOOL_CHOICE);
    expect(out.activeGates?.crossReferenceSelfReference).toEqual({ state: 'ran', verdict: 'passed' });
    warn.mockRestore();
  });

  it('a turn with no cross-reference signal never runs the check', async () => {
    mockLlmCalls({ classifier: classifierPayload('product', { betcoProduct: 'pH7Q Dual' }) });

    const out = await run('How do I use Betco pH7Q Dual on tile floors?');

    expect(out.routingDecision).toBe('product');
    expect(out.activeGates?.crossReferenceSelfReference).toEqual({ state: 'not_applicable' });
    expect(resolveProductEntityByNameMock).not.toHaveBeenCalled();
    expect(extractionCallCount()).toBe(0);
    expect(auditRows('cross_reference_self_reference_suppressed')).toEqual([]);
  });
});
