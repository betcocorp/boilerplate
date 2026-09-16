import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/tests/repository', () => ({
  claimQueuedTestResultForExecution: vi.fn(),
  getTestResultById: vi.fn(),
}));
vi.mock('~/lib/tests/run-executor', () => ({
  executeTestRun: vi.fn(),
}));
vi.mock('~/lib/tests/search-run-executor', () => ({
  executeSearchRun: vi.fn(),
}));
vi.mock('~/lib/tests/schedule-run-continuation', () => ({
  scheduleRunContinuation: vi.fn(),
}));

import {
  claimAndExecuteQueuedRun,
  claimQueuedTestRun,
  executeClaimedRun,
  executeQueuedTestRun,
} from '~/lib/tests/execute-queued-run';
import {
  claimQueuedTestResultForExecution,
  getTestResultById,
} from '~/lib/tests/repository';
import { executeTestRun } from '~/lib/tests/run-executor';
import { scheduleRunContinuation } from '~/lib/tests/schedule-run-continuation';
import { executeSearchRun } from '~/lib/tests/search-run-executor';

const RUN_ID = '6d1f7c2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';

type Run = Awaited<ReturnType<typeof getTestResultById>>;

function run(overrides: Partial<Run>): Run {
  return { id: RUN_ID, status: 'queued', run_mode: 'full', ...overrides } as unknown as Run;
}

describe('executeQueuedTestRun (B0-883)', () => {
  beforeEach(() => {
    vi.mocked(getTestResultById).mockReset();
    vi.mocked(claimQueuedTestResultForExecution).mockReset();
    vi.mocked(executeTestRun).mockReset();
    vi.mocked(executeSearchRun).mockReset();
    vi.mocked(executeTestRun).mockResolvedValue(undefined as never);
    vi.mocked(executeSearchRun).mockResolvedValue(undefined as never);
  });

  it('returns not_found when the run does not exist, without claiming or executing', async () => {
    vi.mocked(getTestResultById).mockRejectedValue(new Error('no rows'));

    await expect(executeQueuedTestRun(RUN_ID)).resolves.toEqual({ state: 'not_found' });
    expect(claimQueuedTestResultForExecution).not.toHaveBeenCalled();
    expect(executeTestRun).not.toHaveBeenCalled();
    expect(executeSearchRun).not.toHaveBeenCalled();
  });

  it.each(['completed', 'completed_with_failures', 'failed', 'technical_error', 'cancelled'])(
    'returns already_finished for a terminal run (%s) with no execute call',
    async (status) => {
      vi.mocked(getTestResultById).mockResolvedValue(run({ status }));

      await expect(executeQueuedTestRun(RUN_ID)).resolves.toEqual({ state: 'already_finished' });
      expect(claimQueuedTestResultForExecution).not.toHaveBeenCalled();
      expect(executeTestRun).not.toHaveBeenCalled();
      expect(executeSearchRun).not.toHaveBeenCalled();
    },
  );

  it('claims a queued full run and executes it on the test runner', async () => {
    vi.mocked(getTestResultById).mockResolvedValue(run({ status: 'queued', run_mode: 'full' }));
    vi.mocked(claimQueuedTestResultForExecution).mockResolvedValue(true);

    await expect(executeQueuedTestRun(RUN_ID)).resolves.toEqual({ state: 'started' });
    expect(claimQueuedTestResultForExecution).toHaveBeenCalledWith(RUN_ID);
    expect(executeTestRun).toHaveBeenCalledWith(RUN_ID);
    expect(executeSearchRun).not.toHaveBeenCalled();
  });

  it('returns already_running when another caller wins the claim, and does not execute', async () => {
    vi.mocked(getTestResultById).mockResolvedValue(run({ status: 'queued' }));
    vi.mocked(claimQueuedTestResultForExecution).mockResolvedValue(false);

    await expect(executeQueuedTestRun(RUN_ID)).resolves.toEqual({ state: 'already_running' });
    expect(claimQueuedTestResultForExecution).toHaveBeenCalledWith(RUN_ID);
    expect(executeTestRun).not.toHaveBeenCalled();
    expect(executeSearchRun).not.toHaveBeenCalled();
  });

  it('dispatches a queued search run to the search-run executor', async () => {
    vi.mocked(getTestResultById).mockResolvedValue(run({ status: 'queued', run_mode: 'search' }));
    vi.mocked(claimQueuedTestResultForExecution).mockResolvedValue(true);

    await expect(executeQueuedTestRun(RUN_ID)).resolves.toEqual({ state: 'started' });
    expect(executeSearchRun).toHaveBeenCalledWith(RUN_ID);
    expect(executeTestRun).not.toHaveBeenCalled();
  });

  it.each(['running', 'paused'])(
    'returns already_running for a non-queued, non-terminal run (%s) without claiming',
    async (status) => {
      vi.mocked(getTestResultById).mockResolvedValue(run({ status }));

      await expect(executeQueuedTestRun(RUN_ID)).resolves.toEqual({ state: 'already_running' });
      expect(claimQueuedTestResultForExecution).not.toHaveBeenCalled();
      expect(executeTestRun).not.toHaveBeenCalled();
    },
  );
});

describe('claimAndExecuteQueuedRun (B0-883)', () => {
  beforeEach(() => {
    vi.mocked(claimQueuedTestResultForExecution).mockReset();
    vi.mocked(executeTestRun).mockReset();
    vi.mocked(executeSearchRun).mockReset();
    vi.mocked(executeTestRun).mockResolvedValue(undefined as never);
    vi.mocked(executeSearchRun).mockResolvedValue(undefined as never);
  });

  it('executes on the runner matching run_mode only when the claim is won', async () => {
    vi.mocked(claimQueuedTestResultForExecution).mockResolvedValue(true);
    await expect(claimAndExecuteQueuedRun({ id: RUN_ID, run_mode: 'search' })).resolves.toBe(true);
    expect(executeSearchRun).toHaveBeenCalledWith(RUN_ID);
    expect(executeTestRun).not.toHaveBeenCalled();
  });

  it('returns false and executes nothing when the claim is lost', async () => {
    vi.mocked(claimQueuedTestResultForExecution).mockResolvedValue(false);
    await expect(claimAndExecuteQueuedRun({ id: RUN_ID, run_mode: 'full' })).resolves.toBe(false);
    expect(executeTestRun).not.toHaveBeenCalled();
    expect(executeSearchRun).not.toHaveBeenCalled();
  });
});

describe('executeClaimedRun / claimQueuedTestRun (B0-990)', () => {
  beforeEach(() => {
    vi.mocked(getTestResultById).mockReset();
    vi.mocked(claimQueuedTestResultForExecution).mockReset();
    vi.mocked(executeTestRun).mockReset();
    vi.mocked(executeSearchRun).mockReset();
    vi.mocked(scheduleRunContinuation).mockReset();
    vi.mocked(scheduleRunContinuation).mockResolvedValue({ scheduled: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('schedules the next hop when the executor yields, and not otherwise', async () => {
    vi.mocked(executeTestRun).mockResolvedValue('yielded');
    await expect(executeClaimedRun({ id: RUN_ID, run_mode: 'full' }, { hop: 2 })).resolves.toBe(
      'yielded',
    );
    expect(scheduleRunContinuation).toHaveBeenCalledWith({ testResultId: RUN_ID, hop: 3 });

    vi.mocked(scheduleRunContinuation).mockClear();
    vi.mocked(executeTestRun).mockResolvedValue('completed');
    await expect(executeClaimedRun({ id: RUN_ID, run_mode: 'full' })).resolves.toBe('completed');
    expect(scheduleRunContinuation).not.toHaveBeenCalled();
  });

  it('defaults a fresh start to hop 1 so the continuation is hop 2', async () => {
    vi.mocked(executeTestRun).mockResolvedValue('yielded');
    await executeClaimedRun({ id: RUN_ID, run_mode: 'full' });
    expect(scheduleRunContinuation).toHaveBeenCalledWith({ testResultId: RUN_ID, hop: 2 });
  });

  it('never yields a search run', async () => {
    vi.mocked(executeSearchRun).mockResolvedValue(undefined as never);
    await expect(executeClaimedRun({ id: RUN_ID, run_mode: 'search' })).resolves.toBe('completed');
    expect(executeTestRun).not.toHaveBeenCalled();
    expect(scheduleRunContinuation).not.toHaveBeenCalled();
  });

  it('claimQueuedTestRun hands back the row only when the compare-and-set is won', async () => {
    const queued = run({ status: 'queued' });
    vi.mocked(getTestResultById).mockResolvedValue(queued);

    vi.mocked(claimQueuedTestResultForExecution).mockResolvedValue(true);
    await expect(claimQueuedTestRun(RUN_ID)).resolves.toEqual({ state: 'claimed', run: queued });

    vi.mocked(claimQueuedTestResultForExecution).mockResolvedValue(false);
    await expect(claimQueuedTestRun(RUN_ID)).resolves.toEqual({ state: 'already_running' });

    vi.mocked(getTestResultById).mockResolvedValue(run({ status: 'completed' }));
    await expect(claimQueuedTestRun(RUN_ID)).resolves.toEqual({ state: 'already_finished' });

    vi.mocked(getTestResultById).mockRejectedValue(new Error('no rows'));
    await expect(claimQueuedTestRun(RUN_ID)).resolves.toEqual({ state: 'not_found' });
  });
});
