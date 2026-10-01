import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-989 — what is pinned here is the ORDER of the ledger writes, not the HTTP choreography: the
 * child row must carry `test_run_id` the moment the create call returns, before execution is
 * awaited, and the sweep must stop waiting on execution at `executeWaitMs` and still report the
 * run id. On the 2026-09-14 sweep the id was only written after execution returned, four runs
 * outlived the sweep invocation, and their (completed) runs were closed as `timed_out`.
 */

const itemWrites: { id: string; patch: Record<string, unknown> }[] = [];

vi.mock('~/lib/tests/golden-set', () => ({
  listGoldenTests: vi.fn(async () => [{ id: 'test-1', name: 'Golden — dilution' }]),
}));

vi.mock('~/lib/observability/scheduled-test-repository', () => ({
  insertScheduledTestRun: vi.fn(async () => ({ id: 'sweep-1' })),
  insertScheduledTestItems: vi.fn(async ({ tests }: { tests: { id: string; name: string }[] }) =>
    tests.map((test) => ({
      id: `child-${test.id}`,
      scheduled_run_id: 'sweep-1',
      test_id: test.id,
      test_name: test.name,
      test_run_id: null,
      status: 'running',
    })),
  ),
  updateScheduledTestItem: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    itemWrites.push({ id, patch });
  }),
  closeScheduledRunAfterDispatch: vi.fn(async () => undefined),
}));

const { runGoldenTestSweep, DISPATCHED_PENDING_STATE } = await import(
  '~/lib/observability/run-golden-test-sweep'
);

const CONTEXT = { origin: 'https://bex.example.com', authorization: 'Bearer bex_test_token' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch whose execute call resolves only when the test says so. */
function stubFetch(options: { executeResolves: Promise<Response> }) {
  const calls: { url: string; method: string | undefined }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method });
    if (url.endsWith('/api/admin/tests/runs')) {
      return jsonResponse({ ok: true, runId: 'run-1' });
    }
    return options.executeResolves;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => {
  itemWrites.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runGoldenTestSweep — ledger timing (B0-989)', () => {
  it('writes test_run_id to the child before the execute call has returned', async () => {
    let releaseExecute: (response: Response) => void = () => {};
    const executeResolves = new Promise<Response>((resolve) => {
      releaseExecute = resolve;
    });
    const { fetchImpl } = stubFetch({ executeResolves });

    const sweep = runGoldenTestSweep({ dryRun: false }, CONTEXT, {
      fetchImpl,
      executeWaitMs: 60_000,
    });

    // Let the create call and the ledger write settle while execution is still pending.
    await vi.waitFor(() => {
      expect(itemWrites).toEqual([{ id: 'child-test-1', patch: { test_run_id: 'run-1' } }]);
    });

    releaseExecute(jsonResponse({ ok: true, state: 'started' }));
    const result = await sweep;

    expect(result.outcomes[0]).toMatchObject({ ok: true, runId: 'run-1', state: 'started' });
    // The post-execute write is the same link again, never a status change on success.
    expect(itemWrites).toEqual([
      { id: 'child-test-1', patch: { test_run_id: 'run-1' } },
      { id: 'child-test-1', patch: { test_run_id: 'run-1' } },
    ]);
  });

  it('stops waiting at executeWaitMs and reports the run as dispatched_pending with its id', async () => {
    // Never resolves: the run is still executing when the sweep gives up listening.
    const { fetchImpl, calls } = stubFetch({ executeResolves: new Promise<Response>(() => {}) });

    const result = await runGoldenTestSweep({ dryRun: false }, CONTEXT, {
      fetchImpl,
      executeWaitMs: 20,
    });

    expect(result.started).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.outcomes[0]).toEqual({
      testId: 'test-1',
      testName: 'Golden — dilution',
      ok: true,
      runId: 'run-1',
      state: DISPATCHED_PENDING_STATE,
      step: null,
      error: null,
    });
    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST']);
    expect(itemWrites.at(-1)).toEqual({ id: 'child-test-1', patch: { test_run_id: 'run-1' } });
  });

  it('does not create a run or touch the ledger on a dry run', async () => {
    const { fetchImpl, calls } = stubFetch({
      executeResolves: Promise.resolve(jsonResponse({ ok: true, state: 'started' })),
    });

    const result = await runGoldenTestSweep({ dryRun: true }, CONTEXT, { fetchImpl });

    expect(result.dryRun).toBe(true);
    expect(calls).toHaveLength(0);
    expect(itemWrites).toHaveLength(0);
  });
});
