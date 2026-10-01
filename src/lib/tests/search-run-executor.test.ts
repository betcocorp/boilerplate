import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-1014-parity — the same provider-fault circuit breaker `run-executor.test.ts` covers for the
 * chat-eval runner, ported to the search/retrieval-eval runner. `./provider-fault` is deliberately
 * NOT mocked: the streak rule and classifier are the behaviour under test.
 */

vi.mock('~/lib/observability/logger', () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock('~/lib/rag/search', () => ({ searchProductChunks: vi.fn() }));

vi.mock('./repository', () => ({
  computeAvgSimilarityForResult: vi.fn(),
  countPassedAndFailedByResultId: vi.fn(),
  getExistingResultItemIds: vi.fn(),
  getTestById: vi.fn(),
  getTestItemsByTestId: vi.fn(),
  getTestResultById: vi.fn(),
  insertTestResultItems: vi.fn(),
  sumResultItemsElapsedMsByResultId: vi.fn(),
  updateTestRecord: vi.fn(),
  updateTestResult: vi.fn(),
}));
vi.mock('./failure-root-cause', () => ({ analyzeAndPersistFailureRootCause: vi.fn() }));
vi.mock('./run-executor', () => ({
  describeProviderFaultAbort: (input: {
    faultKind: string;
    streak: number;
    completedItems: number;
    totalItems: number;
  }) =>
    `Run aborted after ${input.streak} consecutive provider faults (${input.faultKind}). ` +
    'The model provider refused every request; this run measured nothing.',
  RUNNER_STATE_ABORTED: 'aborted',
}));

import { logError } from '~/lib/observability/logger';
import { searchProductChunks } from '~/lib/rag/search';

import {
  computeAvgSimilarityForResult,
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
import { PROVIDER_FAULT_ABORT_STREAK } from './provider-fault';
import { executeSearchRun } from './search-run-executor';

const RUN_ID = '11111111-2222-3333-4444-555555555555';
const TEST_ID = '99999999-8888-7777-6666-555555555555';

const CREDIT_ERROR =
  'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.';

type ItemScript = 'faulted' | 'passed' | 'quality_failure';

function setUpRun(script: ItemScript[]) {
  const items = script.map((_, index) => ({
    id: `item-${index}`,
    row_index: index,
    prompt: `prompt ${index}`,
    expected_canonical_products: [],
  }));

  vi.mocked(getTestResultById).mockResolvedValue({
    id: RUN_ID,
    test_id: TEST_ID,
    status: 'running',
    summary: {},
    run_options: {},
  } as never);
  vi.mocked(getTestById).mockResolvedValue({ id: TEST_ID, name: 'Golden — Retrieval' } as never);
  vi.mocked(getTestItemsByTestId).mockResolvedValue(items as never);
  vi.mocked(getExistingResultItemIds).mockResolvedValue(new Set<string>() as never);
  vi.mocked(sumResultItemsElapsedMsByResultId).mockResolvedValue(0 as never);
  vi.mocked(insertTestResultItems).mockImplementation(
    async (rows) => rows.map((row, i) => ({ ...row, id: `result-${i}` })) as never,
  );
  vi.mocked(updateTestResult).mockResolvedValue(undefined as never);
  vi.mocked(updateTestRecord).mockResolvedValue(undefined as never);
  vi.mocked(countPassedAndFailedByResultId).mockResolvedValue({ passed: 0, failed: 0 } as never);
  vi.mocked(computeAvgSimilarityForResult).mockResolvedValue(null as never);

  let call = 0;
  vi.mocked(searchProductChunks).mockImplementation(async () => {
    const kind = script[call];
    call += 1;
    if (kind === 'faulted') {
      throw Object.assign(new Error(CREDIT_ERROR), { statusCode: 429 });
    }
    return {
      matches: kind === 'passed' ? [{ product_line_key: 'x', similarity: 0.9 }] : [],
      embeddingSource: 'live',
      retrieval_strategy: 'vector',
      timings: { rerankMs: 0 },
      query: 'q',
      model: 'text-embedding-3-large',
    } as never;
  });

  return { items };
}

function lastRunUpdate() {
  const calls = vi.mocked(updateTestResult).mock.calls;
  return calls[calls.length - 1]?.[1] as {
    status?: string;
    summary?: Record<string, unknown>;
  };
}

describe('executeSearchRun — provider-fault circuit breaker (B0-1014-parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops dispatching and closes the run as technical_error after three consecutive provider faults', async () => {
    setUpRun(Array.from({ length: 20 }, () => 'faulted' as const));

    await executeSearchRun(RUN_ID);

    // Exactly the streak ran — the remaining 17 items were never dispatched.
    expect(searchProductChunks).toHaveBeenCalledTimes(PROVIDER_FAULT_ABORT_STREAK);

    const closing = lastRunUpdate();
    expect(closing.status).toBe('technical_error');
    expect(closing.summary?.runner_state).toBe('aborted');
    expect(closing.summary?.provider_fault).toBe('insufficient_quota');
    expect(closing.summary?.provider_fault_streak).toBe(PROVIDER_FAULT_ABORT_STREAK);
  });

  it('does not run the retrieval root-cause analyzer for provider-faulted items', async () => {
    const { analyzeAndPersistFailureRootCause } = await import('./failure-root-cause');
    setUpRun(Array.from({ length: 20 }, () => 'faulted' as const));

    await executeSearchRun(RUN_ID);

    expect(analyzeAndPersistFailureRootCause).not.toHaveBeenCalled();
  });

  it('logs the abort with the fault kind', async () => {
    setUpRun(Array.from({ length: 10 }, () => 'faulted' as const));

    await executeSearchRun(RUN_ID);

    expect(logError).toHaveBeenCalledWith(
      'test_run_aborted_provider_fault',
      expect.objectContaining({
        testResultId: RUN_ID,
        providerFault: 'insufficient_quota',
        streak: PROVIDER_FAULT_ABORT_STREAK,
        runMode: 'search',
      }),
    );
  });

  it('resets the streak on any answered item, so scattered faults never abort', async () => {
    // 2 faults, one real answer, 2 more faults — never three in a row.
    setUpRun(['faulted', 'faulted', 'passed', 'faulted', 'faulted']);

    await executeSearchRun(RUN_ID);

    expect(searchProductChunks).toHaveBeenCalledTimes(5);
    expect(lastRunUpdate().status).toBe('completed');
  });

  it('never aborts on ordinary retrieval misses, however many in a row', async () => {
    setUpRun(Array.from({ length: 8 }, () => 'quality_failure' as const));

    await executeSearchRun(RUN_ID);

    expect(searchProductChunks).toHaveBeenCalledTimes(8);
    expect(lastRunUpdate().status).toBe('completed');
    expect(logError).not.toHaveBeenCalled();
  });
});
