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

const { runGoldenTestSweep, runGoldenTestSweepInputSchema, DISPATCHED_PENDING_STATE } =
  await import('~/lib/observability/run-golden-test-sweep');
const { insertScheduledTestRun } = await import('~/lib/observability/scheduled-test-repository');

const CONTEXT = { origin: 'https://bex.example.com', authorization: 'Bearer bex_test_token' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch whose execute call resolves only when the test says so. */
function stubFetch(options: { executeResolves: Promise<Response> }) {
  const calls: { url: string; method: string | undefined; body: string | undefined }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (url.endsWith('/api/admin/tests/runs')) {
      return jsonResponse({ ok: true, runId: 'run-1' });
    }
    return options.executeResolves;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => {
  itemWrites.length = 0;
  vi.mocked(insertScheduledTestRun).mockClear();
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

/**
 * B0-1119 — a sweep pass can force `modelTag` / `routerType` / `useValidator` onto every run. What
 * is pinned: an omitted override changes NOTHING on the wire or in the ledger, and a supplied one
 * lands in the create body, the ledger metadata, and the echoed result.
 */
describe('runGoldenTestSweep — per-sweep overrides (B0-1119)', () => {
  const started = () => Promise.resolve(jsonResponse({ ok: true, state: 'started' }));

  it('without overrides sends exactly { testId } and writes no overrides key to the ledger', async () => {
    const { fetchImpl, calls } = stubFetch({ executeResolves: started() });

    const result = await runGoldenTestSweep(
      runGoldenTestSweepInputSchema.parse({}),
      CONTEXT,
      { fetchImpl },
    );

    const createCall = calls.find((call) => call.url.endsWith('/api/admin/tests/runs'));
    expect(createCall?.body).toBe(JSON.stringify({ testId: 'test-1' }));
    expect(JSON.parse(createCall?.body ?? '{}')).toEqual({ testId: 'test-1' });

    expect(insertScheduledTestRun).toHaveBeenCalledTimes(1);
    const ledgerInput = vi.mocked(insertScheduledTestRun).mock.calls[0]?.[0];
    expect(ledgerInput?.metadata).toEqual({ origin: CONTEXT.origin });
    expect(ledgerInput?.metadata).not.toHaveProperty('overrides');

    expect(result).not.toHaveProperty('overrides');
  });

  it('forwards supplied overrides to every create body, the ledger metadata, and the result', async () => {
    const { fetchImpl, calls } = stubFetch({ executeResolves: started() });

    const result = await runGoldenTestSweep(
      runGoldenTestSweepInputSchema.parse({
        modelTagOverride: 'gpt-5.5',
        routerTypeOverride: 'llm',
        useValidatorOverride: true,
      }),
      CONTEXT,
      { fetchImpl },
    );

    const createCall = calls.find((call) => call.url.endsWith('/api/admin/tests/runs'));
    expect(JSON.parse(createCall?.body ?? '{}')).toEqual({
      testId: 'test-1',
      modelTag: 'gpt-5.5',
      routerType: 'llm',
      useValidator: true,
    });

    const expectedOverrides = { modelTag: 'gpt-5.5', routerType: 'llm', useValidator: true };
    expect(insertScheduledTestRun).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { origin: CONTEXT.origin, overrides: expectedOverrides },
      }),
    );
    expect(result.overrides).toEqual(expectedOverrides);
  });

  it('only includes the override keys that were supplied', async () => {
    const { fetchImpl, calls } = stubFetch({ executeResolves: started() });

    const result = await runGoldenTestSweep(
      runGoldenTestSweepInputSchema.parse({ useValidatorOverride: false }),
      CONTEXT,
      { fetchImpl },
    );

    const createCall = calls.find((call) => call.url.endsWith('/api/admin/tests/runs'));
    expect(JSON.parse(createCall?.body ?? '{}')).toEqual({ testId: 'test-1', useValidator: false });
    expect(result.overrides).toEqual({ useValidator: false });
  });
});

describe('runGoldenTestSweepInputSchema (B0-1119)', () => {
  it('accepts an empty body with every override undefined', () => {
    const parsed = runGoldenTestSweepInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ dryRun: false });
      expect(parsed.data.modelTagOverride).toBeUndefined();
      expect(parsed.data.routerTypeOverride).toBeUndefined();
      expect(parsed.data.useValidatorOverride).toBeUndefined();
    }
  });

  it('rejects an unknown modelTagOverride', () => {
    expect(
      runGoldenTestSweepInputSchema.safeParse({ modelTagOverride: 'not-a-real-model' }).success,
    ).toBe(false);
  });

  it('rejects an unknown routerTypeOverride', () => {
    expect(runGoldenTestSweepInputSchema.safeParse({ routerTypeOverride: 'random' }).success).toBe(
      false,
    );
  });

  it('rejects a non-boolean useValidatorOverride', () => {
    expect(runGoldenTestSweepInputSchema.safeParse({ useValidatorOverride: 'true' }).success).toBe(
      false,
    );
  });
});
