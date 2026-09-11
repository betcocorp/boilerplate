import { describe, expect, it } from 'vitest';

import {
  sweepPendingReports,
  sweepPendingReportsInputSchema,
  sweepPendingReportsResultSchema,
  type SweepPendingReportsContext,
} from '~/lib/observability/pending-report-sweeper';

import type {
  ListPendingReportCandidatesOptions,
  PendingReportCandidate,
  PendingReportSweeperPort,
} from '~/lib/observability/pending-report-repository';

const CONTEXT: SweepPendingReportsContext = {
  origin: 'https://bex.example.com',
  authorization: 'Bearer bex_test_token',
};

function candidate(overrides: Partial<PendingReportCandidate> = {}): PendingReportCandidate {
  return {
    runId: 'run-1',
    testId: 'test-1',
    completedAt: '2026-09-10T12:00:00.000Z',
    reportStatus: 'scoring',
    completedCases: 12,
    totalCases: 40,
    updatedAt: '2026-09-10T12:05:00.000Z',
    ...overrides,
  };
}

type Recorded = {
  queries: ListPendingReportCandidatesOptions[];
  requests: { url: string; init: RequestInit | undefined }[];
};

function stub(options: {
  candidates?: PendingReportCandidate[];
  failRunIds?: Set<string>;
  throwRunIds?: Set<string>;
}): {
  port: PendingReportSweeperPort;
  fetchImpl: typeof fetch;
  recorded: Recorded;
} {
  const recorded: Recorded = { queries: [], requests: [] };

  const port: PendingReportSweeperPort = {
    async listPendingReportCandidates(query) {
      recorded.queries.push(query);
      return options.candidates ?? [];
    },
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    recorded.requests.push({ url, init });

    const runId = url.split('/runs/')[1]?.split('/')[0] ?? '';

    if (options.throwRunIds?.has(runId)) {
      throw new Error(`socket hang up for ${runId}`);
    }
    if (options.failRunIds?.has(runId)) {
      return new Response(JSON.stringify({ error: 'run is not completed' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({ ok: true, runId, state: 'scheduled', hop: 1 }),
      { status: 202, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  return { port, fetchImpl, recorded };
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

describe('sweepPendingReportsInputSchema', () => {
  it('defaults to the safety-net cadence settings', () => {
    const parsed = sweepPendingReportsInputSchema.parse({});
    expect(parsed).toEqual({
      dryRun: false,
      limit: 10,
      lookbackHours: 72,
      stalenessMinutes: 10,
    });
  });

  it('rejects a non-positive limit and an out-of-range lookback', () => {
    expect(sweepPendingReportsInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(sweepPendingReportsInputSchema.safeParse({ lookbackHours: 0 }).success).toBe(false);
    expect(sweepPendingReportsInputSchema.safeParse({ stalenessMinutes: 0 }).success).toBe(false);
  });
});

describe('sweepPendingReports', () => {
  it('forwards the parsed window to the reader', async () => {
    const { port, fetchImpl, recorded } = stub({});

    await sweepPendingReports(
      sweepPendingReportsInputSchema.parse({ limit: 5, lookbackHours: 12, stalenessMinutes: 3 }),
      CONTEXT,
      { port, fetchImpl },
    );

    expect(recorded.queries).toEqual([
      { limit: 5, lookbackHours: 12, stalenessMinutes: 3 },
    ]);
  });

  it('fires exactly one background POST per candidate with the hop headers', async () => {
    const { port, fetchImpl, recorded } = stub({
      candidates: [
        candidate({ runId: 'run-a' }),
        candidate({ runId: 'run-b', reportStatus: 'synthesizing' }),
        candidate({ runId: 'run-c', reportStatus: null, completedCases: null, totalCases: null }),
      ],
    });

    const result = await sweepPendingReports(
      sweepPendingReportsInputSchema.parse({}),
      CONTEXT,
      { port, fetchImpl },
    );

    expect(sweepPendingReportsResultSchema.safeParse(result).success).toBe(true);
    expect(result.candidateCount).toBe(3);
    expect(result.scheduled).toBe(3);
    expect(result.failed).toBe(0);

    expect(recorded.requests.map((request) => request.url)).toEqual([
      'https://bex.example.com/api/admin/tests/runs/run-a/report',
      'https://bex.example.com/api/admin/tests/runs/run-b/report',
      'https://bex.example.com/api/admin/tests/runs/run-c/report',
    ]);

    for (const request of recorded.requests) {
      expect(request.init?.method).toBe('POST');
      expect(headerOf(request.init, 'Authorization')).toBe('Bearer bex_test_token');
      expect(headerOf(request.init, 'x-bex-report-mode')).toBe('background');
      expect(headerOf(request.init, 'x-bex-report-hop')).toBe('1');
    }
  });

  it('carries the candidate context through into each outcome', async () => {
    const { port, fetchImpl } = stub({ candidates: [candidate()] });

    const result = await sweepPendingReports(
      sweepPendingReportsInputSchema.parse({}),
      CONTEXT,
      { port, fetchImpl },
    );

    expect(result.outcomes[0]).toEqual({
      runId: 'run-1',
      testId: 'test-1',
      ok: true,
      reportStatus: 'scoring',
      completedCases: 12,
      totalCases: 40,
      error: null,
    });
  });

  it('fires nothing on a dry run but still reports the candidates', async () => {
    const { port, fetchImpl, recorded } = stub({
      candidates: [candidate({ runId: 'run-a' }), candidate({ runId: 'run-b' })],
    });

    const result = await sweepPendingReports(
      sweepPendingReportsInputSchema.parse({ dryRun: true }),
      CONTEXT,
      { port, fetchImpl },
    );

    expect(result.dryRun).toBe(true);
    expect(result.candidateCount).toBe(2);
    expect(result.scheduled).toBe(0);
    expect(result.outcomes.map((outcome) => outcome.runId)).toEqual(['run-a', 'run-b']);
    expect(recorded.requests).toEqual([]);
  });

  it('records a non-2xx on one run without aborting the rest', async () => {
    const { port, fetchImpl, recorded } = stub({
      candidates: [
        candidate({ runId: 'run-a' }),
        candidate({ runId: 'run-bad' }),
        candidate({ runId: 'run-c' }),
      ],
      failRunIds: new Set(['run-bad']),
    });

    const result = await sweepPendingReports(
      sweepPendingReportsInputSchema.parse({}),
      CONTEXT,
      { port, fetchImpl },
    );

    expect(recorded.requests).toHaveLength(3);
    expect(result.scheduled).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.outcomes.find((outcome) => outcome.runId === 'run-bad')).toMatchObject({
      ok: false,
      error: 'run is not completed',
    });
  });

  it('records a network throw on one run without aborting the rest', async () => {
    const { port, fetchImpl, recorded } = stub({
      candidates: [candidate({ runId: 'run-a' }), candidate({ runId: 'run-dead' })],
      throwRunIds: new Set(['run-dead']),
    });

    const result = await sweepPendingReports(
      sweepPendingReportsInputSchema.parse({}),
      CONTEXT,
      { port, fetchImpl },
    );

    expect(recorded.requests).toHaveLength(2);
    expect(result.scheduled).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.outcomes.find((outcome) => outcome.runId === 'run-dead')).toMatchObject({
      ok: false,
      error: 'socket hang up for run-dead',
    });
  });

  it('is a no-op when the reader finds nothing', async () => {
    const { port, fetchImpl, recorded } = stub({ candidates: [] });

    const result = await sweepPendingReports(
      sweepPendingReportsInputSchema.parse({}),
      CONTEXT,
      { port, fetchImpl },
    );

    expect(result).toEqual({
      dryRun: false,
      candidateCount: 0,
      scheduled: 0,
      failed: 0,
      outcomes: [],
    });
    expect(recorded.requests).toEqual([]);
  });
});
