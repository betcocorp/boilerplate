import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-1014 — the provider-fault circuit breaker. Everything the executor touches that is I/O or a
 * model call is mocked; `./provider-fault` is deliberately NOT mocked, because the streak rule and
 * the classifier are the behaviour under test.
 */

vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('~/lib/constants/models', () => ({ modelProviderFor: () => 'openai' }));
vi.mock('~/lib/llm/generation-runtime', () => ({
  CURRENT_GENERATION_RUNTIME: 'ai_sdk',
  isGenerationRuntime: () => false,
}));
vi.mock('~/lib/llm/resolve-model', () => ({ resolveModel: async () => 'gpt-4.1' }));
vi.mock('~/lib/observability/logger', () => ({ logError: vi.fn(), logWarn: vi.fn() }));
// Partial: `INTENT_VALUES` is re-exported through the signals schemas, so the real module must load.
vi.mock('~/lib/orchestrator/intent-classifier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/orchestrator/intent-classifier')>()),
  classifyUserIntent: async () => ({
    intent: 'ambiguous' as const,
    confidence: 0,
    source: 'llm' as const,
    fallbackReason: null,
  }),
}));
vi.mock('~/lib/orchestrator/semantic-router', () => ({
  classifyUserIntentSemantic: async () => {
    throw new Error('semantic router disabled in this test');
  },
}));
vi.mock('~/lib/orchestrator/sme-routing', () => ({
  routeUserMessageToSme: () => ({ agent: null }),
}));
vi.mock('~/lib/settings/settings-service', () => ({ getBooleanSetting: async () => false }));

vi.mock('./repository', () => ({
  countPassedAndFailedByResultId: vi.fn(),
  getExistingResultItemIds: vi.fn(),
  getTestById: vi.fn(),
  getTestItemsByTestId: vi.fn(),
  getTestResultById: vi.fn(),
  insertTestResultItems: vi.fn(),
  listOrchestrationPlannerStepOutputsByWorkflowRunIds: vi.fn(),
  sumResultItemsElapsedMsByResultId: vi.fn(),
  updateTestRecord: vi.fn(),
  updateTestResult: vi.fn(),
}));
vi.mock('./failure-root-cause', () => ({ analyzeAndPersistFailureRootCause: vi.fn() }));
vi.mock('./report/schedule-report-generation', () => ({ scheduleReportGeneration: vi.fn() }));
vi.mock('./run-insights', () => ({ generateAndSaveRunInsights: vi.fn() }));
vi.mock('./run-comparison', () => ({
  runRunComparisonAnalysis: vi.fn(),
  startRunComparison: vi.fn(),
}));
vi.mock('./schedule-run-continuation', () => ({ canScheduleRunContinuation: () => false }));
vi.mock('./runner', () => ({ runSingleTestItem: vi.fn() }));

import { after } from 'next/server';
import { logError } from '~/lib/observability/logger';

import {
  countPassedAndFailedByResultId,
  getExistingResultItemIds,
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  insertTestResultItems,
  sumResultItemsElapsedMsByResultId,
  updateTestRecord,
  updateTestResult,
} from './repository';
import { generateAndSaveRunInsights } from './run-insights';
import { startRunComparison } from './run-comparison';
import { executeTestRun, RUNNER_STATE_ABORTED } from './run-executor';
import { PROVIDER_FAULT_ABORT_STREAK } from './provider-fault';
import { runSingleTestItem } from './runner';

const RUN_ID = '11111111-2222-3333-4444-555555555555';
const TEST_ID = '99999999-8888-7777-6666-555555555555';

/** The verbatim message every item threw during the 2026-09-14 credit outage. */
const CREDIT_ERROR =
  'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.';

type ItemScript = 'faulted' | 'passed' | 'quality_failure';

/**
 * B0-1028 — rows handed to `insertTestResultItems` across the run, standing in for the real
 * `test_result_items` table so the `countPassedAndFailedByResultId` mock below can recount from
 * persisted rows the same way the executor now does at both terminal writes, instead of trusting
 * a duplicate local tally.
 */
let insertedRows: Array<{ passed?: boolean }> = [];

function setUpRun(script: ItemScript[], runOverrides: Record<string, unknown> = {}) {
  insertedRows = [];
  const items = script.map((_, index) => ({
    id: `item-${index}`,
    row_index: index,
    prompt: `prompt ${index}`,
    intended_agent_item: null,
  }));

  vi.mocked(getTestResultById).mockResolvedValue({
    id: RUN_ID,
    test_id: TEST_ID,
    status: 'running',
    summary: {},
    run_options: {},
    passed_items: 0,
    failed_items: 0,
    item_scope: null,
    ...runOverrides,
  } as never);
  vi.mocked(getTestById).mockResolvedValue({
    id: TEST_ID,
    name: 'Golden — Dilution',
    intended_agent: null,
  } as never);
  vi.mocked(getTestItemsByTestId).mockResolvedValue(items as never);
  vi.mocked(getExistingResultItemIds).mockResolvedValue(new Set<string>() as never);
  vi.mocked(sumResultItemsElapsedMsByResultId).mockResolvedValue(0 as never);
  vi.mocked(insertTestResultItems).mockImplementation(async (rows) => {
    insertedRows.push(...(rows as Array<{ passed?: boolean }>));
    return rows.map((row, i) => ({ ...row, id: `result-${i}` })) as never;
  });
  vi.mocked(countPassedAndFailedByResultId).mockImplementation(
    async () =>
      ({
        passed: insertedRows.filter((row) => row.passed === true).length,
        failed: insertedRows.filter((row) => row.passed === false).length,
      }) as never,
  );
  vi.mocked(updateTestResult).mockResolvedValue(undefined as never);
  vi.mocked(updateTestRecord).mockResolvedValue(undefined as never);
  vi.mocked(generateAndSaveRunInsights).mockResolvedValue({ ok: true } as never);
  vi.mocked(startRunComparison).mockResolvedValue({ started: false } as never);

  let call = 0;
  vi.mocked(runSingleTestItem).mockImplementation(async () => {
    const kind = script[call];
    call += 1;
    if (kind === 'faulted') {
      return {
        passed: false,
        providerFault: 'insufficient_quota',
        item: {
          elapsed_ms: 10,
          error_message: CREDIT_ERROR,
          provider_fault: 'insufficient_quota',
          passed: false,
        },
      } as never;
    }
    return {
      passed: kind === 'passed',
      providerFault: null,
      item: { elapsed_ms: 10, error_message: null, provider_fault: null, passed: kind === 'passed' },
    } as never;
  });

  return { items };
}

/** The last `updateTestResult` call, i.e. how the run was closed. */
function lastRunUpdate() {
  const calls = vi.mocked(updateTestResult).mock.calls;
  return calls[calls.length - 1]?.[1] as {
    status?: string;
    summary?: Record<string, unknown>;
  };
}

describe('executeTestRun — provider-fault circuit breaker (B0-1014)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops dispatching and closes the run as technical_error after three consecutive provider faults', async () => {
    setUpRun(Array.from({ length: 20 }, () => 'faulted' as const));

    await expect(executeTestRun(RUN_ID)).resolves.toBe('aborted');

    // Exactly the streak ran — the remaining 17 items were never dispatched.
    expect(runSingleTestItem).toHaveBeenCalledTimes(PROVIDER_FAULT_ABORT_STREAK);

    const closing = lastRunUpdate();
    expect(closing.status).toBe('technical_error');
    expect(closing.summary?.runner_state).toBe(RUNNER_STATE_ABORTED);
    expect(closing.summary?.provider_fault).toBe('insufficient_quota');
    expect(closing.summary?.provider_fault_streak).toBe(PROVIDER_FAULT_ABORT_STREAK);
    expect(String(closing.summary?.abort_reason)).toContain('insufficient_quota');
    expect(String(closing.summary?.abort_reason)).toContain('measured nothing');
  });

  it('schedules neither a continuation nor a report when it aborts', async () => {
    setUpRun(Array.from({ length: 20 }, () => 'faulted' as const));

    await executeTestRun(RUN_ID);

    // `after()` is how BOTH report generation and the run comparison are scheduled.
    expect(after).not.toHaveBeenCalled();
    expect(generateAndSaveRunInsights).not.toHaveBeenCalled();
    // The dataset is handed back so a human can retry it once the provider is reachable.
    expect(updateTestRecord).toHaveBeenLastCalledWith(TEST_ID, { status: 'ready' });
  });

  it('logs the abort with the fault kind', async () => {
    setUpRun(Array.from({ length: 10 }, () => 'faulted' as const));

    await executeTestRun(RUN_ID);

    expect(logError).toHaveBeenCalledWith(
      'test_run_aborted_provider_fault',
      expect.objectContaining({
        testResultId: RUN_ID,
        providerFault: 'insufficient_quota',
        streak: PROVIDER_FAULT_ABORT_STREAK,
      }),
    );
  });

  it('resets the streak on any answered item, so scattered faults never abort', async () => {
    // 2 faults, one real answer, 2 more faults — never three in a row.
    setUpRun(['faulted', 'faulted', 'passed', 'faulted', 'faulted']);

    await expect(executeTestRun(RUN_ID)).resolves.toBe('completed');
    expect(runSingleTestItem).toHaveBeenCalledTimes(5);
    expect(lastRunUpdate().status).toBe('completed_with_failures');
  });

  it('never aborts on ordinary quality failures, however many in a row', async () => {
    setUpRun(Array.from({ length: 8 }, () => 'quality_failure' as const));

    await expect(executeTestRun(RUN_ID)).resolves.toBe('completed');
    expect(runSingleTestItem).toHaveBeenCalledTimes(8);
    expect(lastRunUpdate().status).toBe('completed_with_failures');
    expect(logError).not.toHaveBeenCalled();
  });
});

/**
 * B0-1110 — a partial run persists its `item_scope`; the executor must run exactly those items and
 * count only them. The repository still returns the whole dataset (mocked), so what is pinned is
 * that the scope is applied on the way in, not that the query changed.
 */
describe('executeTestRun — item_scope (B0-1110)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes only the scoped items, in dataset order, and counts only them', async () => {
    // Six items on the test; the run is scoped to three of them, stored out of order.
    setUpRun(Array.from({ length: 6 }, () => 'passed' as const), {
      run_mode: 'partial',
      item_scope: ['item-4', 'item-1', 'item-3'],
    });

    await expect(executeTestRun(RUN_ID)).resolves.toBe('completed');

    expect(runSingleTestItem).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(runSingleTestItem).mock.calls.map((call) => (call[1] as { id: string }).id),
    ).toEqual(['item-1', 'item-3', 'item-4']);

    const closing = lastRunUpdate();
    expect(closing.status).toBe('completed');
    expect(closing.summary?.total_items).toBe(3);
    expect(closing.summary?.completed_items).toBe(3);
    expect(closing.summary?.progress_percent).toBe(100);
    expect(closing.summary?.pass_rate).toBe(1);
  });

  it('runs the whole dataset when item_scope is null (unchanged behaviour)', async () => {
    setUpRun(Array.from({ length: 4 }, () => 'passed' as const));

    await expect(executeTestRun(RUN_ID)).resolves.toBe('completed');

    expect(runSingleTestItem).toHaveBeenCalledTimes(4);
    expect(lastRunUpdate().summary?.total_items).toBe(4);
  });
});
