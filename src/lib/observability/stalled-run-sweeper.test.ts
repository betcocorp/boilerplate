import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STALE_AFTER_MS,
  ORPHANED_SWEEP_ERROR,
  ORPHANED_SWEEP_MARKER,
  buildOrphanedRunFinalOutput,
  buildOrphanedStepError,
  isStalled,
  staleCutoffIso,
  stalledForMs,
  sweepStalledRuns,
  sweepStalledRunsInputSchema,
  sweepStalledRunsResultSchema,
  type StalledRunCandidate,
  type StalledRunSweeperPort,
  type StalledStepCandidate,
} from '~/lib/observability/stalled-run-sweeper';

const NOW_ISO = '2026-08-04T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

function isoAgo(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function runCandidate(overrides: Partial<StalledRunCandidate> = {}): StalledRunCandidate {
  return {
    id: 'run-stale',
    conversation_id: 'conv-1',
    created_at: isoAgo(6 * 60 * 60 * 1000),
    final_output: null,
    ...overrides,
  };
}

function stepCandidate(overrides: Partial<StalledStepCandidate> = {}): StalledStepCandidate {
  return {
    id: 'step-stale',
    workflow_run_id: 'run-stale',
    step_name: 'openai_responses_agent',
    started_at: isoAgo(6 * 60 * 60 * 1000),
    error: null,
    ...overrides,
  };
}

type Recorded = {
  runUpdates: { id: string; finalOutput: unknown; updatedAtIso: string }[];
  stepUpdates: { id: string; error: unknown }[];
  audits: { runId: string; conversationId: string | null; payload: Record<string, unknown> }[];
  runQueries: { cutoffIso: string; limit: number }[];
  stepQueries: { cutoffIso: string; limit: number }[];
};

function stubPort(options: {
  runs?: StalledRunCandidate[];
  steps?: StalledStepCandidate[];
  failRunIds?: Set<string>;
  failStepIds?: Set<string>;
  failAuditRunIds?: Set<string>;
}): { port: StalledRunSweeperPort; recorded: Recorded } {
  const recorded: Recorded = {
    runUpdates: [],
    stepUpdates: [],
    audits: [],
    runQueries: [],
    stepQueries: [],
  };

  const port: StalledRunSweeperPort = {
    async listStalledRunCandidates(cutoffIso, limit) {
      recorded.runQueries.push({ cutoffIso, limit });
      return options.runs ?? [];
    },
    async listStalledStepCandidates(cutoffIso, limit) {
      recorded.stepQueries.push({ cutoffIso, limit });
      return options.steps ?? [];
    },
    async markRunOrphaned(input) {
      if (options.failRunIds?.has(input.id)) {
        throw new Error(`write rejected for ${input.id}`);
      }
      recorded.runUpdates.push(input);
    },
    async markStepOrphaned(input) {
      if (options.failStepIds?.has(input.id)) {
        throw new Error(`write rejected for ${input.id}`);
      }
      recorded.stepUpdates.push(input);
    },
    async recordSweepAudit(input) {
      if (options.failAuditRunIds?.has(input.runId)) {
        throw new Error(`audit rejected for ${input.runId}`);
      }
      recorded.audits.push(input);
    },
  };

  return { port, recorded };
}

const clock = { now: () => NOW_MS };

describe('stalledForMs (clock-skew clamp)', () => {
  it('clamps a negative age to 0 instead of dropping the row', () => {
    // `started_at` is Postgres now(); the caller's clock is the Node clock. A row
    // created moments ago can legitimately look 13s in the future.
    expect(stalledForMs(isoAgo(-13_476), NOW_MS)).toBe(0);
    expect(stalledForMs(isoAgo(-1), NOW_MS)).toBe(0);
  });

  it('returns the real age for a row in the past', () => {
    expect(stalledForMs(isoAgo(90_000), NOW_MS)).toBe(90_000);
  });

  it('returns null (undecidable) for an unparseable timestamp', () => {
    expect(stalledForMs('not-a-timestamp', NOW_MS)).toBeNull();
  });

  it('never reports a clock-skewed row as stalled', () => {
    expect(isStalled(isoAgo(-13_476), NOW_MS, DEFAULT_STALE_AFTER_MS)).toBe(false);
  });

  it('requires the age to strictly exceed the threshold', () => {
    expect(isStalled(isoAgo(DEFAULT_STALE_AFTER_MS), NOW_MS, DEFAULT_STALE_AFTER_MS)).toBe(false);
    expect(isStalled(isoAgo(DEFAULT_STALE_AFTER_MS + 1), NOW_MS, DEFAULT_STALE_AFTER_MS)).toBe(
      true,
    );
  });
});

describe('staleCutoffIso', () => {
  it('is the threshold before now', () => {
    expect(staleCutoffIso(NOW_MS, DEFAULT_STALE_AFTER_MS)).toBe('2026-08-04T10:00:00.000Z');
  });
});

describe('sweepStalledRunsInputSchema', () => {
  it('defaults to the measured 2-hour threshold', () => {
    const parsed = sweepStalledRunsInputSchema.parse({});
    expect(parsed.staleAfterMs).toBe(DEFAULT_STALE_AFTER_MS);
    expect(parsed.staleAfterMs).toBe(7_200_000);
    expect(parsed.dryRun).toBe(false);
  });

  it('rejects a threshold short enough to race live traffic', () => {
    expect(sweepStalledRunsInputSchema.safeParse({ staleAfterMs: 1000 }).success).toBe(false);
  });
});

describe('sweepStalledRuns', () => {
  it('sweeps a stale running run with the distinct orphaned error', async () => {
    const { port, recorded } = stubPort({ runs: [runCandidate()] });

    const result = await sweepStalledRuns({ port, now: clock.now });

    expect(sweepStalledRunsResultSchema.safeParse(result).success).toBe(true);
    expect(result.runs.swept).toBe(1);
    expect(result.runs.ids).toEqual(['run-stale']);
    expect(result.runs.skipped).toBe(0);
    expect(result.error).toBe(ORPHANED_SWEEP_ERROR);

    expect(recorded.runUpdates).toHaveLength(1);
    expect(recorded.runUpdates[0]?.finalOutput).toMatchObject({
      error: 'orphaned_no_terminal_row',
      sweptBy: ORPHANED_SWEEP_MARKER,
      stalledForMs: 6 * 60 * 60 * 1000,
    });
    expect(recorded.runUpdates[0]?.updatedAtIso).toBe(NOW_ISO);
  });

  it('writes the terminal audit row process death never wrote', async () => {
    const { port, recorded } = stubPort({ runs: [runCandidate()] });

    await sweepStalledRuns({ port, now: clock.now });

    expect(recorded.audits).toHaveLength(1);
    expect(recorded.audits[0]).toMatchObject({
      runId: 'run-stale',
      conversationId: 'conv-1',
      payload: { reason: ORPHANED_SWEEP_ERROR, swept_by: ORPHANED_SWEEP_MARKER },
    });
  });

  it('does NOT touch an actively running run with a recent started_at', async () => {
    const { port, recorded } = stubPort({
      // Well inside the threshold — and inside the slowest run ever observed (1h43m).
      runs: [runCandidate({ id: 'run-inflight', created_at: isoAgo(90 * 60 * 1000) })],
      steps: [stepCandidate({ id: 'step-inflight', started_at: isoAgo(90 * 60 * 1000) })],
    });

    const result = await sweepStalledRuns({ port, now: clock.now });

    expect(result.runs.swept).toBe(0);
    expect(result.runs.skipped).toBe(1);
    expect(result.steps.swept).toBe(0);
    expect(result.steps.skipped).toBe(1);
    expect(recorded.runUpdates).toEqual([]);
    expect(recorded.stepUpdates).toEqual([]);
    expect(recorded.audits).toEqual([]);
  });

  it('does NOT sweep a clock-skewed row whose raw age is negative', async () => {
    const { port, recorded } = stubPort({
      runs: [runCandidate({ id: 'run-skewed', created_at: isoAgo(-13_476) })],
      steps: [stepCandidate({ id: 'step-skewed', started_at: isoAgo(-13_476) })],
    });

    const result = await sweepStalledRuns({ port, now: clock.now });

    expect(result.runs.swept).toBe(0);
    expect(result.steps.swept).toBe(0);
    expect(recorded.runUpdates).toEqual([]);
    expect(recorded.stepUpdates).toEqual([]);
  });

  it('sweeps orphaned STEPS independently of the run, and before the run', async () => {
    const { port, recorded } = stubPort({
      // Mirrors the live shape: 17 `openai_responses_agent` + 2 `validator` stalls,
      // one of which hangs off a run that already reached a terminal state.
      steps: [
        stepCandidate({ id: 'step-agent' }),
        stepCandidate({
          id: 'step-validator-on-failed-run',
          step_name: 'validator',
          workflow_run_id: 'run-already-failed',
        }),
      ],
      runs: [runCandidate()],
    });

    const result = await sweepStalledRuns({ port, now: clock.now });

    expect(result.steps.swept).toBe(2);
    expect(result.steps.ids).toEqual(['step-agent', 'step-validator-on-failed-run']);
    expect(recorded.stepUpdates[1]?.error).toMatchObject({
      error: ORPHANED_SWEEP_ERROR,
      message: ORPHANED_SWEEP_ERROR,
      stepName: 'validator',
    });
    // Steps are swept first so the run's `not_reached` projection has an anchor.
    expect(recorded.stepUpdates).toHaveLength(2);
    expect(result.runs.swept).toBe(1);
  });

  it('leaves rows alone in dryRun but still reports them', async () => {
    const { port, recorded } = stubPort({
      runs: [runCandidate()],
      steps: [stepCandidate()],
    });

    const result = await sweepStalledRuns({ port, now: clock.now }, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.runs.swept).toBe(1);
    expect(result.steps.swept).toBe(1);
    expect(recorded.runUpdates).toEqual([]);
    expect(recorded.stepUpdates).toEqual([]);
    expect(recorded.audits).toEqual([]);
  });

  it('skips a candidate with an unusable timestamp rather than sweeping it', async () => {
    const { port, recorded } = stubPort({
      runs: [runCandidate({ id: 'run-bad-ts', created_at: 'not-a-timestamp' })],
    });

    const result = await sweepStalledRuns({ port, now: clock.now });

    expect(result.runs.swept).toBe(0);
    expect(result.runs.skipped).toBe(1);
    expect(recorded.runUpdates).toEqual([]);
  });

  it('keeps sweeping after a per-row write failure and counts it', async () => {
    const { port, recorded } = stubPort({
      runs: [runCandidate({ id: 'run-a' }), runCandidate({ id: 'run-b' })],
      failRunIds: new Set(['run-a']),
    });

    const result = await sweepStalledRuns({ port, now: clock.now });

    expect(result.runs.failed).toBe(1);
    expect(result.runs.swept).toBe(1);
    expect(result.runs.ids).toEqual(['run-b']);
    // The failed run got no audit row, so it is still visibly unreconciled.
    expect(recorded.audits.map((entry) => entry.runId)).toEqual(['run-b']);
  });

  it('keeps the run swept even when the audit write fails', async () => {
    const { port, recorded } = stubPort({
      runs: [runCandidate()],
      failAuditRunIds: new Set(['run-stale']),
    });

    const result = await sweepStalledRuns({ port, now: clock.now });

    expect(result.runs.swept).toBe(1);
    expect(recorded.runUpdates).toHaveLength(1);
    expect(recorded.audits).toEqual([]);
  });

  it('queries both tables with the same clamped cutoff and limit', async () => {
    const { port, recorded } = stubPort({});

    await sweepStalledRuns({ port, now: clock.now }, { limit: 25 });

    expect(recorded.runQueries).toEqual([{ cutoffIso: '2026-08-04T10:00:00.000Z', limit: 25 }]);
    expect(recorded.stepQueries).toEqual([{ cutoffIso: '2026-08-04T10:00:00.000Z', limit: 25 }]);
  });
});

describe('marker payloads', () => {
  it('never collides with a handled workflow failure message', () => {
    // Handled failures write the caught exception text, e.g. "TypeError: fetch failed".
    const handled = { error: 'TypeError: fetch failed' };
    const swept = buildOrphanedRunFinalOutput(null, { sweptAt: NOW_ISO, stalledForMs: 1 });

    expect(handled.error).not.toBe(ORPHANED_SWEEP_ERROR);
    expect(swept).toMatchObject({ error: ORPHANED_SWEEP_ERROR, sweptBy: ORPHANED_SWEEP_MARKER });
  });

  it('preserves any pre-existing payload instead of clobbering it', () => {
    const runOutput = buildOrphanedRunFinalOutput(
      { routingDecision: 'product' },
      { sweptAt: NOW_ISO, stalledForMs: 5 },
    );
    expect(runOutput).toMatchObject({
      routingDecision: 'product',
      error: ORPHANED_SWEEP_ERROR,
    });

    const stepError = buildOrphanedStepError(
      { partial: true },
      { sweptAt: NOW_ISO, stalledForMs: 5, stepName: 'validator' },
    );
    expect(stepError).toMatchObject({ partial: true, error: ORPHANED_SWEEP_ERROR });
  });

  it('tolerates a non-object payload on the row', () => {
    expect(
      buildOrphanedRunFinalOutput('legacy string', { sweptAt: NOW_ISO, stalledForMs: 5 }),
    ).toEqual({
      error: ORPHANED_SWEEP_ERROR,
      sweptBy: ORPHANED_SWEEP_MARKER,
      sweptAt: NOW_ISO,
      stalledForMs: 5,
    });
  });
});
