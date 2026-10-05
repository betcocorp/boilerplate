import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-355 / B0-356 — the `recommend_cross_reference` backstop and the enforcement of the engine's
 * own verdict, exercised through the real workflow against an in-memory Supabase double (same
 * harness shape as `workflow-instrumentation.test.ts`).
 *
 * B0-355's three cases: the model called the engine itself (no double-invoke), the model skipped it
 * (the backstop fires), and a confident legacy match (no fire, zero web spend).
 * B0-356: the engine's decline is surfaced verbatim, its `overallConfidence` caps the run, and a
 * validator-forced `escalated` reaches the human-review queue instead of the user.
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
    schema(_name: string) {
      return { from: (_table: string) => emptySelectChain };
    },
    from(table: string) {
      return {
        // The audit-log queue (B0-439) inserts a BATCH; every other writer inserts one row.
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
 * `extractCompetitorProduct` (schema `competitor_extract`) is the only consumer of this mock in
 * this file (the LLM router is off, so `classifyUserIntent` never calls it). Defaults to a
 * confident extraction so the pre-existing backstop tests below keep exercising "a real competitor
 * was resolved" — B0-779's own tests override this per-case to exercise the degraded/unresolved
 * shape instead.
 */
const competitorExtractionMock = vi.fn();

vi.mock('~/lib/openai/client', () => ({
  getOpenAIClient: () => ({
    responses: { create: (...args: unknown[]) => competitorExtractionMock(...args) },
  }),
  resolveResponsesModel: () => 'gpt-test',
}));

function mockCompetitorExtraction(extraction: { brand: string | null; product: string | null }) {
  competitorExtractionMock.mockResolvedValue({
    output_text: JSON.stringify({ ...extraction, otherCompetitorProduct: null }),
  });
}

const runGenerationLoopMock = vi.fn();
const executeProductToolMock = vi.fn();
const lookupCrossReferenceMock = vi.fn();
const runCrossReferenceRecommendationMock = vi.fn();

vi.mock('~/lib/bex/ai-sdk-runtime', () => ({
  runAiSdkWithToolLoop: (...args: unknown[]) => runGenerationLoopMock(...args),
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

import { CROSS_REFERENCE_CLAIMS_NON_TRANSFER_STATEMENT } from '~/lib/agents/cross-reference-specialist/cross-reference-specialist-system-prompt';
import { XREF_DECLINE_COPY } from '~/lib/recommendations/confidence-scoring';
import { buildCompetitorIdentityClarification } from '~/lib/recommendations/cross-reference-decline';
import { resetIntentClassifierCache } from '~/lib/orchestrator/intent-classifier';
import { runProductSupportWorkflow } from '~/lib/workflows/product-support/run-product-support-workflow';
import { readStepGateRecords } from '~/lib/workflows/product-support/product-support-schemas';

const XREF_MESSAGE = 'What is the Betco equivalent to BNC-15?';

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
      title: 'Triforce label',
      snippet: 'A general purpose cleaner.',
      documentBody: 'A general purpose cleaner.',
      documentKind: 'label',
      similarity: 0.72,
    },
  ],
};

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
      assistantText: 'Betco Triforce is the closest equivalent to BNC-15.',
      toolTrace: [],
      responseIds: ['resp_1'],
      usage: AGENT_USAGE,
      usageByCall: [AGENT_USAGE],
    };
  };
}

function engineResult(overrides: Record<string, unknown> = {}) {
  return {
    source: 'web',
    answered: true,
    status: 'answered',
    overallConfidence: 0.83,
    thresholdUsed: 0.8,
    candidates: [{ betcoTitle: 'Triforce', url: null, rationale: null, rank: 1, tier: 'primary' }],
    evidence: {},
    declineReason: null,
    recommendationId: 'rec-1',
    ...overrides,
  };
}

function steps(): Row[] {
  return fake.tables.workflow_steps ?? [];
}

function stepOutput(name: string): Record<string, unknown> {
  const step = steps().find((row) => row.step_name === name);
  expect(step, `expected a "${name}" step`).toBeDefined();
  return (step as Row).output as Record<string, unknown>;
}

function auditRows(eventType: string): Array<Record<string, unknown>> {
  return (fake.tables.audit_logs ?? [])
    .filter((row) => row.event_type === eventType)
    .map((row) => row.payload as Record<string, unknown>);
}

async function run(overrides: Row = {}) {
  return runProductSupportWorkflow({
    traceId: 'trace-1',
    conversationId: 'conversation-1',
    userMessage: XREF_MESSAGE,
    source: 'chat',
    ...(overrides as Record<string, unknown>),
  } as Parameters<typeof runProductSupportWorkflow>[0]);
}

beforeEach(() => {
  fake = createFakeSupabase();
  vi.clearAllMocks();
  settingOverrides.clear();
  settingOverrides.set('BEX_LLM_ROUTER_ENABLED', false);
  // B0-734 — settings row, default false; these tests assert the gate-on world.
  settingOverrides.set('BEX_EARLY_DECLINE_GATE_ENABLED', true);
  // B0-756 — BEX_DISABLE_RECOMMENDATION_CONFIDENCE_GATING now defaults to bypassed (true) in
  // production pending a scorer fix, but this file's recommendation-engine-verdict tests were
  // written against the gate-on world; pin it off so the engine's decline/approval enforcement
  // keeps being exercised.
  settingOverrides.set('BEX_DISABLE_RECOMMENDATION_CONFIDENCE_GATING', false);
  resetIntentClassifierCache();

  // Default: `extractCompetitorProduct` confidently resolves "BNC-15" (no brand named in
  // XREF_MESSAGE, but a real product) — a resolved identity, not the raw-message fallback.
  mockCompetitorExtraction({ brand: null, product: 'BNC-15' });

  // Default: the model calls only `lookup_cross_reference`, which finds nothing.
  runGenerationLoopMock.mockImplementation(
    generationCalling([
      {
        name: 'lookup_cross_reference',
        argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC-15' }),
        callId: 'call_xref',
      },
    ]),
  );
  executeProductToolMock.mockImplementation(async (name: string) =>
    name === 'lookup_cross_reference' ? { matches: [], fallbackRecommended: true } : RAG_SOURCES,
  );
  lookupCrossReferenceMock.mockResolvedValue({ matches: [], fallbackRecommended: true });
  runCrossReferenceRecommendationMock.mockResolvedValue(engineResult());
});

/* ---------------------------------------------------------------- B0-355 -- */

describe('recommend_cross_reference invocation backstop (B0-355)', () => {
  it('fires when the model skipped the engine and legacy found nothing', async () => {
    await run();

    expect(runCrossReferenceRecommendationMock).toHaveBeenCalledTimes(1);
    const [payload] = auditRows('recommendation_backstop');
    expect(payload).toMatchObject({
      fired: true,
      reason: 'legacy_missing_model_skipped',
      model_called_engine: false,
    });
  });

  it('fires when legacy matched but recommended a fallback (the case B0-183 missed)', async () => {
    lookupCrossReferenceMock.mockResolvedValue({
      fallbackRecommended: true,
      matches: [
        {
          competitorBrand: 'BNC',
          competitorProductName: 'BNC-15',
          productKey: 'weak-match',
          confidence: 0.41,
          betcoProduct: { title: 'Weak match' },
        },
      ],
    });
    executeProductToolMock.mockImplementation(async (name: string) =>
      name === 'lookup_cross_reference'
        ? {
            fallbackRecommended: true,
            matches: [
              {
                competitorBrand: 'BNC',
                competitorProductName: 'BNC-15',
                productKey: 'weak-match',
                confidence: 0.41,
                betcoProduct: { title: 'Weak match' },
              },
            ],
          }
        : RAG_SOURCES,
    );

    await run();

    expect(runCrossReferenceRecommendationMock).toHaveBeenCalledTimes(1);
    expect(auditRows('recommendation_backstop')[0]).toMatchObject({
      fired: true,
      reason: 'legacy_fallback_recommended_model_skipped',
      legacy_match_present: true,
      legacy_fallback_recommended: true,
    });
  });

  it('does NOT double-invoke when the model called recommend_cross_reference itself', async () => {
    runGenerationLoopMock.mockImplementation(
      generationCalling([
        {
          name: 'lookup_cross_reference',
          argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC-15' }),
          callId: 'call_xref',
        },
        {
          name: 'recommend_cross_reference',
          argumentsJson: JSON.stringify({ competitorProduct: 'BNC-15' }),
          callId: 'call_engine',
        },
      ]),
    );
    executeProductToolMock.mockImplementation(async (name: string) => {
      if (name === 'lookup_cross_reference') {
        return { matches: [], fallbackRecommended: true };
      }
      if (name === 'recommend_cross_reference') {
        return { ok: true, adapter: 'cross_reference_recommendation_v1', ...engineResult() };
      }
      return RAG_SOURCES;
    });

    await run();

    expect(runCrossReferenceRecommendationMock).not.toHaveBeenCalled();
    expect(auditRows('recommendation_backstop')[0]).toMatchObject({
      fired: false,
      reason: 'model_called_engine',
      model_called_engine: true,
    });
  });

  it('does NOT fire on a confident legacy match — that path stays zero-web-spend', async () => {
    const confident = {
      fallbackRecommended: false,
      matches: [
        {
          competitorBrand: 'BNC',
          competitorProductName: 'BNC-15',
          productKey: 'triforce',
          confidence: 0.92,
          productUrl: 'https://www.betco.com/products/triforce',
          betcoProduct: { title: 'Triforce', sku: '1234' },
          rationale: 'curated equivalence',
        },
      ],
    };
    lookupCrossReferenceMock.mockResolvedValue(confident);
    executeProductToolMock.mockImplementation(async (name: string) =>
      name === 'lookup_cross_reference' ? confident : RAG_SOURCES,
    );

    await run();

    expect(runCrossReferenceRecommendationMock).not.toHaveBeenCalled();
    expect(auditRows('recommendation_backstop')[0]).toMatchObject({
      fired: false,
      reason: 'confident_legacy_match',
    });
  });

  it('records the forced invocation as a workflow_injected tool call, not a model-chosen one', async () => {
    await run();

    const trace = stepOutput('openai_responses_agent').toolTrace as Array<Record<string, unknown>>;
    const engineCall = trace.find((entry) => entry.toolName === 'recommend_cross_reference');
    expect(engineCall).toBeDefined();
    expect(engineCall?.origin).toBe('workflow_injected');
  });

  it('hands the backstop the remaining turn budget, not a fresh full one', async () => {
    settingOverrides.set('XREF_RECOMMENDATION_TIMEOUT_MS', 25_000);
    await run();

    const [, , deps] = runCrossReferenceRecommendationMock.mock.calls[0] as [
      unknown,
      unknown,
      { policy: { totalBudgetMs: number } },
    ];
    expect(deps.policy.totalBudgetMs).toBeGreaterThan(0);
    expect(deps.policy.totalBudgetMs).toBeLessThanOrEqual(25_000);
  });
});

/* ---------------------------------------------------------------- B0-356 -- */

describe('recommendation engine verdict enforcement (B0-356)', () => {
  it('surfaces the engine decline verbatim instead of the model prose', async () => {
    runCrossReferenceRecommendationMock.mockResolvedValue(
      engineResult({
        answered: false,
        status: 'declined',
        overallConfidence: 0.35,
        declineReason: XREF_DECLINE_COPY,
        candidates: [],
      }),
    );

    const out = await run();

    expect(out.answerText).toBe(XREF_DECLINE_COPY);
    expect(out.answerProvenance).toBe('recommendation_engine_decline');
    expect(out.validation.approved).toBe(false);
  });

  it('never lets the workflow 0.9 default exceed the engine overallConfidence', async () => {
    runCrossReferenceRecommendationMock.mockResolvedValue(
      engineResult({ overallConfidence: 0.61 }),
    );

    const out = await run();

    expect(out.confidence).toBeLessThanOrEqual(0.61);
  });

  it("routes the engine's validator-forced 'escalated' to human review, not to the user", async () => {
    runCrossReferenceRecommendationMock.mockResolvedValue(
      engineResult({
        answered: false,
        status: 'escalated',
        overallConfidence: 0.81,
        declineReason: XREF_DECLINE_COPY,
        candidates: [],
      }),
    );

    const out = await run();

    expect(out.validation.requires_human_review).toBe(true);
    expect(out.validation.issues).toContain('recommendation_engine_escalated');
    expect(out.answerText).toBe(XREF_DECLINE_COPY);
  });

  it('treats a B0-329 latency-ceiling trip as a user-visible decline, not a low-confidence answer', async () => {
    runCrossReferenceRecommendationMock.mockResolvedValue(
      engineResult({
        source: 'legacy',
        answered: false,
        status: 'declined',
        overallConfidence: 0.55,
        declineReason: XREF_DECLINE_COPY,
        candidates: [],
        evidence: { timeout: { timedOut: true, reason: 'latency_ceiling' } },
      }),
    );

    const out = await run();

    expect(out.answerText).toBe(XREF_DECLINE_COPY);
    expect(out.validation.issues).toContain('recommendation_engine_declined');
    expect(out.validation.requires_human_review).toBe(false);
  });

  it('persists thresholdUsed and source on the validator step so the two numbers reconcile', async () => {
    runCrossReferenceRecommendationMock.mockResolvedValue(
      engineResult({ overallConfidence: 0.61, thresholdUsed: 0.8 }),
    );

    await run();

    const record = readStepGateRecords(stepOutput('validator')).find(
      (r) => r.gate === 'recommendation_engine_verdict',
    );
    expect(record).toBeDefined();
    expect(record?.thresholds).toMatchObject({ thresholdUsed: 0.8 });
    expect(record?.inputs).toMatchObject({
      source: 'web',
      invocation: 'backstop',
      overallConfidence: 0.61,
    });
  });

  it('under the B0-452 kill switch: cap suppressed, decline + escalation still enforced', async () => {
    // B0-756 — the recommendation engine verdict's numeric cap moved to the split,
    // recommendation-only kill switch; the general BEX_DISABLE_CONFIDENCE_GATING no longer
    // affects it (that's the whole point of the split).
    settingOverrides.set('BEX_DISABLE_RECOMMENDATION_CONFIDENCE_GATING', true);
    runCrossReferenceRecommendationMock.mockResolvedValue(
      engineResult({
        answered: false,
        status: 'escalated',
        overallConfidence: 0.2,
        declineReason: XREF_DECLINE_COPY,
        candidates: [],
      }),
    );

    const out = await run();

    // The run stays identifiable as kill-switched.
    expect(out.runtimeConfig?.recommendationConfidenceGatingDisabled).toBe(true);
    expect(out.activeGates?.recommendationEngineVerdict?.state).toBe('bypassed');
    // Cap not enforced...
    expect(out.confidence).toBeGreaterThan(0.2);
    // ...but the engine's own verdict still is.
    expect(out.answerText).toBe(XREF_DECLINE_COPY);
    expect(out.validation.requires_human_review).toBe(true);
  });
});

/* ---------------------------------------------------------------- B0-358 -- */

describe('validator mode legibility (B0-358)', () => {
  it('records validatorMode "bypassed" on the run and the validator step by default', async () => {
    const out = await run();

    expect(out.validatorMode).toBe('bypassed');
    expect(stepOutput('validator').validatorMode).toBe('bypassed');
    // The legacy token stays for historical readers, but is now redundant with the field above.
    expect(out.validation.issues).toContain('validator_bypassed_for_testing');
  });

  it('records the guardrails that ran AND PASSED, not only the ones that fired', async () => {
    await run();

    const records = readStepGateRecords(stepOutput('validator'));
    const regulated = records.find((r) => r.gate === 'regulated_claim_guardrail');
    expect(regulated?.verdict).toBe('passed');
  });
});

/* ---------------------------------------------------------------- B0-779 -- */

/**
 * The message names no specific competitor brand or product — the "replace my current X" shape
 * from PRO-045/PRO-036 — but still carries a decisive cross-reference phrase ("equivalent to") so
 * it still forces the lookup path.
 */
const UNRESOLVED_XREF_MESSAGE = "What's the Betco equivalent to what we're currently using?";

describe('competitor identity guard against a fabricated match (B0-779)', () => {
  it('never invokes the engine, and declines, when extractCompetitorProduct is fully unresolved', async () => {
    mockCompetitorExtraction({ brand: null, product: null });

    const out = await run({ userMessage: UNRESOLVED_XREF_MESSAGE });

    expect(runCrossReferenceRecommendationMock).not.toHaveBeenCalled();
    // B0-875 — the clarifying ask for brand + product name, not the fixed sales-rep copy.
    expect(out.answerText).toBe(
      buildCompetitorIdentityClarification({ userMessage: UNRESOLVED_XREF_MESSAGE }),
    );
    expect(out.answerText).toContain('brand and the exact product name');
    expect(out.answerText).not.toContain('Comparable Betco product');
    expect(out.answerProvenance).toBe('competitor_identity_unresolved_decline');
  });

  it('overrides a model-drafted match line even when the model called recommend_cross_reference itself with the same unresolved identity (PRO-045/PRO-036 shape)', async () => {
    mockCompetitorExtraction({ brand: null, product: null });
    runGenerationLoopMock.mockImplementation(
      generationCalling([
        {
          name: 'lookup_cross_reference',
          argumentsJson: JSON.stringify({ brand: '', productName: UNRESOLVED_XREF_MESSAGE }),
          callId: 'call_xref',
        },
        {
          name: 'recommend_cross_reference',
          argumentsJson: JSON.stringify({ competitorProduct: UNRESOLVED_XREF_MESSAGE }),
          callId: 'call_engine',
        },
      ]),
    );
    executeProductToolMock.mockImplementation(async (name: string) => {
      if (name === 'lookup_cross_reference') {
        return { matches: [], fallbackRecommended: true };
      }
      if (name === 'recommend_cross_reference') {
        // The engine itself (wrongly) approved a match built from the raw message — the exact
        // PRO-045 shape (a fabricated, "answered: true" candidate with a URL).
        return {
          ok: true,
          adapter: 'cross_reference_recommendation_v1',
          ...engineResult({
            candidates: [
              {
                betcoTitle: 'Portable Chemical Management System',
                url: 'https://www.betco.com/products/portable-chemical-management-system',
                rationale: null,
                rank: 1,
                tier: 'primary',
              },
            ],
          }),
        };
      }
      return RAG_SOURCES;
    });

    const out = await run({ userMessage: UNRESOLVED_XREF_MESSAGE });

    // The backstop never fires (model called the engine itself)...
    expect(runCrossReferenceRecommendationMock).not.toHaveBeenCalled();
    // ...but the unresolved-identity guard still overrides whatever the model drafted.
    expect(out.answerText).toBe(
      buildCompetitorIdentityClarification({ userMessage: UNRESOLVED_XREF_MESSAGE }),
    );
    expect(out.answerText).not.toContain('Comparable Betco product');
    expect(out.answerProvenance).toBe('competitor_identity_unresolved_decline');
  });

  it('does NOT change the confident-match path — a brand-only (no product) resolution still lets the engine answer', async () => {
    // Confidently resolved brand, no specific product named — NOT the unresolved shape (AC: no
    // change to a correctly resolved competitor).
    mockCompetitorExtraction({ brand: 'Spartan', product: null });

    await run();

    expect(runCrossReferenceRecommendationMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT change the confident-match path — a resolved product with no brand still lets the engine answer', async () => {
    mockCompetitorExtraction({ brand: null, product: 'BNC-15' });

    const out = await run();

    expect(runCrossReferenceRecommendationMock).toHaveBeenCalledTimes(1);
    expect(out.answerProvenance).not.toBe('competitor_identity_unresolved_decline');
  });
});

/* ---------------------------------------------------------------- B0-875 -- */

describe('question-aware cross-reference declines (B0-875)', () => {
  it('P#8: a chemistry-class description withdraws the cross-reference path and asks which product', async () => {
    mockCompetitorExtraction({ brand: 'Diversey', product: 'quat disinfectant' });

    const out = await run({
      userMessage: 'What is the Betco equivalent to a Diversey quat disinfectant?',
    });

    // No forced legacy lookup, no web backstop — nothing to look up until a product is named.
    expect(lookupCrossReferenceMock).not.toHaveBeenCalled();
    expect(runCrossReferenceRecommendationMock).not.toHaveBeenCalled();
    expect(out.answerProvenance).toBe('generic_chemistry_clarification');
    expect(out.answerText).toContain('"diversey quat disinfectant" describes a chemistry class');
    expect(out.answerText).toContain('EPA registration number');
    expect(out.answerText).toContain('dilution, contact time and organism claims');
    expect(out.answerText).not.toContain('Comparable Betco product');
    expect(out.answerText).not.toMatch(/AF79|Triforce/);
    expect(auditRows('cross_reference_self_reference_suppressed')[0]).toMatchObject({
      reason: 'generic_chemistry_description',
      matched: 'diversey quat disinfectant',
    });
  });

  it('P#9: a claim-equivalence question leads with the non-transfer statement, engine decline verbatim after it', async () => {
    runCrossReferenceRecommendationMock.mockResolvedValue(
      engineResult({
        answered: false,
        status: 'declined',
        overallConfidence: 0.35,
        declineReason: XREF_DECLINE_COPY,
        candidates: [],
      }),
    );

    // The golden P#9 phrasing ("Betco's version of BNC-15 kills everything BNC-15 does, right?")
    // is routed to cross-reference by the LLM router live; this harness runs the keyword router
    // only, so the claim question is carried on a phrase the keyword router treats as decisive.
    const out = await run({
      userMessage: 'Does the Betco equivalent to BNC-15 have the same kill claims as BNC-15?',
    });

    expect(out.answerProvenance).toBe('recommendation_engine_decline');
    expect(out.answerText.startsWith('Kill claims do not transfer between products.')).toBe(true);
    expect(out.answerText).toContain(CROSS_REFERENCE_CLAIMS_NON_TRANSFER_STATEMENT);
    expect(out.answerText.endsWith(XREF_DECLINE_COPY)).toBe(true);
  });

  it('a resolved competitor the engine simply cannot match keeps the sales-rep copy unchanged', async () => {
    runCrossReferenceRecommendationMock.mockResolvedValue(
      engineResult({
        answered: false,
        status: 'declined',
        overallConfidence: 0.35,
        declineReason: XREF_DECLINE_COPY,
        candidates: [],
      }),
    );

    const out = await run();

    expect(out.answerText).toBe(XREF_DECLINE_COPY);
    expect(out.answerProvenance).toBe('recommendation_engine_decline');
  });
});

/* ---------------------------------------------------------------- B0-876 -- */

describe('Betco line-prefix self-reference (B0-876)', () => {
  it('P#19: "GE Fight Bac RTU" is Betco\'s — no forced lookup, no backstop, no cross-reference decline', async () => {
    mockCompetitorExtraction({ brand: 'GE', product: 'Fight Bac RTU' });

    const out = await run({ userMessage: 'What is the Betco equivalent to GE Fight Bac RTU?' });

    expect(lookupCrossReferenceMock).not.toHaveBeenCalled();
    expect(runCrossReferenceRecommendationMock).not.toHaveBeenCalled();
    expect(out.answerProvenance).not.toBe('recommendation_engine_decline');
    expect(out.answerProvenance).not.toBe('competitor_identity_unresolved_decline');
    expect(out.answerText).not.toBe(XREF_DECLINE_COPY);
    expect(auditRows('cross_reference_self_reference_suppressed')[0]).toMatchObject({
      reason: 'betco_catalog',
      matched: 'ge fight bac rtu',
      final_route: 'product',
    });
  });

  it('a genuine competitor (Spartan BNC-15) still routes to cross-reference and reaches the backstop', async () => {
    mockCompetitorExtraction({ brand: 'Spartan', product: 'BNC-15' });

    await run();

    expect(runCrossReferenceRecommendationMock).toHaveBeenCalledTimes(1);
    expect(auditRows('cross_reference_self_reference_suppressed')).toHaveLength(0);
  });
});
