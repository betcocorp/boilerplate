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

  const client = {
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

vi.mock('~/lib/openai/client', () => ({
  getOpenAIClient: () => ({}),
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
} from '~/lib/workflows/product-support/product-support-schemas';
import { REVISION_SYSTEM_PROMPT } from '~/lib/workflows/product-support/validator';
import {
  runProductSupportWorkflow,
  VALIDATOR_BYPASS_REASON,
} from '~/lib/workflows/product-support/run-product-support-workflow';

const USAGE_MESSAGE = 'How do I use Betco pH7Q Dual on tile floors?';
const XREF_MESSAGE = 'What is the Betco equivalent to BNC-15?';

const AGENT_USAGE = {
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
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
  });
  runRevisionPassMock.mockResolvedValue('');
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
      })
      .mockResolvedValue({
        approved: true,
        confidence: 0.8,
        issues: [],
        requires_human_review: false,
      });
  });

  it('carries its own prompt and reports the replaced draft', async () => {
    runRevisionPassMock.mockResolvedValue('Use 2 oz per gallon of water.');

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
    runRevisionPassMock.mockResolvedValue(
      'Clarification needed: please supply approved documentation.',
    );

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

    const trace = persistedToolTrace();
    expect(trace).toHaveLength(1);
    expect(trace[0]?.origin).toBe('model_chosen');
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

    const entry = persistedToolTrace()[0];
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
    expect(output.toolCalls).toBe(1);
    const trace = persistedToolTrace();
    expect(trace).toHaveLength(1);
    expect(trace[0]?.callId).toBe('call_before_throw');
    expect(trace[0]?.argumentsPreview).toContain('floor wax');
    expect(steps().filter((step) => step.status === 'running')).toEqual([]);
  });

  it('leaves the agent step output alone when the run throws before any tool call', async () => {
    runResponsesWithToolLoopMock.mockImplementation(async () => {
      throw new Error('model unavailable');
    });

    await expect(run()).rejects.toThrow('model unavailable');

    const agentStep = stepNamed('openai_responses_agent');
    expect(agentStep.status).toBe('failed');
    expect(agentStep.output).toBeNull();
  });
});
