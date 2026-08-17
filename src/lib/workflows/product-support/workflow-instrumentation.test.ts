import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-389 / B0-390 — what the workflow RECORDS about its own reasoning.
 *
 * B0-389: the prompt sent at each of the three LLM boundaries is persisted on the step that owns
 * it, and the revision pass is a step of its own instead of hiding inside the validator step.
 *
 * B0-390: the persisted tool trace is the RESOLVED one (it used to omit the workflow's own
 * force-injected search), every entry says why the call happened, truncated previews are flagged,
 * and a run that throws mid-generation still keeps the calls that completed.
 *
 * The real `~/lib/conversations/workflow-repository`, `~/lib/tools/execute-tool-call` and
 * `~/lib/audit/trace` run against an in-memory Supabase double, so persistence and truncation are
 * exercised end-to-end rather than asserted against mocks.
 */

type Row = Record<string, unknown>;

type FakeSupabase = {
  client: unknown;
  tables: Record<string, Row[]>;
};

function createFakeSupabase(): FakeSupabase {
  const tables: Record<string, Row[]> = {};
  let sequence = 0;

  const rowsFor = (table: string): Row[] => (tables[table] ??= []);

  /**
   * B0-547 follow-up (regulated-claim guardrail full-document re-fetch) — `assembleDocumentBodies`
   * queries `rag.document_chunk` via `supabase.schema('rag').from(...)`, which this fake never
   * previously needed to support. Every test's `sourceMeta` already carries the full `documentBody`
   * it wants the guardrail to see directly (not via a real `document_chunk` table), so this stub
   * always resolves to an empty result — `assembleDocumentBodies` then returns an empty map and the
   * guardrail call site falls back to `s.documentBody`, exactly the pre-existing behavior.
   */
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

/**
 * B0-516 — a controllable `client.responses.create`, used by the shadow-mode intent-classifier
 * integration tests below. Defaults to throwing synchronously (same externally-observed effect as
 * the old `getOpenAIClient: () => ({})` — any `client.responses.*` call blows up), so every
 * pre-existing test that relies on `extractCompetitorProduct` falling back to `brand: null` (see
 * the B0-513 comment further down) keeps behaving exactly as before.
 */
const openaiResponsesCreateMock = vi.fn();
openaiResponsesCreateMock.mockImplementation(() => {
  throw new Error('client.responses.create is not mocked for this test');
});

vi.mock('~/lib/openai/client', () => ({
  getOpenAIClient: () => ({
    responses: { create: (...args: unknown[]) => openaiResponsesCreateMock(...args) },
  }),
  resolveResponsesModel: () => 'gpt-test',
}));

const runResponsesWithToolLoopMock = vi.fn();
const runAiSdkWithToolLoopMock = vi.fn();
const executeProductToolMock = vi.fn();
const lookupCrossReferenceMock = vi.fn();
const runValidatorPassMock = vi.fn();
const runRevisionPassMock = vi.fn();

vi.mock('~/lib/openai/responses-runtime', () => ({
  runResponsesWithToolLoop: (...args: unknown[]) => runResponsesWithToolLoopMock(...args),
}));

vi.mock('~/lib/bex/ai-sdk-runtime', () => ({
  runAiSdkWithToolLoop: (...args: unknown[]) => runAiSdkWithToolLoopMock(...args),
}));

// Real `executeToolCall` (and therefore real previews + truncation flags) over a fake tool layer.
vi.mock('~/lib/tools/product-tools', () => ({
  executeProductTool: (...args: unknown[]) => executeProductToolMock(...args),
}));

vi.mock('~/lib/tools/cross-reference-lookup', () => ({
  lookupCrossReference: (...args: unknown[]) => lookupCrossReferenceMock(...args),
  fetchRecommendationContext: async () => ({
    betcoEpaRegistration: null,
    alternatives: [],
  }),
}));

// Partial mock: the prompt constants and model resolvers must stay REAL (they are what B0-389
// records), only the model calls are stubbed.
vi.mock('~/lib/workflows/product-support/validator', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('~/lib/workflows/product-support/validator')>();
  return {
    ...actual,
    runValidatorPass: (...args: unknown[]) => runValidatorPassMock(...args),
    runRevisionPass: (...args: unknown[]) => runRevisionPassMock(...args),
    evaluateRegulatedClaimGrounding: () => ({
      categoriesDetected: [],
      ungroundedCategories: [],
      ungroundedDetails: [],
    }),
  };
});

import { toolTraceSchema, type ToolTraceEntry } from '~/lib/audit/trace';
import {
  TOOL_ARGUMENTS_PREVIEW_MAX_CHARS,
  TOOL_OUTPUT_PREVIEW_MAX_CHARS,
} from '~/lib/tools/execute-tool-call';
import { VALIDATOR_SYSTEM_PROMPT } from '~/lib/workflows/product-support/product-support-prompts';
import {
  productSupportStepInputSchema,
  productSupportStepOutputSchema,
  promptRecordSchema,
  readStepGateRecords,
  type GateId,
  type GateRecord,
} from '~/lib/workflows/product-support/product-support-schemas';
import {
  SME_ROUTE_MIN_HITS_TO_ROUTE,
  SME_ROUTE_TIE_BREAK_ORDER,
} from '~/lib/orchestrator/sme-routing';
import {
  CATEGORY_MISMATCH_CONFIDENCE_CAP,
  LOW_SIMILARITY_CONFIDENCE_CAP,
  LOW_SIMILARITY_THRESHOLD,
  MISSING_BRAND_CONFIDENCE_CAP,
} from '~/lib/recommendations/recommendation-gate';
import {
  computePromptVersion,
  PROMPT_BUNDLE_VERSION,
} from '~/lib/workflows/product-support/prompt-version';
import { REVISION_SYSTEM_PROMPT } from '~/lib/workflows/product-support/validator';
import {
  EARLY_DECLINE_CONFIDENCE,
  runProductSupportWorkflow,
  VALIDATOR_BYPASS_REASON,
} from '~/lib/workflows/product-support/run-product-support-workflow';
// B0-516 — real (unmocked) module: `run-product-support-workflow.ts` calls `classifyUserIntent`
// with its default deps, so the integration tests below drive it through the actual
// `getOpenAIClient()` call above rather than an injected fake.
import {
  DEFAULT_BEX_ROUTER_MODEL,
  DEFAULT_BEX_ROUTER_TIMEOUT_MS,
  resetIntentClassifierCache,
} from '~/lib/orchestrator/intent-classifier';

const USAGE_MESSAGE = 'How do I use Betco pH7Q Dual on tile floors?';
const XREF_MESSAGE = 'What is the Betco equivalent to BNC-15?';

const AGENT_USAGE = {
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  cachedPromptTokens: 0,
};

/** B0-554 — `runValidatorPass`/`runRevisionPass` now report usage alongside their result. */
const VALIDATOR_PASS_USAGE = {
  promptTokens: 50,
  completionTokens: 10,
  totalTokens: 60,
  cachedPromptTokens: 0,
};

type ExecuteTool = (input: {
  name: string;
  argumentsJson: string;
  callId: string;
}) => Promise<{ output: string }>;

/** A generation runtime that makes the given tool calls, then answers. */
function generationCalling(
  calls: Array<{ name: string; argumentsJson: string; callId: string }>,
  options: { throwAfterTools?: Error; assistantText?: string } = {},
) {
  return async (opts: unknown) => {
    const { executeTool } = opts as { executeTool: ExecuteTool };
    for (const call of calls) {
      await executeTool(call);
    }
    if (options.throwAfterTools) {
      throw options.throwAfterTools;
    }
    return {
      lastResponse: {},
      finalResponseId: 'resp_final',
      assistantText: options.assistantText ?? 'Dilute per the label instructions.',
      toolTrace: [],
      responseIds: ['resp_1'],
      usage: AGENT_USAGE,
      usageByCall: [AGENT_USAGE],
    };
  };
}

function steps(): Row[] {
  return fake.tables.workflow_steps ?? [];
}

function stepNamed(name: string): Row {
  const step = steps().find((row) => row.step_name === name);
  expect(step, `expected a "${name}" step to be persisted`).toBeDefined();
  return step as Row;
}

function stepInput(name: string): Record<string, unknown> {
  return stepNamed(name).input as Record<string, unknown>;
}

function stepOutput(name: string): Record<string, unknown> {
  return stepNamed(name).output as Record<string, unknown>;
}

function persistedToolTrace(stepName = 'openai_responses_agent'): ToolTraceEntry[] {
  const parsed = toolTraceSchema.safeParse(stepOutput(stepName).toolTrace);
  expect(parsed.success, 'persisted toolTrace must satisfy toolTraceSchema').toBe(true);
  return parsed.success ? parsed.data : [];
}

async function run(overrides: Parameters<typeof runProductSupportWorkflow>[0] | Row = {}) {
  return runProductSupportWorkflow({
    traceId: 'trace-1',
    conversationId: 'conversation-1',
    userMessage: USAGE_MESSAGE,
    ...(overrides as Record<string, unknown>),
  } as Parameters<typeof runProductSupportWorkflow>[0]);
}

const ORIGINAL_ENV = {
  aiSdk: process.env.BEX_AI_SDK_GENERATION_ENABLED,
  declineGate: process.env.BEX_EARLY_DECLINE_GATE_ENABLED,
};

beforeEach(() => {
  fake = createFakeSupabase();
  vi.clearAllMocks();
  process.env.BEX_AI_SDK_GENERATION_ENABLED = 'false';
  process.env.BEX_EARLY_DECLINE_GATE_ENABLED = 'true';
  // B0-516 — every test gets the same default `client.responses.create` behavior (throws, so
  // extractCompetitorProduct/classifyUserIntent both fall back) unless it opts into the
  // shadow-classifier describe block below, which overrides this per-test.
  openaiResponsesCreateMock.mockImplementation(() => {
    throw new Error('client.responses.create is not mocked for this test');
  });
  resetIntentClassifierCache();

  runResponsesWithToolLoopMock.mockImplementation(
    generationCalling([
      {
        name: 'search_product_docs',
        argumentsJson: JSON.stringify({ productName: 'pH7Q Dual', topic: 'tile floors' }),
        callId: 'call_1',
      },
    ]),
  );
  executeProductToolMock.mockResolvedValue({
    sources: [
      {
        documentId: 'doc-1',
        chunkId: 'chunk-1',
        title: 'pH7Q Dual label',
        snippet: 'Use 2 oz per gallon of water. Safety: wear gloves.',
        documentBody: 'Use 2 oz per gallon of water. Safety: wear gloves.',
      },
    ],
  });
  lookupCrossReferenceMock.mockResolvedValue({ matches: [], fallbackRecommended: true });
  runValidatorPassMock.mockResolvedValue({
    approved: true,
    confidence: 0.9,
    issues: [],
    requires_human_review: false,
    usage: VALIDATOR_PASS_USAGE,
  });
  runRevisionPassMock.mockResolvedValue({ text: '', usage: VALIDATOR_PASS_USAGE });
});

afterEach(() => {
  process.env.BEX_AI_SDK_GENERATION_ENABLED = ORIGINAL_ENV.aiSdk;
  process.env.BEX_EARLY_DECLINE_GATE_ENABLED = ORIGINAL_ENV.declineGate;
});

/* -------------------------------------------------------------------------- *
 * B0-389 — prompt capture at the three LLM boundaries
 * -------------------------------------------------------------------------- */

describe('prompt capture (B0-389)', () => {
  it('records the assembled agent instructions, model and runtime on the agent step', async () => {
    await run();

    const prompt = promptRecordSchema.parse(stepInput('openai_responses_agent').prompt);
    expect(prompt.stage).toBe('openai_responses_agent');
    expect(prompt.model).toBe('gpt-test');
    expect(prompt.runtime).toBe('responses');
    expect(prompt.instructions).toContain('You are Bex product support');
    // The captured text is the whole assembled prompt, routing hint included.
    expect(prompt.instructions).toContain('Orchestrator hint (non-authoritative)');
    // Pre-existing keys survive.
    expect(stepInput('openai_responses_agent')).toMatchObject({
      model: 'gpt-test',
      hasPreviousResponse: false,
    });
  });

  it('writes step input/output that satisfies the B0-388 passthrough contracts', async () => {
    await run();

    for (const stepName of ['orchestration_planner', 'openai_responses_agent', 'validator']) {
      expect(
        productSupportStepInputSchema.safeParse(stepNamed(stepName).input).success,
        `${stepName} input`,
      ).toBe(true);
      expect(
        productSupportStepOutputSchema.safeParse(stepNamed(stepName).output).success,
        `${stepName} output`,
      ).toBe(true);
    }
  });

  it('records the ai-sdk runtime when the generation flag selects it', async () => {
    process.env.BEX_AI_SDK_GENERATION_ENABLED = 'true';
    runAiSdkWithToolLoopMock.mockImplementation(generationCalling([]));

    await run();

    expect(runAiSdkWithToolLoopMock).toHaveBeenCalledTimes(1);
    expect(runResponsesWithToolLoopMock).not.toHaveBeenCalled();
    expect(promptRecordSchema.parse(stepInput('openai_responses_agent').prompt).runtime).toBe(
      'ai-sdk',
    );
  });

  it('records the validator prompt only when the validator pass actually runs', async () => {
    await run({ userMessage: USAGE_MESSAGE, useValidator: true });

    const prompt = promptRecordSchema.parse(stepInput('validator').prompt);
    expect(prompt).toEqual({
      stage: 'validator',
      instructions: VALIDATOR_SYSTEM_PROMPT,
      model: 'gpt-test',
      runtime: 'responses',
    });
  });

  it('marks the bypassed validator step skipped with the same reason token as its issue', async () => {
    await run();

    expect(stepInput('validator').prompt).toBeUndefined();
    expect(stepOutput('validator')).toMatchObject({
      skipped: true,
      reason: VALIDATOR_BYPASS_REASON,
    });
    expect(stepOutput('validator').issues).toContain(VALIDATOR_BYPASS_REASON);
    expect(VALIDATOR_BYPASS_REASON).toBe('validator_bypassed_for_testing');
  });

  it('records the early-decline-gate flag as run config on the planner step', async () => {
    await run();
    expect(stepInput('orchestration_planner').runConfig).toEqual({
      earlyDeclineGateEnabled: true,
    });

    fake = createFakeSupabase();
    process.env.BEX_EARLY_DECLINE_GATE_ENABLED = 'false';
    await run();
    expect(stepInput('orchestration_planner').runConfig).toEqual({
      earlyDeclineGateEnabled: false,
    });
  });

  it('records no agent step and no agent prompt on a decline-gate run', async () => {
    await run({ userMessage: 'Can I mix bleach with this Betco cleaner?' });

    expect(steps().map((step) => step.step_name)).toEqual([
      'orchestration_planner',
      'early_decline_gate',
    ]);
    expect(runResponsesWithToolLoopMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- *
 * B0-389 — the revision pass is its own step
 * -------------------------------------------------------------------------- */

describe('revision step (B0-389)', () => {
  beforeEach(() => {
    runValidatorPassMock
      .mockResolvedValueOnce({
        approved: false,
        confidence: 0.4,
        issues: ['dilution claim unsupported'],
        requires_human_review: false,
        usage: VALIDATOR_PASS_USAGE,
      })
      .mockResolvedValue({
        approved: true,
        confidence: 0.8,
        issues: [],
        requires_human_review: false,
        usage: VALIDATOR_PASS_USAGE,
      });
  });

  it('carries its own prompt and reports the replaced draft', async () => {
    runRevisionPassMock.mockResolvedValue({
      text: 'Use 2 oz per gallon of water.',
      usage: VALIDATOR_PASS_USAGE,
    });

    await run({ userMessage: USAGE_MESSAGE, useValidator: true });

    const prompt = promptRecordSchema.parse(stepInput('revision').prompt);
    expect(prompt).toEqual({
      stage: 'revision',
      instructions: REVISION_SYSTEM_PROMPT,
      model: 'gpt-test',
      runtime: 'responses',
    });
    expect(stepInput('revision').validatorIssues).toEqual(['dilution claim unsupported']);
    expect(stepNamed('revision').status).toBe('completed');
    expect(stepOutput('revision')).toMatchObject({
      refused: false,
      outcome: 'draft_replaced',
      revisedAnswer: 'Use 2 oz per gallon of water.',
    });
    // The re-validation is a VALIDATOR call, so it stays on the validator step.
    expect(runValidatorPassMock).toHaveBeenCalledTimes(2);
  });

  it('reports a refusal as such and keeps the original draft', async () => {
    runRevisionPassMock.mockResolvedValue({
      text: 'Clarification needed: please supply approved documentation.',
      usage: VALIDATOR_PASS_USAGE,
    });

    await run({ userMessage: USAGE_MESSAGE, useValidator: true });

    expect(stepOutput('revision')).toMatchObject({
      refused: true,
      outcome: 'refused_draft_retained',
    });
    expect(runValidatorPassMock).toHaveBeenCalledTimes(1);
    expect(fake.tables.review_tasks?.[0]?.reason).toBe('revision_refused');
  });

  it('is never inserted when the validator approves', async () => {
    runValidatorPassMock.mockReset();
    runValidatorPassMock.mockResolvedValue({
      approved: true,
      confidence: 0.9,
      issues: [],
      requires_human_review: false,
      usage: VALIDATOR_PASS_USAGE,
    });

    await run({ userMessage: USAGE_MESSAGE, useValidator: true });

    expect(steps().some((step) => step.step_name === 'revision')).toBe(false);
    expect(runRevisionPassMock).not.toHaveBeenCalled();
  });

  it('is blamed (and the validator marked abandoned) when the revision call throws', async () => {
    runRevisionPassMock.mockRejectedValue(new Error('revision exploded'));

    await expect(run({ userMessage: USAGE_MESSAGE, useValidator: true })).rejects.toThrow(
      'revision exploded',
    );

    expect(stepNamed('revision').status).toBe('failed');
    expect(stepNamed('revision').error).toEqual({ message: 'revision exploded' });
    expect(steps().filter((step) => step.status === 'running')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * B0-546 — conditional/cheaper validator pass
 * -------------------------------------------------------------------------- */

describe('validator high-similarity skip gate (B0-546)', () => {
  const NON_SAFETY_MESSAGE = 'Tell me about Betco Fight Bac RTU packaging options.';

  it('skips the validator LLM pass on a non-safety route once retrieval similarity clears the threshold', async () => {
    executeProductToolMock.mockResolvedValue({
      sources: [
        {
          documentId: 'doc-1',
          chunkId: 'chunk-1',
          title: 'Fight Bac RTU label',
          snippet: 'Ready to use; no dilution required.',
          documentBody: 'Ready to use; no dilution required.',
          confidence: 0.95,
        },
      ],
    });

    await run({ userMessage: NON_SAFETY_MESSAGE, useValidator: true });

    expect(runValidatorPassMock).not.toHaveBeenCalled();
    expect(stepInput('validator').prompt).toBeUndefined();
    expect(stepOutput('validator')).toMatchObject({
      approved: true,
      skipped: true,
      reason: 'validator_skipped_high_similarity_non_safety_route',
    });
    expect(stepOutput('validator').issues).toContain(
      'validator_skipped_high_similarity_non_safety_route',
    );
  });

  it('does not skip on a safety/usage-shaped route even at high similarity', async () => {
    executeProductToolMock.mockResolvedValue({
      sources: [
        {
          documentId: 'doc-1',
          chunkId: 'chunk-1',
          title: 'pH7Q Dual label',
          snippet: 'Use 2 oz per gallon of water.',
          documentBody: 'Use 2 oz per gallon of water.',
          confidence: 0.95,
        },
      ],
    });

    // USAGE_MESSAGE ("How do I use...") is safety-sensitive per `isSafetySensitiveRoute`.
    await run({ userMessage: USAGE_MESSAGE, useValidator: true });

    expect(runValidatorPassMock).toHaveBeenCalledTimes(1);
    expect(stepOutput('validator').issues).not.toContain(
      'validator_skipped_high_similarity_non_safety_route',
    );
  });

  it('does not skip when retrieval similarity is below the threshold', async () => {
    executeProductToolMock.mockResolvedValue({
      sources: [
        {
          documentId: 'doc-1',
          chunkId: 'chunk-1',
          title: 'Fight Bac RTU label',
          snippet: 'Ready to use; no dilution required.',
          documentBody: 'Ready to use; no dilution required.',
          confidence: 0.5,
        },
      ],
    });

    await run({ userMessage: NON_SAFETY_MESSAGE, useValidator: true });

    expect(runValidatorPassMock).toHaveBeenCalledTimes(1);
  });

  it('feeds the validator chunk-level snippets rather than the full document body', async () => {
    executeProductToolMock.mockResolvedValue({
      sources: [
        {
          documentId: 'doc-1',
          chunkId: 'chunk-1',
          title: 'pH7Q Dual label',
          snippet: 'Use 2 oz per gallon of water.',
          documentBody:
            'Use 2 oz per gallon of water. FULL_DOCUMENT_ONLY_MARKER: unrelated boilerplate repeated many times.',
        },
      ],
    });

    await run({ userMessage: USAGE_MESSAGE, useValidator: true });

    expect(runValidatorPassMock).toHaveBeenCalledTimes(1);
    const [{ evidenceSummary }] = runValidatorPassMock.mock.calls[0] as [
      { evidenceSummary: string },
    ];
    expect(evidenceSummary).toContain('Use 2 oz per gallon of water.');
    expect(evidenceSummary).not.toContain('FULL_DOCUMENT_ONLY_MARKER');
  });
});

/* -------------------------------------------------------------------------- *
 * B0-554 — token-usage capture on the validator and revision steps
 * -------------------------------------------------------------------------- */

describe('validator/revision usage capture (B0-554)', () => {
  it('records the validator LLM pass usage on the validator step', async () => {
    await run({ userMessage: USAGE_MESSAGE, useValidator: true });

    expect(stepOutput('validator').usage).toEqual(VALIDATOR_PASS_USAGE);
    expect(stepOutput('validator').usageByCall).toEqual([VALIDATOR_PASS_USAGE]);
  });

  it('records no usage on a bypassed (useValidator: false) validator step', async () => {
    await run();

    expect(stepOutput('validator').usage).toBeUndefined();
    expect(stepOutput('validator').usageByCall).toBeUndefined();
  });

  it('records the revision pass usage on its own step', async () => {
    runValidatorPassMock
      .mockResolvedValueOnce({
        approved: false,
        confidence: 0.4,
        issues: ['dilution claim unsupported'],
        requires_human_review: false,
        usage: VALIDATOR_PASS_USAGE,
      })
      .mockResolvedValue({
        approved: true,
        confidence: 0.8,
        issues: [],
        requires_human_review: false,
        usage: VALIDATOR_PASS_USAGE,
      });
    runRevisionPassMock.mockResolvedValue({
      text: 'Use 2 oz per gallon of water.',
      usage: VALIDATOR_PASS_USAGE,
    });

    await run({ userMessage: USAGE_MESSAGE, useValidator: true });

    expect(stepOutput('revision').usage).toEqual(VALIDATOR_PASS_USAGE);
    // Two validator calls (first pass + the re-check after revision) — both attributed to the
    // one validator step.
    expect(stepOutput('validator').usageByCall).toEqual([
      VALIDATOR_PASS_USAGE,
      VALIDATOR_PASS_USAGE,
    ]);
    expect(stepOutput('validator').usage).toEqual({
      promptTokens: VALIDATOR_PASS_USAGE.promptTokens * 2,
      completionTokens: VALIDATOR_PASS_USAGE.completionTokens * 2,
      totalTokens: VALIDATOR_PASS_USAGE.totalTokens * 2,
      cachedPromptTokens: VALIDATOR_PASS_USAGE.cachedPromptTokens * 2,
    });
  });
});

/* -------------------------------------------------------------------------- *
 * B0-390 — resolved tool trace, attribution, truncation, failure retention
 * -------------------------------------------------------------------------- */

describe('tool trace persistence (B0-390)', () => {
  /** Cross-reference run: pinned tool_choice, safety-net lookup, and a force-injected search. */
  function arrangeCrossReferenceRun() {
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling([
        {
          name: 'lookup_cross_reference',
          argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC-15' }),
          callId: 'call_xref',
        },
      ]),
    );
    executeProductToolMock.mockImplementation(async (name: string) =>
      name === 'lookup_cross_reference'
        ? { matches: [], fallbackRecommended: true }
        : {
            sources: [
              {
                documentId: 'doc-1',
                chunkId: 'chunk-1',
                title: 'Triforce label',
                snippet: 'Use 2 oz per gallon.',
                documentBody: 'Use 2 oz per gallon.',
              },
            ],
          },
    );
    lookupCrossReferenceMock.mockResolvedValue({
      fallbackRecommended: false,
      matches: [
        {
          competitorBrand: 'BNC',
          competitorProductName: 'BNC-15',
          productKey: 'triforce',
          confidence: 0.9,
          productUrl: 'https://www.betco.com/products/triforce',
          betcoProduct: { title: 'Triforce', sku: '1234' },
          rationale: 'curated equivalence',
        },
      ],
    });
  }

  it('persists one entry per call, including the calls the model never chose', async () => {
    arrangeCrossReferenceRun();

    await run({ userMessage: XREF_MESSAGE });

    const trace = persistedToolTrace();
    expect(
      trace.map((entry) => [entry.toolName, entry.origin, entry.ok]),
    ).toEqual([
      ['lookup_cross_reference', 'tool_choice_forced', true],
      ['lookup_cross_reference', 'safety_net_override', true],
      ['search_product_docs', 'workflow_injected', true],
    ]);
    // The force-injected search is identifiable by its call id, as the timeline expects.
    expect(trace[2]?.callId.startsWith('forced-search-')).toBe(true);
    expect(trace[1]?.callId.startsWith('safety-net-xref-')).toBe(true);
    // Every entry carries the full record: arguments, output, ok and a duration.
    for (const entry of trace) {
      expect(entry.argumentsPreview.length).toBeGreaterThan(0);
      expect(entry.outputPreview.length).toBeGreaterThan(0);
      expect(typeof entry.durationMs).toBe('number');
    }
    // `toolCalls` no longer disagrees with the trace beside it.
    expect(stepOutput('openai_responses_agent').toolCalls).toBe(3);
  });

  it('attributes a repeat call of the pinned tool to the model, not to tool_choice', async () => {
    arrangeCrossReferenceRun();
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling([
        {
          name: 'lookup_cross_reference',
          argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC-15' }),
          callId: 'call_xref_1',
        },
        {
          name: 'lookup_cross_reference',
          argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC 15 QT' }),
          callId: 'call_xref_2',
        },
      ]),
    );

    await run({ userMessage: XREF_MESSAGE });

    const trace = persistedToolTrace();
    expect(trace[0]?.origin).toBe('tool_choice_forced');
    expect(trace[1]?.origin).toBe('model_chosen');
  });

  it('attributes ordinary calls to the model when nothing is pinned', async () => {
    await run();

    // B0-436 — the speculative retrieval runs before the first model call, so an unpinned run has
    // two entries: the workflow's own speculative call, then the model's.
    const trace = persistedToolTrace();
    const speculative = trace.filter((entry) => entry.speculative);
    const modelChosen = trace.filter((entry) => !entry.speculative);

    expect(speculative).toHaveLength(1);
    // The model demonstrably did not choose a call fired before it ever ran.
    expect(speculative[0]?.origin).toBe('workflow_injected');
    expect(modelChosen).toHaveLength(1);
    expect(modelChosen[0]?.origin).toBe('model_chosen');
  });

  it('flags a truncated arguments/output preview and transcribes it unchanged', async () => {
    const longProductName = 'A'.repeat(2_000);
    const argumentsJson = JSON.stringify({
      productName: longProductName,
      topic: 'dilution',
    });
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling([
        { name: 'search_product_docs', argumentsJson, callId: 'call_long' },
      ]),
    );
    const payload = {
      dilution: '2 oz/gal',
      epaRegistration: '1839-83-4959',
      contactTime: '60 seconds',
      filler: 'x'.repeat(5_000),
    };
    executeProductToolMock.mockResolvedValue(payload);

    await run();

    // Selected by callId, not index: B0-436's speculative retrieval occupies index 0.
    const entry = persistedToolTrace().find((e) => e.callId === 'call_long');
    expect(entry?.argumentsTruncated).toBe(true);
    expect(entry?.outputTruncated).toBe(true);
    expect(entry?.argumentsPreview).toHaveLength(TOOL_ARGUMENTS_PREVIEW_MAX_CHARS);
    expect(entry?.outputPreview).toHaveLength(TOOL_OUTPUT_PREVIEW_MAX_CHARS);
    // Sliced, never reformatted: the preview is a verbatim prefix of what the tool returned, so
    // the regulated values inside it are exactly as printed.
    expect(entry?.argumentsPreview).toBe(
      argumentsJson.slice(0, TOOL_ARGUMENTS_PREVIEW_MAX_CHARS),
    );
    expect(entry?.outputPreview).toBe(
      JSON.stringify(payload).slice(0, TOOL_OUTPUT_PREVIEW_MAX_CHARS),
    );
    expect(entry?.outputPreview).toContain('"dilution":"2 oz/gal"');
    expect(entry?.outputPreview).toContain('"epaRegistration":"1839-83-4959"');
  });

  it('marks an untruncated preview as untruncated rather than leaving it unknown', async () => {
    await run();

    const entry = persistedToolTrace()[0];
    expect(entry?.argumentsTruncated).toBe(false);
    expect(entry?.outputTruncated).toBe(false);
  });

  it('keeps the completed agent step and its resolved trace when the validator throws', async () => {
    arrangeCrossReferenceRun();
    runValidatorPassMock.mockRejectedValue(new Error('validator exploded'));

    await expect(run({ userMessage: XREF_MESSAGE, useValidator: true })).rejects.toThrow(
      'validator exploded',
    );

    const agentStep = stepNamed('openai_responses_agent');
    expect(agentStep.status).toBe('completed');
    expect(agentStep.error).toBeNull();
    expect(persistedToolTrace()).toHaveLength(3);
    expect(stepNamed('validator').status).toBe('failed');
    expect(steps().filter((step) => step.status === 'running')).toEqual([]);
  });

  it('persists the partial trace when the run throws mid-generation', async () => {
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling(
        [
          {
            name: 'search_product_docs',
            argumentsJson: JSON.stringify({ freeformQuery: 'floor wax' }),
            callId: 'call_before_throw',
          },
        ],
        { throwAfterTools: new Error('generation exploded') },
      ),
    );

    await expect(run()).rejects.toThrow('generation exploded');

    const agentStep = stepNamed('openai_responses_agent');
    expect(agentStep.status).toBe('failed');
    expect(agentStep.error).toEqual({ message: 'generation exploded' });
    const output = stepOutput('openai_responses_agent');
    expect(output.partial).toBe(true);
    // B0-436 — the speculative retrieval completed too, so both calls are kept.
    const trace = persistedToolTrace();
    expect(output.toolCalls).toBe(trace.length);
    const thrownCall = trace.find((entry) => entry.callId === 'call_before_throw');
    expect(thrownCall).toBeDefined();
    expect(thrownCall?.argumentsPreview).toContain('floor wax');
    expect(steps().filter((step) => step.status === 'running')).toEqual([]);
  });

  it('keeps the speculative call when the run throws before the model requests anything', async () => {
    runResponsesWithToolLoopMock.mockImplementation(async () => {
      throw new Error('model unavailable');
    });

    await expect(run()).rejects.toThrow('model unavailable');

    const agentStep = stepNamed('openai_responses_agent');
    expect(agentStep.status).toBe('failed');
    // B0-436 changed what "before any tool call" means: the speculative retrieval has already run
    // and succeeded by this point, and a completed call is exactly what B0-390 exists to preserve.
    // (The "never write an output that was not supplied" invariant is covered by B0-386's
    // `workflow-failure-attribution.test.ts`.)
    const output = stepOutput('openai_responses_agent');
    expect(output.partial).toBe(true);
    const trace = persistedToolTrace();
    expect(trace).toHaveLength(1);
    expect(trace[0]?.speculative).toBe(true);
    expect(trace[0]?.origin).toBe('workflow_injected');
  });
});

/* -------------------------------------------------------------------------- *
 * B0-391 / B0-392 — deterministic gate records + answer provenance
 * -------------------------------------------------------------------------- */

/** Every gate record persisted anywhere on the run, keyed by gate id. */
function gateRecordsFor(gate: GateId): GateRecord[] {
  return steps()
    .flatMap((step) => readStepGateRecords(step.output))
    .filter((record) => record.gate === gate);
}

function singleGateRecord(gate: GateId): GateRecord {
  const records = gateRecordsFor(gate);
  expect(records, `expected exactly one "${gate}" record`).toHaveLength(1);
  return records[0]!;
}

/** A cross-reference run whose curated override replaces the model's draft wholesale. */
function arrangeOverrideRun() {
  runResponsesWithToolLoopMock.mockImplementation(
    generationCalling([
      {
        name: 'lookup_cross_reference',
        argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC-15' }),
        callId: 'call_xref',
      },
    ]),
  );
  executeProductToolMock.mockImplementation(async (name: string) =>
    name === 'lookup_cross_reference'
      ? { matches: [], fallbackRecommended: true }
      : {
          sources: [
            {
              documentId: 'doc-1',
              chunkId: 'chunk-1',
              title: 'Triforce label',
              snippet: 'Use 2 oz per gallon.',
              documentBody: 'Use 2 oz per gallon.',
            },
          ],
        },
  );
  lookupCrossReferenceMock.mockResolvedValue({
    fallbackRecommended: false,
    matches: [
      {
        competitorBrand: 'BNC',
        competitorProductName: 'BNC-15',
        productKey: 'triforce',
        confidence: 0.9,
        productUrl: 'https://www.betco.com/products/triforce',
        betcoProduct: { title: 'Triforce', sku: '1234' },
        rationale: 'curated equivalence',
      },
    ],
  });
}

describe('keyword routing gate (B0-391 / B0-392)', () => {
  it('records the scores, the matched phrases behind them, and the tie-break policy', async () => {
    await run({ userMessage: XREF_MESSAGE });

    const record = singleGateRecord('keyword_routing');
    expect(record.verdict).toBe('decisive_recommendation_signal');
    expect(record.inputs.routedAgent).toBe('recommendations');
    expect(record.inputs.scores).toMatchObject({ recommendations: expect.any(Number) });
    // The phrases, not just the counts: "recommendations 2" is meaningless without them.
    expect((record.inputs.matchedPhrases as Record<string, string[]>).recommendations).toContain(
      'equivalent to',
    );
    expect(record.inputs.decisiveRecommendationPhrases).toContain('equivalent to');
    expect(record.thresholds).toEqual({
      minHitsToRoute: SME_ROUTE_MIN_HITS_TO_ROUTE,
      tieBreakOrder: [...SME_ROUTE_TIE_BREAK_ORDER],
      decisiveRecommendationSignalWinsOutright: true,
    });
  });

  it('says the product specialist ran when a zero-signal message routes "ambiguous"', async () => {
    await run({ userMessage: 'Hello there, how is the weather today?' });

    const routing = stepOutput('orchestration_planner').routing as Record<string, unknown>;
    expect(routing.decision).toBe('ambiguous');
    // B0-392's point: "ambiguous" does not mean "no agent policy was applied".
    expect(routing.effectivePromptId).toBe('product');

    const record = singleGateRecord('keyword_routing');
    expect(record.verdict).toBe('no_signal');
    expect(record.inputs.routedAgent).toBeNull();
    expect(record.effect).toContain('product');
  });

  it('says the keyword scores did not decide when an admin forces a direct mode', async () => {
    await run({ userMessage: USAGE_MESSAGE, agentMode: 'floor' });

    const record = singleGateRecord('keyword_routing');
    expect(record.verdict).toBe('overridden_by_direct_mode');
    expect(record.inputs.agentMode).toBe('floor');
    expect((stepOutput('orchestration_planner').routing as Record<string, unknown>).effectivePromptId).toBe(
      'floor',
    );
  });

  it('keeps the B0-389 run config on the planner step alongside the new record', async () => {
    await run();
    expect(stepInput('orchestration_planner').runConfig).toEqual({
      earlyDeclineGateEnabled: true,
    });
    expect(gateRecordsFor('keyword_routing')).toHaveLength(1);
  });
});

describe('early decline gate record (B0-391)', () => {
  it('records the reason and the applied thresholds on the gate step', async () => {
    await run({ userMessage: 'Can I mix bleach with this Betco cleaner?' });

    const record = singleGateRecord('early_decline_gate');
    expect(record.verdict).toBe('declined');
    expect(record.inputs.reason).toBe('chemical_mixing_or_safety');
    expect(record.thresholds).toMatchObject({
      gateEnabled: true,
      declineConfidence: EARLY_DECLINE_CONFIDENCE,
    });
  });

  it('is absent — not recorded as passing — on a run the gate did not decline', async () => {
    await run();
    expect(gateRecordsFor('early_decline_gate')).toEqual([]);
  });
});

describe('usage/safety coverage gate record (B0-391)', () => {
  it('records the cap it applied when safety evidence is missing', async () => {
    executeProductToolMock.mockResolvedValue({
      sources: [
        {
          documentId: 'doc-1',
          chunkId: 'chunk-1',
          title: 'pH7Q Dual label',
          snippet: 'Usage: apply to the floor with a mop.',
          documentBody: 'Usage: apply to the floor with a mop.',
        },
      ],
    });

    const out = await run();

    const record = singleGateRecord('usage_safety_coverage');
    expect(record.verdict).toBe('capped');
    expect(record.inputs).toMatchObject({
      hasUsageEvidence: true,
      hasSafetyEvidence: false,
      missingEvidence: ['safety'],
    });
    expect(record.thresholds).toMatchObject({ confidenceCap: 0.55 });
    // The threshold recorded is the one the run actually applied.
    expect(out.confidence).toBeLessThanOrEqual(0.55);
    expect(out.validation.issues).toContain('insufficient_safety_evidence');
  });

  it('records a passing verdict when the query needs coverage and both kinds were found', async () => {
    await run();

    const record = singleGateRecord('usage_safety_coverage');
    expect(record.verdict).toBe('passed');
    expect(record.inputs).toMatchObject({
      hasUsageEvidence: true,
      hasSafetyEvidence: true,
      missingEvidence: [],
    });
  });

  it('is absent when the question does not ask about usage or safety at all', async () => {
    await run({ userMessage: 'What is the EPA reg number for Betco Fight Bac RTU?' });
    expect(gateRecordsFor('usage_safety_coverage')).toEqual([]);
  });
});

describe('recommendation confidence gate record (B0-391)', () => {
  it('promotes the calibration to a structured record citing the module thresholds', async () => {
    arrangeOverrideRun();

    await run({ userMessage: XREF_MESSAGE });

    const record = singleGateRecord('recommendation_confidence');
    expect(record.thresholds).toEqual({
      lowSimilarityThreshold: LOW_SIMILARITY_THRESHOLD,
      lowSimilarityConfidenceCap: LOW_SIMILARITY_CONFIDENCE_CAP,
      missingBrandConfidenceCap: MISSING_BRAND_CONFIDENCE_CAP,
      categoryMismatchConfidenceCap: CATEGORY_MISMATCH_CONFIDENCE_CAP,
    });
    // B0-513 — `brandKnown` is now wired from the B0-357 competitor resolution; the mocked
    // `~/lib/openai/client` makes `extractCompetitorProduct` fall back to `brand: null`, so this
    // run's resolved brand is unknown and the gate input reports that faithfully.
    expect(record.inputs).toMatchObject({ trigger: 'recommendations_route', brandKnown: false });
    // The chemistry inputs this workflow never passes are declared as unwired rather than
    // reported as evaluated.
    expect(record.inputs.unwiredInputs).toEqual([
      'competitorChemistryClass',
      'recommendedChemistryClass',
    ]);
  });

  it('is absent on a run with no cross-reference post-processing', async () => {
    await run();
    expect(gateRecordsFor('recommendation_confidence')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * B0-490 — the recommendation gate reads the RAW retrieval similarity, not the
 * post-selection/curation max, for its low-similarity confidence cap.
 * -------------------------------------------------------------------------- */

describe('similarity rollup feeds the recommendation gate raw, not post-filter (B0-490)', () => {
  /** Same shape as `arrangeOverrideRun`, but the search branch reports a `retrieval` block whose
   * raw top similarity (58%, below LOW_SIMILARITY_THRESHOLD) is well under the post-curation max
   * similarity carried on `sources[]` (95%) — the exact gap the B0-490 bug hid. */
  function arrangeLowRawHighSelectedRun() {
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling([
        {
          name: 'lookup_cross_reference',
          argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC-15' }),
          callId: 'call_xref',
        },
      ]),
    );
    executeProductToolMock.mockImplementation(async (name: string) =>
      name === 'lookup_cross_reference'
        ? { matches: [], fallbackRecommended: true }
        : {
            sources: [
              {
                documentId: 'doc-1',
                chunkId: 'chunk-1',
                title: 'Triforce label',
                snippet: 'Use 2 oz per gallon.',
                documentBody: 'Use 2 oz per gallon.',
                similarity: 0.95,
                confidence: 0.95,
              },
            ],
            retrieval: {
              rawTopSimilarity: 0.58,
              selectedTopSimilarity: 0.95,
              droppedByFilterCount: 4,
            },
          },
    );
    lookupCrossReferenceMock.mockResolvedValue({
      fallbackRecommended: false,
      matches: [
        {
          competitorBrand: 'BNC',
          competitorProductName: 'BNC-15',
          productKey: 'triforce',
          confidence: 0.9,
          productUrl: 'https://www.betco.com/products/triforce',
          betcoProduct: { title: 'Triforce', sku: '1234' },
          rationale: 'curated equivalence',
        },
      ],
    });
  }

  it('caps confidence at LOW_SIMILARITY_CONFIDENCE_CAP from a sub-threshold RAW hit even though the post-filter max is high', async () => {
    arrangeLowRawHighSelectedRun();

    const out = await run({ userMessage: XREF_MESSAGE });

    // Pre-fix, `topSimilarity` would have been `sources[].similarity` (0.95, >= 60%), so no cap
    // would have applied and confidence would have stayed at the 0.9 bypass-heuristic value.
    expect(out.confidence).toBeLessThanOrEqual(LOW_SIMILARITY_CONFIDENCE_CAP);

    const record = singleGateRecord('recommendation_confidence');
    expect(record.verdict).toBe('capped');
    expect(record.effect).toContain('Top retrieval similarity 58%');
  });

  it('persists both raw and post-selection top similarity on the final output, distinguishably', async () => {
    arrangeLowRawHighSelectedRun();

    const out = await run({ userMessage: XREF_MESSAGE });

    expect(out.similaritySummary).toEqual({
      rawTopSimilarity: 0.58,
      selectedTopSimilarity: 0.95,
      droppedByFilterCount: 4,
    });
  });

  it('leaves similaritySummary all-null when no search tool carried a retrieval block', async () => {
    const out = await run();
    // The default beforeEach mock's `executeProductToolMock` payload has no `retrieval` key.
    expect(out.similaritySummary).toEqual({
      rawTopSimilarity: null,
      selectedTopSimilarity: null,
      droppedByFilterCount: null,
    });
  });
});

describe('answer provenance (B0-391)', () => {
  it('reports a plain model answer as model_generated', async () => {
    const out = await run();
    expect(out.answerProvenance).toBe('model_generated');
    expect(out.answerText).toBe('Dilute per the label instructions.');
  });

  it('reports the recommendations override as template_override', async () => {
    arrangeOverrideRun();

    const out = await run({ userMessage: XREF_MESSAGE });

    expect(out.answerProvenance).toBe('template_override');
    expect(out.answerText).not.toBe('Dilute per the label instructions.');
  });

  it('reports the early decline gate as decline_gate', async () => {
    const out = await run({ userMessage: 'Can I mix bleach with this Betco cleaner?' });
    expect(out.answerProvenance).toBe('decline_gate');
  });

  it('reports the usage/safety fallback copy as usage_safety_fallback', async () => {
    executeProductToolMock.mockResolvedValue({
      sources: [
        {
          documentId: 'doc-1',
          chunkId: 'chunk-1',
          title: 'pH7Q Dual label',
          snippet: 'Usage: apply to the floor with a mop.',
          documentBody: 'Usage: apply to the floor with a mop.',
        },
      ],
    });

    const out = await run();

    expect(out.answerProvenance).toBe('usage_safety_fallback');
    expect(out.answerText).toContain('do not have enough retrieved evidence');
  });

  it('reports the generic validator fallback as validator_fallback', async () => {
    runValidatorPassMock.mockResolvedValue({
      approved: false,
      confidence: 0.3,
      issues: ['dilution claim unsupported'],
      requires_human_review: true,
      usage: VALIDATOR_PASS_USAGE,
    });
    runRevisionPassMock.mockResolvedValue({
      text: 'Clarification needed: please supply approved documentation.',
      usage: VALIDATOR_PASS_USAGE,
    });

    const out = await run({ userMessage: 'What is the EPA reg number for Betco Fight Bac RTU?', useValidator: true });

    expect(out.answerProvenance).toBe('validator_fallback');
    expect(out.answerText).toContain('could not fully verify');
  });

  it('reports a cross-reference headline stapled onto the model draft as cross_reference_composed', async () => {
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling([
        {
          name: 'lookup_cross_reference',
          argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC-15' }),
          callId: 'call_xref',
        },
      ]),
    );
    // A legacy match with a URL but no curated analysis facts: composed, not template-overridden.
    executeProductToolMock.mockImplementation(async (name: string) =>
      name === 'lookup_cross_reference'
        ? {
            fallbackRecommended: false,
            matches: [
              {
                competitorBrand: 'BNC',
                competitorProductName: 'BNC-15',
                productKey: 'triforce',
                confidence: 0.9,
                productUrl: 'https://www.betco.com/products/triforce',
                betcoProduct: { title: 'Triforce', sku: '1234' },
              },
            ],
          }
        : { sources: [] },
    );

    const out = await run({ userMessage: XREF_MESSAGE });

    expect(out.answerProvenance).toBe('cross_reference_composed');
    expect(out.answerText.split('\n')[0]).toContain('Comparable Betco product:');
  });

  it('does not claim composition when the composer left the model text unchanged', async () => {
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling(
        [
          {
            name: 'lookup_cross_reference',
            argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC-15' }),
            callId: 'call_xref',
          },
        ],
        // A decline stands on its own — the composer returns it untouched.
        { assistantText: "I don't have enough information to answer that." },
      ),
    );
    executeProductToolMock.mockImplementation(async (name: string) =>
      name === 'lookup_cross_reference'
        ? {
            fallbackRecommended: false,
            matches: [
              {
                competitorBrand: 'BNC',
                competitorProductName: 'BNC-15',
                productKey: 'triforce',
                confidence: 0.9,
                productUrl: 'https://www.betco.com/products/triforce',
                betcoProduct: { title: 'Triforce', sku: '1234' },
              },
            ],
          }
        : { sources: [] },
    );

    const out = await run({ userMessage: XREF_MESSAGE });

    expect(out.answerProvenance).toBe('model_generated');
  });
});

describe('prompt identity on the final output (B0-393 wiring)', () => {
  it('stamps the prompt version, bundle version and chat context on an answered run', async () => {
    const out = await run({
      priorMessages: [{ role: 'user', content: 'earlier question' }],
      previousOpenaiResponseId: 'resp_prev',
    });

    expect(out.promptVersion).toBe(computePromptVersion(out.routingDecision ?? ''));
    expect(out.promptBundleVersion).toBe(PROMPT_BUNDLE_VERSION);
    expect(out.priorMessageCount).toBe(1);
    expect(out.previousResponseId).toBe('resp_prev');
  });

  it('stamps them on the early-decline path too, which never calls a model', async () => {
    const out = await run({ userMessage: 'Can I mix bleach with this Betco cleaner?' });

    expect(out.promptVersion).toBe(computePromptVersion(out.routingDecision ?? ''));
    expect(out.promptBundleVersion).toBe(PROMPT_BUNDLE_VERSION);
    expect(out.priorMessageCount).toBe(0);
    expect(out.previousResponseId).toBeNull();
  });
});

/* -------------------------------------------------------------------------- *
 * B0-519 — cap conversation history before replaying it via previous_response_id
 * -------------------------------------------------------------------------- */

describe('capped conversation history (B0-519)', () => {
  afterEach(() => {
    delete process.env.BEX_HISTORY_MAX_MESSAGES;
  });

  it('below the cap: keeps chaining via previousResponseId, unchanged from before this ticket', async () => {
    process.env.BEX_HISTORY_MAX_MESSAGES = '10';

    const out = await run({
      priorMessages: [{ role: 'user', content: 'earlier question' }],
      previousOpenaiResponseId: 'resp_prev',
    });

    const call = runResponsesWithToolLoopMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.previousResponseId).toBe('resp_prev');
    expect(call.history).toBeUndefined();
    expect(out.historyCapApplied).toBe(false);
    expect(stepInput('openai_responses_agent')).toMatchObject({
      hasPreviousResponse: true,
      historyCapApplied: false,
    });
  });

  it('over the cap: breaks the previous_response_id chain and replays only the capped tail', async () => {
    process.env.BEX_HISTORY_MAX_MESSAGES = '2';
    const priorMessages = [
      { role: 'user' as const, content: 'turn 1 user' },
      { role: 'assistant' as const, content: 'turn 1 assistant' },
      { role: 'user' as const, content: 'turn 2 user' },
      { role: 'assistant' as const, content: 'turn 2 assistant' },
    ];

    const out = await run({ priorMessages, previousOpenaiResponseId: 'resp_prev' });

    const call = runResponsesWithToolLoopMock.mock.calls[0]?.[0] as Record<string, unknown>;
    // The chain is broken (never resumed) even though the caller passed a previousOpenaiResponseId.
    expect(call.previousResponseId).toBeNull();
    // Only the most recent `BEX_HISTORY_MAX_MESSAGES` messages are replayed, oldest-first.
    expect(call.history).toEqual([
      { role: 'user', content: 'turn 2 user' },
      { role: 'assistant', content: 'turn 2 assistant' },
    ]);
    // Reported on the run and on the agent step, for observability.
    expect(out.historyCapApplied).toBe(true);
    expect(out.previousResponseId).toBe('resp_prev'); // raw echo of what was received, unchanged
    expect(stepInput('openai_responses_agent')).toMatchObject({
      hasPreviousResponse: false,
      historyCapApplied: true,
    });
  });

  it('caps the AI SDK runtime the same way, always stateless', async () => {
    process.env.BEX_AI_SDK_GENERATION_ENABLED = 'true';
    process.env.BEX_HISTORY_MAX_MESSAGES = '2';
    runAiSdkWithToolLoopMock.mockImplementation(generationCalling([]));

    const priorMessages = [
      { role: 'user' as const, content: 'turn 1 user' },
      { role: 'assistant' as const, content: 'turn 1 assistant' },
      { role: 'user' as const, content: 'turn 2 user' },
      { role: 'assistant' as const, content: 'turn 2 assistant' },
    ];

    await run({ priorMessages });

    const call = runAiSdkWithToolLoopMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.history).toEqual([
      { role: 'user', content: 'turn 2 user' },
      { role: 'assistant', content: 'turn 2 assistant' },
    ]);
  });

  it('falls back to the default cap on an invalid env value', async () => {
    process.env.BEX_HISTORY_MAX_MESSAGES = 'not-a-number';

    const out = await run({
      priorMessages: [{ role: 'user', content: 'earlier question' }],
      previousOpenaiResponseId: 'resp_prev',
    });

    // A single prior message never exceeds the (double-digit) default cap.
    expect(out.historyCapApplied).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 * B0-507 / B0-516 — shadow-mode LLM intent classifier gate, exercised through the REAL
 * `runProductSupportWorkflow` entry point (unlike `~/lib/orchestrator/intent-classifier.test.ts`,
 * which tests `classifyUserIntent` in isolation with injected deps, these tests drive it via its
 * default deps — the same `getOpenAIClient()` the workflow itself uses).
 *
 * "Cutover" (actually routing turns on the classifier's intent instead of the keyword router) has
 * no code path to test yet — B0-514, which would build it, is intentionally still open. These
 * tests only cover what IS wired today: the classifier running alongside the keyword router in
 * shadow mode, the gate it records, and that a slow/broken classifier call still falls back
 * safely without breaking the turn — end-to-end, not just at the `intent-classifier.ts` module
 * boundary.
 * -------------------------------------------------------------------------- */

describe('shadow-mode LLM intent classifier gate (B0-507 / B0-516 integration)', () => {
  function intentClassifierPayload(
    overrides: {
      intent?: string;
      confidence?: number;
      entities?: Partial<{
        betcoProduct: string | null;
        competitorBrand: string | null;
        competitorProduct: string | null;
        surfaceType: string | null;
        taskDescription: string | null;
      }>;
      suggestedTool?: string | null;
    } = {},
  ) {
    return {
      intent: overrides.intent ?? 'recommendations',
      confidence: overrides.confidence ?? 0.87,
      entities: {
        betcoProduct: null,
        competitorBrand: 'BNC',
        competitorProduct: 'BNC-15',
        surfaceType: null,
        taskDescription: 'find the Betco equivalent for BNC-15',
        ...overrides.entities,
      },
      suggestedTool: overrides.suggestedTool ?? null,
    };
  }

  /**
   * Only answers the classifier's own schema-tagged call. `extractCompetitorProduct` fires
   * concurrently on the recommendations route and calls the very same `client.responses.create` —
   * its call is left to the file-wide default (throws, falls back to `brand: null`), which is not
   * this describe block's concern.
   */
  function mockIntentClassifierResponse(
    payload: Record<string, unknown>,
    options: { delayMs?: number } = {},
  ) {
    openaiResponsesCreateMock.mockImplementation(async (body: unknown) => {
      const schemaName = (body as { text?: { format?: { name?: string } } })?.text?.format?.name;
      if (schemaName !== 'intent_classification') {
        throw new Error(`unmocked responses.create call for schema "${schemaName}"`);
      }
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      return { output_text: JSON.stringify(payload) };
    });
  }

  afterEach(() => {
    delete process.env.BEX_LLM_ROUTER_ENABLED;
    delete process.env.BEX_LLM_ROUTER_SHADOW_MODE;
    delete process.env.BEX_ROUTER_TIMEOUT_MS;
    delete process.env.BEX_ROUTER_MODEL;
  });

  it('is absent when the LLM router is disabled (the default)', async () => {
    await run({ userMessage: XREF_MESSAGE });
    expect(gateRecordsFor('llm_intent_classifier_shadow')).toEqual([]);
  });

  it('records an "agrees_with_keyword_router" verdict end-to-end, without changing the actual routing, when the classifier matches the keyword route', async () => {
    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
    mockIntentClassifierResponse(
      intentClassifierPayload({ intent: 'recommendations', confidence: 0.87 }),
    );

    await run({ userMessage: XREF_MESSAGE });

    // The keyword router still made the real routing decision (recommendations for this
    // message — corroborated by the "keyword routing gate" describe block above).
    expect(
      (stepOutput('orchestration_planner').routing as Record<string, unknown>).decision,
    ).toBe('recommendations');

    const record = singleGateRecord('llm_intent_classifier_shadow');
    expect(record.verdict).toBe('agrees_with_keyword_router');
    expect(record.inputs).toMatchObject({
      classifiedIntent: 'recommendations',
      classifierConfidence: 0.87,
      classifierSource: 'llm',
      keywordRoutingDecision: 'recommendations',
      suggestedTool: null,
    });
    // Entity extraction round-trips onto the gate record verbatim.
    expect(record.inputs.entities).toMatchObject({
      competitorBrand: 'BNC',
      competitorProduct: 'BNC-15',
      taskDescription: 'find the Betco equivalent for BNC-15',
    });
    expect(record.thresholds).toEqual({
      model: DEFAULT_BEX_ROUTER_MODEL,
      timeoutMs: DEFAULT_BEX_ROUTER_TIMEOUT_MS,
    });
  });

  it('records a "disagrees_with_keyword_router" verdict end-to-end, and still does not cut over routing (no such code path exists yet — B0-514), when the classifier proposes a different intent', async () => {
    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
    mockIntentClassifierResponse(intentClassifierPayload({ intent: 'floor', confidence: 0.62 }));

    await run({ userMessage: XREF_MESSAGE });

    // The disagreement is recorded, but the turn is still routed by the keyword router — there is
    // no cutover to assert here, by design.
    expect(
      (stepOutput('orchestration_planner').routing as Record<string, unknown>).decision,
    ).toBe('recommendations');

    const record = singleGateRecord('llm_intent_classifier_shadow');
    expect(record.verdict).toBe('disagrees_with_keyword_router');
    expect(record.inputs).toMatchObject({
      classifiedIntent: 'floor',
      keywordRoutingDecision: 'recommendations',
    });
    expect(record.effect).toContain('Not used to route this turn');
  });

  it('falls back to the keyword router end-to-end, and still records the gate, when the classifier call exceeds BEX_ROUTER_TIMEOUT_MS', async () => {
    process.env.BEX_LLM_ROUTER_ENABLED = 'true';
    process.env.BEX_ROUTER_TIMEOUT_MS = '10';
    mockIntentClassifierResponse(
      intentClassifierPayload({ intent: 'floor', confidence: 0.9 }),
      { delayMs: 100 },
    );

    await run({ userMessage: XREF_MESSAGE });

    // A slow/broken classifier never breaks the turn — the run completes normally either way.
    expect(
      (stepOutput('orchestration_planner').routing as Record<string, unknown>).decision,
    ).toBe('recommendations');

    const record = singleGateRecord('llm_intent_classifier_shadow');
    expect(record.inputs.classifierSource).toBe('keyword_fallback');
    // The keyword fallback runs the same keyword router the workflow's own routing decision
    // already used, so for this message it still reads as "agrees".
    expect(record.verdict).toBe('agrees_with_keyword_router');
  });
});

/* -------------------------------------------------------------------------- *
 * B0-493 — retrieval parameters/strategy persisted per search call, rolled up to run level.
 * -------------------------------------------------------------------------- */

describe('retrieval configuration rollup (B0-493)', () => {
  function retrievalPayload(overrides: Partial<{ retrievalStrategy: string; embeddingSource: string }> = {}) {
    return {
      strategy: 'anchored_only',
      cacheSource: overrides.embeddingSource ?? 'new-embedding',
      search: {
        model: 'text-embedding-3-large',
        limit: 20,
        scope: 'all',
        productLineKey: 'ph7q-dual',
        productKey: null,
        sectionType: null,
        minSimilarity: null,
        retrievalStrategy: overrides.retrievalStrategy ?? 'hybrid+reranked',
        embeddingSource: overrides.embeddingSource ?? 'new-embedding',
        timings: {
          totalMs: 120,
          queryEmbeddingMs: 12,
          queryRewriteMs: 4,
          cacheLookupMs: 2,
          embeddingCreateMs: 50,
          cachePersistMs: 3,
          similaritySearchMs: 40,
          rerankMs: 9,
        },
      },
      selection: {
        limit: 3,
        minSimilarity: 0.2,
        maxPerDocument: 1,
        requiredDocumentKinds: ['product_line_profile', 'sds', 'knowledge', 'label'],
      },
    };
  }

  it('labels a run with the single search call’s retrieval configuration', async () => {
    executeProductToolMock.mockResolvedValue({
      sources: [{ documentId: 'doc-1', chunkId: 'chunk-1', snippet: 'Use 2 oz per gallon.' }],
      retrieval: retrievalPayload(),
    });

    const out = await run();

    expect(out.retrievalConfig).toEqual({
      embeddingModel: 'text-embedding-3-large',
      retrievalStrategy: 'hybrid+reranked',
      embeddingSource: 'new-embedding',
      scope: 'all',
      minSimilarity: 0.2,
      mixed: [],
    });

    // Persisted on the tool trace too, not just the run-level rollup.
    const trace = persistedToolTrace();
    const searchEntry = trace.find((t) => t.toolName === 'search_product_docs' && !t.speculative);
    expect(searchEntry?.retrieval?.retrievalStrategy).toBe('hybrid+reranked');
  });

  it('marks retrievalStrategy mixed when two search calls this turn disagree', async () => {
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling([
        {
          name: 'search_product_docs',
          argumentsJson: JSON.stringify({ freeformQuery: 'first search' }),
          callId: 'call_a',
        },
        {
          name: 'search_product_docs',
          argumentsJson: JSON.stringify({ freeformQuery: 'second search' }),
          callId: 'call_b',
        },
      ]),
    );
    executeProductToolMock
      .mockResolvedValueOnce({
        sources: [{ documentId: 'doc-1', chunkId: 'chunk-1', snippet: 'first' }],
        retrieval: retrievalPayload({ retrievalStrategy: 'vector' }),
      })
      .mockResolvedValueOnce({
        sources: [{ documentId: 'doc-2', chunkId: 'chunk-2', snippet: 'second' }],
        retrieval: retrievalPayload({ retrievalStrategy: 'hybrid+reranked' }),
      });

    const out = await run();

    expect(out.retrievalConfig?.retrievalStrategy).toBeNull();
    expect(out.retrievalConfig?.mixed).toContain('retrievalStrategy');
    // Fields both calls agreed on are still labelled, not swept into "mixed" wholesale.
    expect(out.retrievalConfig?.embeddingModel).toBe('text-embedding-3-large');
  });

  it('is absent on the early-decline path, which never enters the tool loop at all', async () => {
    const out = await run({ userMessage: 'Can I mix bleach with this Betco cleaner?' });
    expect(out.retrievalConfig).toBeUndefined();
  });

  it('is all-null with no mixed fields on an answered turn whose tool calls carried no retrieval block', async () => {
    // Default beforeEach mock: `search_product_docs` runs, but its payload has no `retrieval` key.
    const out = await run();
    expect(out.retrievalConfig).toEqual({
      embeddingModel: null,
      retrievalStrategy: null,
      embeddingSource: null,
      scope: null,
      minSimilarity: null,
      mixed: [],
    });
  });
});

/* -------------------------------------------------------------------------- *
 * B0-491 — agent self-reported confidence captured as structured output.
 * -------------------------------------------------------------------------- */

describe('agent self-reported confidence (B0-491)', () => {
  const MARKER = (agentConfidence: number, agentConfidenceBasis: string) =>
    `<!--BEX_AGENT_CONFIDENCE {"agentConfidence":${agentConfidence},"agentConfidenceBasis":"${agentConfidenceBasis}"}-->`;

  it('captures a valid self-reported confidence and strips the marker from the visible answer', async () => {
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling(
        [
          {
            name: 'search_product_docs',
            argumentsJson: JSON.stringify({ productName: 'pH7Q Dual', topic: 'tile floors' }),
            callId: 'call_1',
          },
        ],
        {
          assistantText: `Use 2 oz per gallon of water.\n${MARKER(0.87, 'exact label ratio cited')}`,
        },
      ),
    );

    const out = await run();

    expect(out.answerText).toBe('Use 2 oz per gallon of water.');
    expect(out.answerText).not.toContain('BEX_AGENT_CONFIDENCE');
    expect(out.agentConfidence).toBe(0.87);
    expect(out.agentConfidenceBasis).toBe('exact label ratio cited');
    expect(out.agentConfidenceReason).toBe('reported');
  });

  it('persists agentConfidence on the agent workflow_steps row alongside the tool trace', async () => {
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling([], { assistantText: `Answer.\n${MARKER(0.72, 'partial evidence')}` }),
    );

    await run();

    expect(stepOutput('openai_responses_agent')).toMatchObject({
      agentConfidence: 0.72,
      agentConfidenceBasis: 'partial evidence',
      agentConfidenceReason: 'reported',
    });
    // Same step row as the B0-390 tool trace — not a separate step.
    expect(stepOutput('openai_responses_agent').toolTrace).toBeDefined();
  });

  it('records an explicit null with reason "not_reported" when the model never emits the marker', async () => {
    const out = await run();
    expect(out.agentConfidence).toBeNull();
    expect(out.agentConfidenceBasis).toBeNull();
    expect(out.agentConfidenceReason).toBe('not_reported');
  });

  it('records reason "no_model_call" on the early-decline path, which never calls a model', async () => {
    const out = await run({ userMessage: 'Can I mix bleach with this Betco cleaner?' });
    expect(out.agentConfidence).toBeNull();
    expect(out.agentConfidenceBasis).toBeNull();
    expect(out.agentConfidenceReason).toBe('no_model_call');
  });

  it('a self-scored-below-0.80 run is identifiable from agentConfidence alone, without reading answer text', async () => {
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling([], {
        assistantText: `I don't have enough information to answer that.\n${MARKER(0.35, 'no verified source found')}`,
      }),
    );

    const out = await run();

    expect(out.agentConfidence).toBeLessThan(0.8);
    expect(out.agentConfidenceReason).toBe('reported');
  });

  it('feeds agentConfidence into the recommendation gate as baseConfidence, replacing the bypass-heuristic value', async () => {
    // Cross-reference route: the bypass-heuristic confidence would be 0.9 (sources.length > 0).
    // The agent's own self-reported confidence (0.62) must be what the gate actually calibrates on.
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling(
        [
          {
            name: 'lookup_cross_reference',
            argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC-15' }),
            callId: 'call_xref',
          },
        ],
        { assistantText: `Comparable product found.\n${MARKER(0.62, 'moderate confidence match')}` },
      ),
    );
    executeProductToolMock.mockImplementation(async (name: string) =>
      name === 'lookup_cross_reference'
        ? { matches: [], fallbackRecommended: true }
        : {
            sources: [
              {
                documentId: 'doc-1',
                chunkId: 'chunk-1',
                title: 'Triforce label',
                snippet: 'Use 2 oz per gallon.',
                documentBody: 'Use 2 oz per gallon.',
              },
            ],
          },
    );
    lookupCrossReferenceMock.mockResolvedValue({
      fallbackRecommended: false,
      matches: [
        {
          competitorBrand: 'BNC',
          competitorProductName: 'BNC-15',
          productKey: 'triforce',
          confidence: 0.9,
          productUrl: 'https://www.betco.com/products/triforce',
          betcoProduct: { title: 'Triforce', sku: '1234' },
          rationale: 'curated equivalence',
        },
      ],
    });

    const out = await run({ userMessage: XREF_MESSAGE });

    expect(out.agentConfidence).toBe(0.62);
    const record = singleGateRecord('recommendation_confidence');
    // Pinned: the gate's recorded `baseConfidence` input is the agent's self-score, not 0.9.
    expect(record.inputs.baseConfidence).toBe(0.62);
    expect(out.confidence).toBeLessThanOrEqual(0.62);
  });

  it('falls back to the validator/heuristic confidence for the gate when the agent reported no score', async () => {
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling([
        {
          name: 'lookup_cross_reference',
          argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC-15' }),
          callId: 'call_xref',
        },
      ]),
    );
    executeProductToolMock.mockImplementation(async (name: string) =>
      name === 'lookup_cross_reference'
        ? { matches: [], fallbackRecommended: true }
        : { sources: [{ documentId: 'doc-1', chunkId: 'chunk-1', snippet: 'x', documentBody: 'x' }] },
    );
    lookupCrossReferenceMock.mockResolvedValue({
      fallbackRecommended: false,
      matches: [
        {
          competitorBrand: 'BNC',
          competitorProductName: 'BNC-15',
          productKey: 'triforce',
          confidence: 0.9,
          productUrl: 'https://www.betco.com/products/triforce',
          betcoProduct: { title: 'Triforce', sku: '1234' },
          rationale: 'curated equivalence',
        },
      ],
    });

    const out = await run({ userMessage: XREF_MESSAGE });

    expect(out.agentConfidence).toBeNull();
    const record = singleGateRecord('recommendation_confidence');
    // No marker this turn — falls back to the bypass-heuristic confidence (sources.length > 0 -> 0.9).
    expect(record.inputs.baseConfidence).toBe(0.9);
  });
});

/* -------------------------------------------------------------------------- *
 * B0-492 — every persisted confidence carries exactly one provenance.
 * -------------------------------------------------------------------------- */

describe('confidence provenance (B0-492)', () => {
  const MARKER = (agentConfidence: number) =>
    `<!--BEX_AGENT_CONFIDENCE {"agentConfidence":${agentConfidence},"agentConfidenceBasis":"x"}-->`;

  it('is validator_bypassed_heuristic on the default (useValidator: false) path', async () => {
    const out = await run();
    expect(out.confidenceProvenance).toBe('validator_bypassed_heuristic');
    expect(out.confidencePreCapValue).toBeNull();
    expect(out.confidencePreCapProvenance).toBeNull();
  });

  it('is validator_judged when the model-scored validator pass actually ran', async () => {
    const out = await run({ useValidator: true });
    expect(out.confidenceProvenance).toBe('validator_judged');
  });

  it('is decline_gate_constant on the early-decline path', async () => {
    const out = await run({ userMessage: 'Can I mix bleach with this Betco cleaner?' });
    expect(out.confidenceProvenance).toBe('decline_gate_constant');
  });

  it('is persisted on the validator workflow_steps row, not just the final output', async () => {
    const out = await run();
    expect(stepOutput('validator')).toMatchObject({
      confidenceProvenance: out.confidenceProvenance,
      confidencePreCapValue: out.confidencePreCapValue,
      confidencePreCapProvenance: out.confidencePreCapProvenance,
    });
  });

  it('is gate_capped with the recoverable pre-cap value/provenance when the usage/safety coverage gate caps it', async () => {
    executeProductToolMock.mockResolvedValue({
      sources: [
        {
          documentId: 'doc-1',
          chunkId: 'chunk-1',
          title: 'pH7Q Dual label',
          snippet: 'Usage: apply to the floor with a mop.',
          documentBody: 'Usage: apply to the floor with a mop.',
        },
      ],
    });

    const out = await run();

    expect(out.confidenceProvenance).toBe('gate_capped');
    // The bypass-heuristic value (sources.length > 0 -> 0.9) BEFORE the coverage cap applied.
    expect(out.confidencePreCapValue).toBe(0.9);
    expect(out.confidencePreCapProvenance).toBe('validator_bypassed_heuristic');
    expect(out.confidence).toBeLessThanOrEqual(0.55);
  });

  it('is agent_self_scored (no pre-cap) when the recommendation gate ran but did not cap the agent score further', async () => {
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling(
        [
          {
            name: 'lookup_cross_reference',
            argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC-15' }),
            callId: 'call_xref',
          },
        ],
        { assistantText: `Comparable product found.\n${MARKER(0.7)}` },
      ),
    );
    executeProductToolMock.mockImplementation(async (name: string) =>
      name === 'lookup_cross_reference'
        ? { matches: [], fallbackRecommended: true }
        : {
            sources: [{ documentId: 'doc-1', chunkId: 'chunk-1', snippet: 'x', documentBody: 'x' }],
            retrieval: { rawTopSimilarity: 0.9, selectedTopSimilarity: 0.9, droppedByFilterCount: 0 },
          },
    );
    lookupCrossReferenceMock.mockResolvedValue({
      fallbackRecommended: false,
      matches: [
        {
          competitorBrand: 'BNC',
          competitorProductName: 'BNC-15',
          productKey: 'triforce',
          confidence: 0.9,
          productUrl: 'https://www.betco.com/products/triforce',
          betcoProduct: { title: 'Triforce', sku: '1234' },
          rationale: 'curated equivalence',
        },
      ],
    });

    const out = await run({ userMessage: XREF_MESSAGE });

    expect(out.agentConfidence).toBe(0.7);
    expect(out.confidence).toBe(0.7);
    expect(out.confidenceProvenance).toBe('agent_self_scored');
    expect(out.confidencePreCapValue).toBeNull();
    expect(out.confidencePreCapProvenance).toBeNull();
  });

  it('is gate_capped (pre-cap = agent_self_scored) when the recommendation gate caps the agent score for low retrieval similarity', async () => {
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling(
        [
          {
            name: 'lookup_cross_reference',
            argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC-15' }),
            callId: 'call_xref',
          },
        ],
        { assistantText: `Comparable product found.\n${MARKER(0.9)}` },
      ),
    );
    executeProductToolMock.mockImplementation(async (name: string) =>
      name === 'lookup_cross_reference'
        ? { matches: [], fallbackRecommended: true }
        : {
            sources: [{ documentId: 'doc-1', chunkId: 'chunk-1', snippet: 'x', documentBody: 'x' }],
            // Below LOW_SIMILARITY_THRESHOLD (0.6) — the gate's own cap must fire on the agent's score.
            retrieval: { rawTopSimilarity: 0.4, selectedTopSimilarity: 0.9, droppedByFilterCount: 2 },
          },
    );
    lookupCrossReferenceMock.mockResolvedValue({
      fallbackRecommended: false,
      matches: [
        {
          competitorBrand: 'BNC',
          competitorProductName: 'BNC-15',
          productKey: 'triforce',
          confidence: 0.9,
          productUrl: 'https://www.betco.com/products/triforce',
          betcoProduct: { title: 'Triforce', sku: '1234' },
          rationale: 'curated equivalence',
        },
      ],
    });

    const out = await run({ userMessage: XREF_MESSAGE });

    expect(out.agentConfidence).toBe(0.9);
    expect(out.confidence).toBeLessThanOrEqual(LOW_SIMILARITY_CONFIDENCE_CAP);
    expect(out.confidenceProvenance).toBe('gate_capped');
    expect(out.confidencePreCapValue).toBe(0.9);
    expect(out.confidencePreCapProvenance).toBe('agent_self_scored');
  });

  it('is gate_capped (pre-cap = validator_bypassed_heuristic) when the gate caps for a missing brand, with no agent score in play', async () => {
    // No marker this turn (agentConfidence null): the gate calibrates on the bypass-heuristic 0.9.
    // `extractCompetitorProduct` falls back to `brand: null` in this test file's default mocks, so
    // the missing-brand cap (ceiling 0.8) fires and must win the outer min against 0.9.
    runResponsesWithToolLoopMock.mockImplementation(
      generationCalling([
        {
          name: 'lookup_cross_reference',
          argumentsJson: JSON.stringify({ brand: 'BNC', productName: 'BNC-15' }),
          callId: 'call_xref',
        },
      ]),
    );
    executeProductToolMock.mockImplementation(async (name: string) =>
      name === 'lookup_cross_reference'
        ? { matches: [], fallbackRecommended: true }
        : {
            sources: [{ documentId: 'doc-1', chunkId: 'chunk-1', snippet: 'x', documentBody: 'x' }],
            retrieval: { rawTopSimilarity: 0.95, selectedTopSimilarity: 0.95, droppedByFilterCount: 0 },
          },
    );
    lookupCrossReferenceMock.mockResolvedValue({
      fallbackRecommended: false,
      matches: [
        {
          competitorBrand: 'BNC',
          competitorProductName: 'BNC-15',
          productKey: 'triforce',
          confidence: 0.9,
          productUrl: 'https://www.betco.com/products/triforce',
          betcoProduct: { title: 'Triforce', sku: '1234' },
          rationale: 'curated equivalence',
        },
      ],
    });

    const out = await run({ userMessage: XREF_MESSAGE });

    expect(out.agentConfidence).toBeNull();
    expect(out.confidence).toBeLessThanOrEqual(0.8);
    expect(out.confidenceProvenance).toBe('gate_capped');
    expect(out.confidencePreCapValue).toBe(0.9);
    expect(out.confidencePreCapProvenance).toBe('validator_bypassed_heuristic');
  });
});

/* -------------------------------------------------------------------------- *
 * B0-494 — which gates and runtimes were active per run.
 * -------------------------------------------------------------------------- */

describe('runtime config and gate activation (B0-494)', () => {
  it('records the resolved switches on a default answered run', async () => {
    const out = await run();

    expect(out.runtimeConfig).toMatchObject({
      useValidator: false,
      earlyDeclineGateEnabled: true,
      aiSdkGenerationEnabled: false,
      confidenceGatingDisabled: false,
      agentMode: 'orchestrator',
      routedDirectly: false,
    });
    expect(typeof out.runtimeConfig?.rerankerActive).toBe('boolean');
  });

  it('marks the validator "skipped — disabled by flag" when useValidator is false, and "ran" when true', async () => {
    const bypassed = await run();
    expect(bypassed.activeGates?.validator).toEqual({ state: 'skipped', reason: 'disabled_by_flag' });

    const judged = await run({ useValidator: true });
    expect(judged.activeGates?.validator).toEqual({ state: 'ran' });
  });

  it('marks the early-decline gate "skipped — disabled by flag" when BEX_EARLY_DECLINE_GATE_ENABLED=false', async () => {
    process.env.BEX_EARLY_DECLINE_GATE_ENABLED = 'false';
    const out = await run();
    expect(out.runtimeConfig?.earlyDeclineGateEnabled).toBe(false);
    expect(out.activeGates?.earlyDeclineGate).toEqual({ state: 'skipped', reason: 'disabled_by_flag' });
  });

  it('marks the early-decline gate "ran" on a run it actually declines, and the other four gates not_applicable', async () => {
    const out = await run({ userMessage: 'Can I mix bleach with this Betco cleaner?' });
    expect(out.activeGates).toEqual({
      validator: { state: 'not_applicable' },
      earlyDeclineGate: { state: 'ran' },
      usageSafetyCoverage: { state: 'not_applicable' },
      regulatedClaimGuardrail: { state: 'not_applicable' },
      recommendationConfidence: { state: 'not_applicable' },
    });
    // The switches are still recorded even though the answering path never ran.
    expect(out.runtimeConfig).toBeDefined();
  });

  it('marks usage/safety coverage "ran" when the question needs it and evidence is present', async () => {
    const out = await run();
    expect(out.activeGates?.usageSafetyCoverage).toEqual({ state: 'ran' });
    expect(out.activeGates?.regulatedClaimGuardrail).toEqual({ state: 'ran' });
    expect(out.activeGates?.recommendationConfidence).toEqual({ state: 'not_applicable' });
  });

  it('marks usage/safety coverage not_applicable when the question does not need it at all', async () => {
    const out = await run({ userMessage: 'What is the EPA reg number for Betco Fight Bac RTU?' });
    expect(out.activeGates?.usageSafetyCoverage).toEqual({ state: 'not_applicable' });
  });

  it('is identifiable as run-under-the-kill-switch: usage/safety coverage bypassed, confidenceGatingDisabled true', async () => {
    process.env.BEX_DISABLE_CONFIDENCE_GATING = 'true';
    executeProductToolMock.mockResolvedValue({
      sources: [
        {
          documentId: 'doc-1',
          chunkId: 'chunk-1',
          title: 'pH7Q Dual label',
          snippet: 'Usage: apply to the floor with a mop.',
          documentBody: 'Usage: apply to the floor with a mop.',
        },
      ],
    });

    const out = await run();

    expect(out.runtimeConfig?.confidenceGatingDisabled).toBe(true);
    expect(out.activeGates?.usageSafetyCoverage).toEqual({
      state: 'bypassed',
      reason: 'confidence_gating_disabled',
    });

    delete process.env.BEX_DISABLE_CONFIDENCE_GATING;
  });

  it('marks the recommendation-confidence gate "ran" (not not_applicable) whenever cross-reference post-processing runs', async () => {
    arrangeOverrideRun();
    const out = await run({ userMessage: XREF_MESSAGE });
    expect(out.activeGates?.recommendationConfidence).toEqual({ state: 'ran' });
  });

  it('records routedDirectly when an admin forces a direct specialist mode', async () => {
    const out = await run({ agentMode: 'floor' });
    expect(out.runtimeConfig?.agentMode).toBe('floor');
    expect(out.runtimeConfig?.routedDirectly).toBe(true);
  });

  it('historical runs lacking the block are undefined, not defaulted to fully-enabled', async () => {
    // Sanity check on the contract itself: both fields are optional, so an older
    // final_output payload simply omits them rather than parsing to a default value.
    const { productSupportFinalOutputSchema } = await import(
      '~/lib/workflows/product-support/product-support-schemas'
    );
    const parsed = productSupportFinalOutputSchema.safeParse({
      answerText: 'x',
      workflowRunId: '00000000-0000-4000-8000-000000000000',
      latestOpenaiResponseId: 'resp_1',
      validation: { approved: true, confidence: 0.9, issues: [], requires_human_review: false },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.runtimeConfig).toBeUndefined();
      expect(parsed.data.activeGates).toBeUndefined();
    }
  });
});
