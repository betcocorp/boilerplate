import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-649 / B0-651 / B0-653 — the semantic router's integration into `runProductSupportWorkflow`.
 *
 * The assertions that matter here are precedence assertions, so both routers are mocked and SPIED
 * ON rather than eyeballed: the B0-653 AC ("when enabled and not shadow, the semantic router is the
 * ONLY router — the LLM classifier is not called") is only real if `classifyUserIntent` provably
 * receives zero calls, and the fallback safety net is only real if it provably receives one.
 *
 * No real OpenAI call is possible: `~/lib/openai/client`, `~/lib/orchestrator/semantic-router` and
 * `~/lib/orchestrator/intent-classifier` are all mocked.
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
    schema: () => ({ from: () => emptySelectChain }),
    from(table: string) {
      return {
        insert(row: Row) {
          sequence += 1;
          const inserted: Row = {
            id: `${table}-${sequence}`,
            started_at: new Date().toISOString(),
            completed_at: null,
            output: null,
            error: null,
            ...row,
          };
          rowsFor(table).push(inserted);
          const result = { data: inserted, error: null };
          return {
            select: () => ({ single: async () => result }),
            then: (resolve: (value: typeof result) => unknown) => resolve(result),
          };
        },
        update(patch: Row) {
          return {
            async eq(column: string, value: unknown) {
              for (const row of rowsFor(table)) {
                if (row[column] === value) Object.assign(row, patch);
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

vi.mock('~/lib/openai/client', () => ({
  getOpenAIClient: () => ({
    responses: {
      create: () => {
        throw new Error('no real OpenAI call may happen in this test file');
      },
    },
  }),
  resolveResponsesModel: () => 'gpt-test',
}));

/** The two routers, spied. `importOriginal` keeps the real flag getters / model resolvers. */
const classifyUserIntentMock = vi.fn();
const classifyUserIntentSemanticMock = vi.fn();

vi.mock('~/lib/orchestrator/intent-classifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/orchestrator/intent-classifier')>();
  return { ...actual, classifyUserIntent: (...args: unknown[]) => classifyUserIntentMock(...args) };
});

vi.mock('~/lib/orchestrator/semantic-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/orchestrator/semantic-router')>();
  return {
    ...actual,
    classifyUserIntentSemantic: (...args: unknown[]) => classifyUserIntentSemanticMock(...args),
  };
});

const runGenerationLoopMock = vi.fn();

vi.mock('~/lib/bex/ai-sdk-runtime', () => ({
  runAiSdkWithToolLoop: (...args: unknown[]) => runGenerationLoopMock(...args),
}));
vi.mock('~/lib/tools/product-tools', () => ({
  executeProductTool: vi.fn(async () => ({ sources: [] })),
}));
vi.mock('~/lib/tools/cross-reference-lookup', () => ({
  lookupCrossReference: vi.fn(async () => ({ matches: [], fallbackRecommended: true })),
  fetchRecommendationContext: async () => ({ betcoEpaRegistration: null, alternatives: [] }),
}));
vi.mock('~/lib/recommendations/extract-competitor-product', () => ({
  extractCompetitorProduct: vi.fn(async () => ({
    brand: null,
    product: null,
    otherCompetitorProduct: null,
  })),
}));

import type { SemanticRouteDecision } from '~/lib/orchestrator/semantic-router';
import { routeUserMessageToSme } from '~/lib/orchestrator/sme-routing';
import * as logger from '~/lib/observability/logger';
import {
  readStepGateRecords,
  runtimeConfigSchema,
  type GateId,
  type GateRecord,
} from '~/lib/workflows/product-support/product-support-schemas';
import { SEMANTIC_ROUTER_DECISION_LOG_EVENT } from '~/lib/workflows/product-support/semantic-router-decision';
import { runProductSupportWorkflow } from '~/lib/workflows/product-support/run-product-support-workflow';

/** Keyword-routes to `product` (see `sme-routing.test.ts`); the LLM/semantic mocks override that. */
const USAGE_MESSAGE = 'How do I use Betco pH7Q Dual on tile floors?';

function semanticDecision(overrides: Partial<SemanticRouteDecision> = {}): SemanticRouteDecision {
  return {
    route: 'bathroom',
    confidence: 0.71,
    similarity: 0.71,
    margin: 0.18,
    path: 'semantic',
    scores: [
      { route: 'bathroom', similarity: 0.71 },
      { route: 'product', similarity: 0.53 },
      { route: 'floor_vct', similarity: 0.41 },
    ],
    thresholds: { confidence: 0.5, margin: 0.1 },
    thresholdsPassed: { confidence: true, margin: true },
    latencyMs: 132,
    embeddingMs: 128,
    scoringMs: 4,
    embeddingModel: 'text-embedding-3-large',
    examplesVersion: 'v1',
    error: null,
    ...overrides,
  };
}

function llmClassification(intent = 'dilution') {
  return {
    intent,
    confidence: 0.82,
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
    },
    suggestedTool: null,
    source: 'llm' as const,
    fallbackReason: null,
    usage: null,
    model: 'gpt-4o-mini',
  };
}

function steps(): Row[] {
  return fake.tables.workflow_steps ?? [];
}

function plannerOutput(): Record<string, unknown> {
  const step = steps().find((row) => row.step_name === 'orchestration_planner');
  expect(step, 'expected an orchestration_planner step').toBeDefined();
  return (step as Row).output as Record<string, unknown>;
}

function gateRecordsFor(gate: GateId): GateRecord[] {
  return readStepGateRecords(plannerOutput()).filter((record) => record.gate === gate);
}

function routingBlock(): Record<string, unknown> {
  return plannerOutput().routing as Record<string, unknown>;
}

function finalRuntimeConfig() {
  const run = (fake.tables.workflow_runs ?? [])[0];
  const finalOutput = (run?.final_output ?? {}) as Record<string, unknown>;
  return runtimeConfigSchema.parse(finalOutput.runtimeConfig);
}

async function run(overrides: Row = {}) {
  return runProductSupportWorkflow({
    traceId: 'trace-semantic',
    conversationId: 'conversation-semantic',
    userMessage: USAGE_MESSAGE,
    source: 'bex_chat',
    ...overrides,
  } as Parameters<typeof runProductSupportWorkflow>[0]);
}

beforeEach(() => {
  fake = createFakeSupabase();
  vi.clearAllMocks();
  settingOverrides.clear();
  // The LLM router is on by default post-B0-511; every test here states its own router flags.
  settingOverrides.set('BEX_LLM_ROUTER_ENABLED', true);
  settingOverrides.set('BEX_LLM_ROUTER_SHADOW_MODE', false);
  classifyUserIntentMock.mockResolvedValue(llmClassification());
  classifyUserIntentSemanticMock.mockResolvedValue(semanticDecision());
  runGenerationLoopMock.mockResolvedValue({
    lastResponse: {},
    finalResponseId: 'resp_final',
    assistantText: 'Dilute per the label instructions.',
    toolTrace: [],
    responseIds: ['resp_1'],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0 },
    usageByCall: [],
  });
});

/* -------------------------------------------------------------------------- *
 * B0-649 — state 3: disabled is byte-identical to the pre-ticket path
 * -------------------------------------------------------------------------- */

describe('semantic router disabled (B0-649 state 3)', () => {
  it('never calls the semantic router and leaves the LLM classifier in charge', async () => {
    await run();

    expect(classifyUserIntentSemanticMock).not.toHaveBeenCalled();
    expect(classifyUserIntentMock).toHaveBeenCalledTimes(1);
    expect(routingBlock().decision).toBe('dilution');
    expect(gateRecordsFor('semantic_router_live')).toEqual([]);
    expect(gateRecordsFor('semantic_router_shadow')).toEqual([]);
    expect(finalRuntimeConfig()).toMatchObject({
      semanticRouterEnabled: false,
      semanticRouterShadowMode: false,
      semanticRouterPath: null,
      semanticRouterDecided: false,
    });
  });

  it('is not called for a forced direct agentMode either', async () => {
    settingOverrides.set('BEX_SEMANTIC_ROUTER_ENABLED', true);
    await run({ agentMode: 'floor_vct' });

    expect(classifyUserIntentSemanticMock).not.toHaveBeenCalled();
    expect(classifyUserIntentMock).not.toHaveBeenCalled();
    expect(routingBlock().decision).toBe('floor_vct');
  });
});

/* -------------------------------------------------------------------------- *
 * B0-653 — state 1: live cutover, the semantic router is the only router
 * -------------------------------------------------------------------------- */

describe('semantic router live (B0-649 state 1 / B0-653 cutover)', () => {
  beforeEach(() => {
    settingOverrides.set('BEX_SEMANTIC_ROUTER_ENABLED', true);
    settingOverrides.set('BEX_SEMANTIC_ROUTER_SHADOW_MODE', false);
  });

  it('routes on the semantic decision and does NOT call the LLM intent classifier', async () => {
    const result = await run();

    expect(classifyUserIntentSemanticMock).toHaveBeenCalledTimes(1);
    // The cutover claim, asserted against the dependency rather than by inspection.
    expect(classifyUserIntentMock).not.toHaveBeenCalled();
    expect(result.routingDecision).toBe('bathroom');
    expect(routingBlock().decision).toBe('bathroom');
    expect(String(routingBlock().rationale)).toContain('Semantic router');
    // The keyword gate now attributes the override to the right router.
    expect(gateRecordsFor('keyword_routing')[0]?.verdict).toBe('overridden_by_semantic_router');
    // No LLM classifier gate, because no classifier ran.
    expect(gateRecordsFor('llm_intent_classifier_live')).toEqual([]);
  });

  it('persists every B0-651 field on the semantic_router_live gate', async () => {
    await run();

    const records = gateRecordsFor('semantic_router_live');
    expect(records).toHaveLength(1);
    const record = records[0] as GateRecord;

    expect(record.verdict).toBe('agrees_with_routing_decision');
    expect(record.inputs).toMatchObject({
      semanticRoute: 'bathroom',
      semanticConfidence: 0.71,
      semanticSimilarity: 0.71,
      semanticMargin: 0.18,
      semanticPath: 'semantic',
      semanticLatencyMs: 132,
      semanticEmbeddingMs: 128,
      semanticScoringMs: 4,
      semanticEmbeddingModel: 'text-embedding-3-large',
      semanticExamplesVersion: 'v1',
      semanticError: null,
      routingDecision: 'bathroom',
      decidedBy: 'semantic_router',
    });
    // Similarity for EVERY route, not just the winner.
    expect(record.inputs.semanticScores).toEqual([
      { route: 'bathroom', similarity: 0.71 },
      { route: 'product', similarity: 0.53 },
      { route: 'floor_vct', similarity: 0.41 },
    ]);
    expect(record.thresholds).toEqual({
      confidenceThreshold: 0.5,
      marginThreshold: 0.1,
      confidenceThresholdPassed: true,
      marginThresholdPassed: true,
      mode: 'live',
    });
    expect(record.effect).toContain('The LLM intent classifier was not called.');

    expect(finalRuntimeConfig()).toMatchObject({
      semanticRouterEnabled: true,
      semanticRouterShadowMode: false,
      semanticRouterPath: 'semantic',
      semanticRouterDecided: true,
    });
  });

  it('emits one structured log line carrying every required field', async () => {
    const logInfoSpy = vi.spyOn(logger, 'logInfo');
    await run();

    const call = logInfoSpy.mock.calls.find(
      ([event]) => event === SEMANTIC_ROUTER_DECISION_LOG_EVENT,
    );
    expect(call, 'expected a semantic_router_decision log line').toBeDefined();
    expect(call?.[1]).toMatchObject({
      mode: 'live',
      route: 'bathroom',
      path: 'semantic',
      confidence: 0.71,
      similarity: 0.71,
      margin: 0.18,
      confidenceThreshold: 0.5,
      marginThreshold: 0.1,
      confidenceThresholdPassed: true,
      marginThresholdPassed: true,
      latencyMs: 132,
      embeddingMs: 128,
      scoringMs: 4,
      scores: { bathroom: 0.71, product: 0.53, floor_vct: 0.41 },
      routingDecision: 'bathroom',
      decidedBy: 'semantic_router',
    });
  });
});

/* -------------------------------------------------------------------------- *
 * B0-649 — the fallback safety net on the live path
 * -------------------------------------------------------------------------- */

describe('semantic router live fallback (B0-649 preserved safety net)', () => {
  beforeEach(() => {
    settingOverrides.set('BEX_SEMANTIC_ROUTER_ENABLED', true);
    settingOverrides.set('BEX_SEMANTIC_ROUTER_SHADOW_MODE', false);
    classifyUserIntentSemanticMock.mockResolvedValue(
      semanticDecision({
        route: 'ambiguous',
        path: 'fallback',
        confidence: 0,
        similarity: 0,
        margin: 0,
        scores: [],
        thresholdsPassed: { confidence: false, margin: false },
        error: 'embedding_request_failed',
        latencyMs: 41,
        embeddingMs: 41,
        scoringMs: 0,
      }),
    );
  });

  it('degrades to the LLM classifier — not to "ambiguous" — when the classifier is enabled', async () => {
    const result = await run();

    expect(classifyUserIntentMock).toHaveBeenCalledTimes(1);
    expect(result.routingDecision).toBe('dilution');
    const record = gateRecordsFor('semantic_router_live')[0] as GateRecord;
    expect(record.verdict).toBe('fell_back');
    expect(record.inputs).toMatchObject({
      semanticPath: 'fallback',
      semanticError: 'embedding_request_failed',
      decidedBy: 'llm_classifier',
    });
    expect(record.effect).toContain('DEGRADED');
    expect(finalRuntimeConfig()).toMatchObject({
      semanticRouterPath: 'fallback',
      semanticRouterDecided: false,
    });
  });

  it('degrades to the keyword router when the LLM classifier is kill-switched too', async () => {
    settingOverrides.set('BEX_LLM_ROUTER_ENABLED', false);
    const result = await run();

    expect(classifyUserIntentMock).not.toHaveBeenCalled();
    // The KEYWORD router's own decision for this message — the pre-LLM safety net — and
    // specifically NOT the semantic fallback's `'ambiguous'`, which is the whole point of the
    // three-state precedence.
    const keywordAgent = routeUserMessageToSme(USAGE_MESSAGE).agent;
    expect(keywordAgent).not.toBeNull();
    expect(result.routingDecision).toBe(keywordAgent);
    expect(result.routingDecision).not.toBe('ambiguous');
    expect(gateRecordsFor('semantic_router_live')[0]?.inputs.decidedBy).toBe('keyword_router');
  });

  it('logs the fallback at warn level so the rollout abort signal is greppable', async () => {
    const logWarnSpy = vi.spyOn(logger, 'logWarn');
    await run();

    const call = logWarnSpy.mock.calls.find(
      ([event]) => event === SEMANTIC_ROUTER_DECISION_LOG_EVENT,
    );
    expect(call?.[1]).toMatchObject({ path: 'fallback', error: 'embedding_request_failed' });
  });
});

/* -------------------------------------------------------------------------- *
 * B0-649 — state 2: shadow mode
 * -------------------------------------------------------------------------- */

describe('semantic router shadow mode (B0-649 state 2)', () => {
  beforeEach(() => {
    settingOverrides.set('BEX_SEMANTIC_ROUTER_ENABLED', true);
    settingOverrides.set('BEX_SEMANTIC_ROUTER_SHADOW_MODE', true);
  });

  it('runs both routers, routes on the LLM classifier, and records the disagreement', async () => {
    const result = await run();

    expect(classifyUserIntentSemanticMock).toHaveBeenCalledTimes(1);
    expect(classifyUserIntentMock).toHaveBeenCalledTimes(1);
    // The LLM classifier still decided.
    expect(result.routingDecision).toBe('dilution');

    const record = gateRecordsFor('semantic_router_shadow')[0] as GateRecord;
    expect(record.verdict).toBe('disagrees_with_routing_decision');
    expect(record.inputs).toMatchObject({
      semanticRoute: 'bathroom',
      routingDecision: 'dilution',
      decidedBy: 'llm_classifier',
    });
    expect(record.effect).toContain('Not used to route this turn');
    expect(record.thresholds.mode).toBe('shadow');
    expect(gateRecordsFor('semantic_router_live')).toEqual([]);
    expect(finalRuntimeConfig()).toMatchObject({
      semanticRouterEnabled: true,
      semanticRouterShadowMode: true,
      semanticRouterPath: 'semantic',
      semanticRouterDecided: false,
    });
  });
});
