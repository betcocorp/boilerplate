import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-386 — the workflow failure handler used to `completeWorkflowStep(agentStep.id, {status:
 * 'failed', error})` unconditionally. Two defects fell out of that:
 *
 * 1. `completeWorkflowStep` wrote `output: patch.output ?? null`, so the status-only failure
 *    patch NULLED the agent step's already-persisted `toolTrace` / `usage` payload.
 * 2. Any throw after the agent step completed (validator timeout, 429 on the revision call,
 *    a Supabase error while persisting the message) was blamed on the agent step, while the
 *    step that actually threw was left `running` forever.
 *
 * These tests drive the REAL `~/lib/conversations/workflow-repository` against an in-memory
 * Supabase double, so the conditional patch building is exercised end-to-end rather than mocked.
 */

type Row = Record<string, unknown>;

type FakeSupabase = {
  client: unknown;
  tables: Record<string, Row[]>;
  /** Every update patch handed to Supabase, so key PRESENCE can be asserted (not just values). */
  updates: { table: string; patch: Row }[];
  /** Tables whose insert should fail, to simulate a late Supabase error. */
  failInsertFor: Set<string>;
};

function createFakeSupabase(): FakeSupabase {
  const tables: Record<string, Row[]> = {};
  const updates: { table: string; patch: Row }[] = [];
  const failInsertFor = new Set<string>();
  let sequence = 0;

  const rowsFor = (table: string): Row[] => (tables[table] ??= []);

  const client = {
    from(table: string) {
      return {
        insert(row: Row) {
          if (failInsertFor.has(table)) {
            const failure = { data: null, error: { message: `insert into ${table} failed` } };
            return {
              select: () => ({ single: async () => failure }),
              then: (resolve: (value: typeof failure) => unknown) => resolve(failure),
            };
          }

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
          updates.push({ table, patch });
          return {
            async eq(column: string, value: unknown) {
              for (const row of rowsFor(table)) {
                if (row[column] === value) {
                  // Postgres semantics: only the columns present in the patch are written.
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

  return { client, tables, updates, failInsertFor };
}

let fake = createFakeSupabase();

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => fake.client,
}));

const runValidatorPassMock = vi.fn();

vi.mock('~/lib/openai/client', () => ({
  getOpenAIClient: () => ({}),
  resolveResponsesModel: () => 'gpt-test',
}));

vi.mock('~/lib/openai/responses-runtime', () => ({
  runResponsesWithToolLoop: async () => ({
    lastResponse: {},
    finalResponseId: 'resp_final',
    assistantText: 'Dilute per the label instructions.',
    toolTrace: [
      {
        toolName: 'search_product_docs',
        callId: 'call_1',
        argumentsPreview: '{"productName":"pH7Q Dual"}',
        outputPreview: '{"sources":[{"documentId":"doc-1"}]}',
        ok: true,
        durationMs: 42,
      },
    ],
    responseIds: ['resp_1'],
    usage: {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedPromptTokens: 0,
    },
    usageByCall: [
      {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedPromptTokens: 0,
      },
    ],
  }),
  // B0-563 — `~/lib/openai/client`'s `getOpenAIClient` returns `{}` above, so any
  // `client.responses.create` call in this file throws before reaching this function; it only
  // needs to exist so the named import in `intent-classifier.ts`/`extract-competitor-product.ts`
  // resolves against this mocked module.
  usageFromResponse: () => ({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
  }),
}));

vi.mock('~/lib/workflows/product-support/validator', () => ({
  runValidatorPass: (...args: unknown[]) => runValidatorPassMock(...args),
  runRevisionPass: async () => ({ text: '', refused: true }),
  evaluateRegulatedClaimGrounding: () => ({
    categoriesDetected: [],
    ungroundedCategories: [],
    ungroundedDetails: [],
    // B0-888 — the workflow now reads this field to record `groundingMode` on the gate record.
    keyTermGroundedCategories: [],
  }),
  // B0-699 — the workflow now also runs this guardrail unconditionally alongside the one above;
  // this suite's fixtures never cite [doc:verified-facts], so `applicable: false` is the neutral,
  // always-passing shape.
  evaluateVerifiedFactsDilutionCitation: () => ({
    applicable: false,
    grounded: true,
    citedTokens: [],
    ungroundedTokens: [],
  }),
  // B0-389 — the workflow now records the validator/revision prompt and model on their steps.
  // B0-886 — updated to a fixture of the new edit-only instruction wording (not asserted verbatim
  // anywhere in this file; only needs to exist for the recorded-prompt step input to parse).
  REVISION_SYSTEM_PROMPT:
    'Edit ONLY the sentence(s), list item(s), or claim(s) the issues actually flag.',
  resolveValidatorModel: () => 'gpt-test',
  resolveRevisionModel: () => 'gpt-test',
  // B0-886 — new validator.ts exports the workflow now imports; must exist on this full mock or
  // calling them throws "is not a function".
  isOnlyRegulatedClaimIssues: (issues: string[]) =>
    issues.length > 0 && issues.every((issue) => issue.startsWith('regulated_claim_unverified:')),
  isRevisionSkipForRegulatedClaimOnlyEnabled: async () => false,
  stripRevisionPreamble: (text: string) => text,
}));

import { completeWorkflowStep } from '~/lib/conversations/workflow-repository';
import {
  ABANDONED_WORKFLOW_STEP_REASON,
  failOpenWorkflowSteps,
  runProductSupportWorkflow,
} from '~/lib/workflows/product-support/run-product-support-workflow';

const USER_MESSAGE = 'How do I dilute pH7Q Dual for tile floors?';

function workflowSteps(): Row[] {
  return fake.tables.workflow_steps ?? [];
}

function stepNamed(name: string): Row {
  const step = workflowSteps().find((row) => row.step_name === name);
  expect(step, `expected a "${name}" step to be persisted`).toBeDefined();
  return step as Row;
}

function seedStep(overrides: Row = {}): Row {
  const step: Row = {
    id: 'step-seed',
    workflow_run_id: 'run-seed',
    step_name: 'openai_responses_agent',
    status: 'running',
    output: { toolTrace: [{ toolName: 'search_product_docs' }] },
    error: null,
    completed_at: null,
    ...overrides,
  };
  (fake.tables.workflow_steps ??= []).push(step);
  return step;
}

beforeEach(() => {
  fake = createFakeSupabase();
  runValidatorPassMock.mockReset();
  // B0-436 — these tests are about failure ATTRIBUTION, not retrieval. Speculative retrieval would
  // add a second (real, and here failing) `search_product_docs` call to every run's tool trace; it
  // has its own coverage in `speculative-retrieval.test.ts`.
  vi.stubEnv('BEX_SPECULATIVE_RETRIEVAL', 'false');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('completeWorkflowStep patch building (B0-386)', () => {
  it('leaves output untouched when the caller only supplies status + error', async () => {
    const step = seedStep();

    await completeWorkflowStep('step-seed', {
      status: 'failed',
      error: { message: 'boom' },
    });

    const patch = fake.updates.at(-1)?.patch ?? {};
    expect('output' in patch).toBe(false);
    expect(step.output).toEqual({ toolTrace: [{ toolName: 'search_product_docs' }] });
    expect(step.status).toBe('failed');
    expect(step.error).toEqual({ message: 'boom' });
    expect(step.completed_at).toEqual(expect.any(String));
  });

  it('leaves error untouched when the caller only supplies status + output', async () => {
    const step = seedStep({ error: { message: 'earlier failure' } });

    await completeWorkflowStep('step-seed', {
      status: 'completed',
      output: { toolCalls: 1 },
    });

    const patch = fake.updates.at(-1)?.patch ?? {};
    expect('error' in patch).toBe(false);
    expect(step.error).toEqual({ message: 'earlier failure' });
    expect(step.output).toEqual({ toolCalls: 1 });
  });

  it('still clears a column when the caller passes an explicit null', async () => {
    const step = seedStep();

    await completeWorkflowStep('step-seed', { status: 'completed', output: null });

    const patch = fake.updates.at(-1)?.patch ?? {};
    expect('output' in patch).toBe(true);
    expect(step.output).toBeNull();
  });
});

describe('failOpenWorkflowSteps (B0-386)', () => {
  it('blames the most recently opened step and marks the rest abandoned', async () => {
    const outer = seedStep({ id: 'step-outer', step_name: 'openai_responses_agent' });
    const inner = seedStep({ id: 'step-inner', step_name: 'validator' });

    await failOpenWorkflowSteps(['step-outer', 'step-inner'], 'validator exploded');

    expect(inner.status).toBe('failed');
    expect(inner.error).toEqual({ message: 'validator exploded' });
    expect(outer.status).toBe('failed');
    expect(outer.error).toEqual({
      message: 'validator exploded',
      reason: ABANDONED_WORKFLOW_STEP_REASON,
    });
  });

  it('touches nothing when every step already closed', async () => {
    const step = seedStep({ status: 'completed' });

    await failOpenWorkflowSteps([], 'late supabase error');

    expect(fake.updates).toHaveLength(0);
    expect(step.status).toBe('completed');
  });
});

describe('runProductSupportWorkflow failure attribution (B0-386)', () => {
  it('keeps the completed agent step (and its tool trace) when the validator throws', async () => {
    runValidatorPassMock.mockRejectedValue(new Error('validator exploded'));

    await expect(
      runProductSupportWorkflow({
        traceId: 'trace-1',
        conversationId: 'conversation-1',
        userMessage: USER_MESSAGE,
        useValidator: true,
      }),
    ).rejects.toThrow('validator exploded');

    const agentStep = stepNamed('openai_responses_agent');
    expect(agentStep.status).toBe('completed');
    const agentOutput = agentStep.output as { toolCalls: number; toolTrace: unknown[] };
    expect(agentOutput.toolCalls).toBe(1);
    expect(agentOutput.toolTrace).toHaveLength(1);
    expect(agentStep.error).toBeNull();

    const validatorStep = stepNamed('validator');
    expect(validatorStep.status).toBe('failed');
    expect(validatorStep.error).toEqual({ message: 'validator exploded' });

    expect(workflowSteps().filter((step) => step.status === 'running')).toEqual([]);
    expect(fake.tables.workflow_runs?.[0]?.status).toBe('failed');
  });

  it('leaves both completed steps intact when the throw happens after the last step closed', async () => {
    fake.failInsertFor.add('agent_messages');

    await expect(
      runProductSupportWorkflow({
        traceId: 'trace-2',
        conversationId: 'conversation-2',
        userMessage: USER_MESSAGE,
      }),
    ).rejects.toThrow('insert into agent_messages failed');

    const agentStep = stepNamed('openai_responses_agent');
    expect(agentStep.status).toBe('completed');
    expect((agentStep.output as { toolTrace: unknown[] }).toolTrace).toHaveLength(1);

    const validatorStep = stepNamed('validator');
    expect(validatorStep.status).toBe('completed');
    expect(validatorStep.output).not.toBeNull();

    expect(workflowSteps().filter((step) => step.status === 'running')).toEqual([]);
    expect(fake.tables.workflow_runs?.[0]?.status).toBe('failed');
  });
});
