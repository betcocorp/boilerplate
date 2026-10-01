import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEST_RUN_STALE_AFTER_MS,
  RUNNER_STATE_STALLED_REQUEUED,
  buildRequeuedSummary,
  isRearmableQueuedRun,
  lastActivityIso,
  sweepStalledTestRuns,
  sweepStalledTestRunsInputSchema,
  sweepStalledTestRunsResultSchema,
  type StalledTestRunCandidate,
  type StalledTestRunSweeperPort,
} from '~/lib/observability/stalled-test-run-sweeper';

import type { Json } from '~/types/supabase.public';

/**
 * B0-990 — the eight runs stranded on 2026-09-14 all looked the same: `status = 'running'`, last
 * item written ~5 minutes after creation, then silence. What is pinned here is that such a run is
 * requeued with a compare-and-set and handed to the background continuation, that a run still
 * writing items is left alone, that a lost claim is reported rather than fought, and that a
 * `queued` run nobody ever started is never started by this sweep.
 */

const NOW_ISO = '2026-09-14T01:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const CONTEXT = { origin: 'https://bex.example.com', authorization: 'Bearer bex_test_token' };

function isoAgo(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function candidate(overrides: Partial<StalledTestRunCandidate> = {}): StalledTestRunCandidate {
  return {
    id: 'run-1',
    test_id: 'test-1',
    status: 'running',
    created_at: isoAgo(60 * 60 * 1000),
    started_at: isoAgo(60 * 60 * 1000),
    summary: {
      runner_state: 'running',
      running_since: isoAgo(60 * 60 * 1000),
      completed_items: 20,
      total_items: 26,
    },
    last_item_at: isoAgo(55 * 60 * 1000),
    ...overrides,
  };
}

type Recorded = {
  requeues: { id: string; summary: Json }[];
  requests: { url: string; headers: Record<string, string> }[];
};

function stub(options: {
  candidates?: StalledTestRunCandidate[];
  loseClaimFor?: Set<string>;
  respond?: (runId: string) => Response;
}) {
  const recorded: Recorded = { requeues: [], requests: [] };

  const port: StalledTestRunSweeperPort = {
    async listCandidates() {
      return options.candidates ?? [];
    },
    async requeueRunningRun(id, summary) {
      if (options.loseClaimFor?.has(id)) return false;
      recorded.requeues.push({ id, summary });
      return true;
    },
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    recorded.requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const runId = url.split('/runs/')[1] ?? '';
    if (options.respond) return options.respond(runId);
    return new Response(JSON.stringify({ ok: true, runId, state: 'scheduled', hop: 1 }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { port, fetchImpl, recorded };
}

const run = (
  options: Parameters<typeof stub>[0],
  input: Record<string, unknown> = {},
) => {
  const { port, fetchImpl, recorded } = stub(options);
  return sweepStalledTestRuns(sweepStalledTestRunsInputSchema.parse(input), CONTEXT, {
    port,
    fetchImpl,
    now: () => NOW_MS,
  }).then((result) => ({ result, recorded }));
};

describe('sweepStalledTestRunsInputSchema', () => {
  it('defaults to a 10-minute idle threshold and a small batch', () => {
    expect(sweepStalledTestRunsInputSchema.parse({})).toEqual({
      staleAfterMs: DEFAULT_TEST_RUN_STALE_AFTER_MS,
      limit: 20,
      dryRun: false,
    });
  });

  it('refuses a threshold that could requeue a run mid-item', () => {
    expect(sweepStalledTestRunsInputSchema.safeParse({ staleAfterMs: 60_000 }).success).toBe(false);
  });
});

describe('lastActivityIso', () => {
  it('prefers the newest item over the start stamps', () => {
    expect(lastActivityIso(candidate())).toBe(isoAgo(55 * 60 * 1000));
  });

  it('falls back to running_since when the run has no items yet', () => {
    const fresh = candidate({
      last_item_at: null,
      summary: { runner_state: 'running', running_since: isoAgo(2 * 60 * 1000) },
    });
    expect(lastActivityIso(fresh)).toBe(isoAgo(2 * 60 * 1000));
  });

  it('is null only when nothing parses', () => {
    expect(
      lastActivityIso(
        candidate({ last_item_at: 'garbage', summary: null, started_at: null, created_at: 'nope' }),
      ),
    ).toBeNull();
  });
});

describe('isRearmableQueuedRun / buildRequeuedSummary', () => {
  it('recognises a yielded or requeued run and not a never-started one', () => {
    expect(isRearmableQueuedRun(candidate({ status: 'queued', summary: { runner_state: 'yielded' } }))).toBe(true);
    expect(
      isRearmableQueuedRun(
        candidate({ status: 'queued', summary: { runner_state: RUNNER_STATE_STALLED_REQUEUED } }),
      ),
    ).toBe(true);
    expect(isRearmableQueuedRun(candidate({ status: 'queued', summary: { runner_state: 'queued' } }))).toBe(false);
    expect(isRearmableQueuedRun(candidate({ status: 'running' }))).toBe(false);
  });

  it('keeps the existing summary and stamps the requeue', () => {
    expect(buildRequeuedSummary({ completed_items: 20, running_since: 'x' }, NOW_ISO)).toEqual({
      completed_items: 20,
      runner_state: RUNNER_STATE_STALLED_REQUEUED,
      running_since: null,
      stalled_requeued_at: NOW_ISO,
    });
  });
});

describe('sweepStalledTestRuns', () => {
  it('requeues a stalled running run and fires the background continuation', async () => {
    const { result, recorded } = await run({ candidates: [candidate()] });

    expect(sweepStalledTestRunsResultSchema.parse(result)).toBeTruthy();
    expect(result.rearmed).toBe(1);
    expect(result.outcomes[0]).toMatchObject({
      runId: 'run-1',
      action: 'requeued_and_scheduled',
      stalledForMs: 55 * 60 * 1000,
    });
    expect(recorded.requeues).toHaveLength(1);
    expect(recorded.requeues[0]?.summary).toMatchObject({
      runner_state: RUNNER_STATE_STALLED_REQUEUED,
      completed_items: 20,
    });
    expect(recorded.requests).toHaveLength(1);
    expect(recorded.requests[0]?.url).toBe('https://bex.example.com/api/admin/tests/runs/run-1');
    expect(recorded.requests[0]?.headers).toMatchObject({
      Authorization: 'Bearer bex_test_token',
      'x-bex-run-mode': 'background',
      'x-bex-run-hop': '1',
    });
  });

  it('leaves a run alone while it is still writing items', async () => {
    const { result, recorded } = await run({
      candidates: [candidate({ last_item_at: isoAgo(30_000) })],
    });

    expect(result.outcomes[0]?.action).toBe('skipped_fresh');
    expect(recorded.requeues).toHaveLength(0);
    expect(recorded.requests).toHaveLength(0);
  });

  it('requires the idle age to strictly exceed the threshold', async () => {
    const exactly = await run({
      candidates: [candidate({ last_item_at: isoAgo(DEFAULT_TEST_RUN_STALE_AFTER_MS) })],
    });
    expect(exactly.result.outcomes[0]?.action).toBe('skipped_fresh');

    const over = await run({
      candidates: [candidate({ last_item_at: isoAgo(DEFAULT_TEST_RUN_STALE_AFTER_MS + 1) })],
    });
    expect(over.result.outcomes[0]?.action).toBe('requeued_and_scheduled');
  });

  it('reports a lost compare-and-set instead of firing anything', async () => {
    const { result, recorded } = await run({
      candidates: [candidate()],
      loseClaimFor: new Set(['run-1']),
    });

    expect(result.outcomes[0]?.action).toBe('skipped_claim_lost');
    expect(recorded.requests).toHaveLength(0);
  });

  it('re-arms a queued run whose continuation hop was lost, without a requeue write', async () => {
    const { result, recorded } = await run({
      candidates: [
        candidate({
          status: 'queued',
          summary: { runner_state: 'yielded', yielded_at: isoAgo(20 * 60 * 1000) },
          last_item_at: isoAgo(21 * 60 * 1000),
        }),
      ],
    });

    expect(result.outcomes[0]?.action).toBe('scheduled');
    expect(recorded.requeues).toHaveLength(0);
    expect(recorded.requests).toHaveLength(1);
  });

  it('never starts a queued run that was never started by anyone', async () => {
    const { result, recorded } = await run({
      candidates: [
        candidate({
          status: 'queued',
          summary: { runner_state: 'queued' },
          last_item_at: null,
          started_at: isoAgo(3 * 60 * 60 * 1000),
          created_at: isoAgo(3 * 60 * 60 * 1000),
        }),
      ],
    });

    expect(result.outcomes[0]?.action).toBe('skipped_fresh');
    expect(recorded.requests).toHaveLength(0);
  });

  it('records a refused continuation as schedule_failed', async () => {
    const { result } = await run({
      candidates: [candidate()],
      respond: () =>
        new Response(JSON.stringify({ code: '401', message: 'Protected deployment' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    expect(result.failed).toBe(1);
    expect(result.outcomes[0]).toMatchObject({ action: 'schedule_failed' });
    expect(result.outcomes[0]?.error).toContain('VERCEL_AUTOMATION_BYPASS_SECRET');
  });

  it('treats a 200 already_running as not re-armed', async () => {
    const { result } = await run({
      candidates: [candidate()],
      respond: () =>
        new Response(JSON.stringify({ ok: true, state: 'already_running', hop: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    expect(result.outcomes[0]).toMatchObject({ action: 'schedule_failed', error: 'already_running' });
  });

  it('writes and fires nothing on a dry run', async () => {
    const { result, recorded } = await run({ candidates: [candidate()] }, { dryRun: true });

    expect(result.outcomes[0]?.action).toBe('would_rearm');
    expect(result.rearmed).toBe(1);
    expect(recorded.requeues).toHaveLength(0);
    expect(recorded.requests).toHaveLength(0);
  });
});
