/**
 * B0-990 — recovery sweep for eval test runs whose executing invocation died.
 *
 * ## The problem this exists for
 * `executeTestRun` runs inside `POST /api/admin/tests/runs/[runId]` under a 300 s `maxDuration`.
 * When the platform kills that invocation mid-loop, `test_results.status` stays `running` for ever:
 * `stalled-run-sweeper.ts` only reconciles `workflow_runs` / `workflow_steps`, and the `restart`
 * PATCH action refuses any run that already has items. On 2026-09-14 there were 8 such rows, every
 * one with its last `test_result_items` row written ~5:00 after creation.
 *
 * ## What it does
 * A `running` run whose last sign of life (newest item, or `running_since` when it has none) is
 * older than `staleAfterMs` is put back to `queued` with a compare-and-set on `status` and then
 * handed to the same background continuation the executor's own yield uses
 * (`POST …/runs/[runId]` with `x-bex-run-mode: background`). The executor skips items that already
 * have a row, so nothing is repeated. A run already `queued` by a yield whose continuation hop was
 * lost (`runner_state` `yielded` / `stalled_requeued`) is re-armed the same way without the CAS.
 *
 * ## Why this cannot double-execute
 * The claim is the executor's own `queued` → `running` compare-and-set. Two sweeps, or a sweep and
 * a human's click, racing for one run can both requeue it but only one claim wins; the loser's
 * POST answers `already_running` and is recorded as such.
 *
 * ## Purity / testability
 * Data access, clock and fetch are injected `deps`, like every sweeper in this directory, so the
 * decision surface is unit-testable with no database and no network
 * (`stalled-test-run-sweeper.test.ts`). Supabase wiring lives in `stalled-test-run-repository.ts`.
 */

import { z } from 'zod';

import {
  describeDeploymentProtectionFailure,
  resolveDeploymentProtectionBypass,
} from '~/lib/api/deployment-protection-bypass';
import { stalledForMs } from '~/lib/observability/stalled-run-sweeper';
import {
  RUN_BACKGROUND_MODE,
  RUN_HOP_HEADER,
  RUN_MODE_HEADER,
} from '~/lib/tests/schedule-run-continuation';

import type { Json } from '~/types/supabase.public';

/**
 * Staleness threshold: 10 minutes with no item written. Items land every 15–20 s while a run is
 * alive, and a single item has never legitimately taken 10 minutes; a killed invocation, by
 * contrast, writes nothing again. Deliberately far shorter than the 2 h the workflow sweeper uses —
 * that one is derived from workflow-step durations, this one from the cadence of item writes.
 */
export const DEFAULT_TEST_RUN_STALE_AFTER_MS = 10 * 60 * 1000;

/** Lower bound accepted from a caller; below this the sweep could requeue a run mid-item. */
export const MIN_TEST_RUN_STALE_AFTER_MS = 5 * 60 * 1000;

export const DEFAULT_TEST_RUN_SWEEP_LIMIT = 20;
export const MAX_TEST_RUN_SWEEP_LIMIT = 100;

/** `summary.runner_state` written when this sweep requeues a run. */
export const RUNNER_STATE_STALLED_REQUEUED = 'stalled_requeued';

/** `queued` runs in these runner states are dropped continuations, not never-started runs. */
export const REARMABLE_QUEUED_RUNNER_STATES = ['yielded', RUNNER_STATE_STALLED_REQUEUED] as const;

/* -------------------------------------------------------------------------- *
 * Contracts (Zod first, per AGENTS.md)
 * -------------------------------------------------------------------------- */

export const sweepStalledTestRunsInputSchema = z.object({
  /** How long a run may go without progress before it is requeued. */
  staleAfterMs: z
    .number()
    .int()
    .min(MIN_TEST_RUN_STALE_AFTER_MS)
    .default(DEFAULT_TEST_RUN_STALE_AFTER_MS),
  /** Max candidate runs examined per invocation; the next sweep picks up the rest. */
  limit: z.number().int().min(1).max(MAX_TEST_RUN_SWEEP_LIMIT).default(DEFAULT_TEST_RUN_SWEEP_LIMIT),
  /** Report what would be re-armed without writing or firing anything. */
  dryRun: z.boolean().default(false),
});

export type SweepStalledTestRunsInput = z.input<typeof sweepStalledTestRunsInputSchema>;
export type SweepStalledTestRunsOptions = z.output<typeof sweepStalledTestRunsInputSchema>;

export const stalledTestRunActionSchema = z.enum([
  /** `running` and stale: requeued, continuation accepted (202). */
  'requeued_and_scheduled',
  /** Already `queued` by a yield/requeue and stale: continuation accepted (202). */
  'scheduled',
  /** Not stale yet — something wrote to it recently. */
  'skipped_fresh',
  /** Stale, but the status compare-and-set lost: someone else moved it first. */
  'skipped_claim_lost',
  /** Stale, requeued (or already queued), but the continuation POST was refused or failed. */
  'schedule_failed',
  /** Dry run: would have been re-armed. */
  'would_rearm',
]);
export type StalledTestRunAction = z.infer<typeof stalledTestRunActionSchema>;

export const stalledTestRunOutcomeSchema = z.object({
  runId: z.string(),
  testId: z.string(),
  status: z.string(),
  lastActivityAt: z.string().nullable(),
  stalledForMs: z.number().int().nonnegative().nullable(),
  action: stalledTestRunActionSchema,
  error: z.string().nullable(),
});
export type StalledTestRunOutcome = z.infer<typeof stalledTestRunOutcomeSchema>;

export const sweepStalledTestRunsResultSchema = z.object({
  sweptAt: z.string(),
  staleAfterMs: z.number().int().nonnegative(),
  dryRun: z.boolean(),
  candidateCount: z.number().int().nonnegative(),
  rearmed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  outcomes: z.array(stalledTestRunOutcomeSchema),
});
export type SweepStalledTestRunsResult = z.infer<typeof sweepStalledTestRunsResultSchema>;

/* -------------------------------------------------------------------------- *
 * Data-access port
 * -------------------------------------------------------------------------- */

/** Minimal projection of a `test_results` row plus the newest item timestamp it owns. */
export type StalledTestRunCandidate = {
  id: string;
  test_id: string;
  status: string;
  created_at: string;
  started_at: string | null;
  summary: Json | null;
  /** `max(test_result_items.created_at)` for this run, or null when it has none yet. */
  last_item_at: string | null;
};

export type StalledTestRunSweeperPort = {
  /**
   * Chat-mode runs (`run_mode` in `CHAT_RUN_MODES`, i.e. `full` or `partial` — B0-1110) that are
   * `running`, plus `queued` runs whose `runner_state` is in
   * {@link REARMABLE_QUEUED_RUNNER_STATES}, oldest first.
   */
  listCandidates(limit: number): Promise<StalledTestRunCandidate[]>;
  /**
   * `running` → `queued` with the given summary, compare-and-set on `status = 'running'`. Returns
   * whether the row was moved.
   */
  requeueRunningRun(id: string, summary: Json): Promise<boolean>;
};

export type SweepStalledTestRunsContext = {
  origin: string;
  authorization: string;
};

export type SweepStalledTestRunsDeps = {
  port: StalledTestRunSweeperPort;
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: (event: string, fields: Record<string, unknown>) => void;
};

/* -------------------------------------------------------------------------- *
 * Pure decisions
 * -------------------------------------------------------------------------- */

function asSummaryObject(value: Json | null): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readIso(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * The newest evidence that something was executing this run: the latest item, else the latest
 * (re)start stamp, else the row's own timestamps. Null only when nothing parses at all — a "cannot
 * decide", which the sweep treats as "leave it alone".
 */
export function lastActivityIso(candidate: StalledTestRunCandidate): string | null {
  const summary = asSummaryObject(candidate.summary);
  const stamps = [
    candidate.last_item_at,
    summary.running_since,
    summary.yielded_at,
    summary.stalled_requeued_at,
    candidate.started_at,
    candidate.created_at,
  ]
    .map(readIso)
    .filter((value): value is string => value !== null)
    .map((value) => Date.parse(value));

  if (stamps.length === 0) return null;
  return new Date(Math.max(...stamps)).toISOString();
}

/** True for a `queued` row that a yield or an earlier sweep left behind, as opposed to one never started. */
export function isRearmableQueuedRun(candidate: StalledTestRunCandidate): boolean {
  if (candidate.status !== 'queued') return false;
  const runnerState = asSummaryObject(candidate.summary).runner_state;
  return (
    typeof runnerState === 'string' &&
    (REARMABLE_QUEUED_RUNNER_STATES as readonly string[]).includes(runnerState)
  );
}

/** The summary written when this sweep requeues a `running` run. */
export function buildRequeuedSummary(existing: Json | null, requeuedAtIso: string): Json {
  return {
    ...asSummaryObject(existing),
    runner_state: RUNNER_STATE_STALLED_REQUEUED,
    running_since: null,
    stalled_requeued_at: requeuedAtIso,
  } as Json;
}

/* -------------------------------------------------------------------------- *
 * The sweep
 * -------------------------------------------------------------------------- */

const RUN_PATH = (runId: string) => `/api/admin/tests/runs/${runId}`;

async function fireContinuation(
  runId: string,
  context: SweepStalledTestRunsContext,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; error: string | null }> {
  // B0-966 — a self-call into our own deployment must clear Deployment Protection on its own.
  const bypass = resolveDeploymentProtectionBypass(context.origin);

  let response: Response;
  try {
    response = await fetchImpl(`${context.origin}${RUN_PATH(runId)}`, {
      method: 'POST',
      headers: {
        Authorization: context.authorization,
        [RUN_MODE_HEADER]: RUN_BACKGROUND_MODE,
        [RUN_HOP_HEADER]: '1',
        ...bypass.headers,
      },
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Network error scheduling continuation',
    };
  }

  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; state?: string; error?: string }
    | null;

  if (!response.ok) {
    return {
      ok: false,
      error: `${body?.error ?? `HTTP ${response.status}`}${describeDeploymentProtectionFailure(response.status, bypass)}`,
    };
  }

  // 200 with a non-claimed state means the claim was lost after our requeue — not a failure of the
  // sweep, but the run is not ours to report as re-armed either.
  if (response.status !== 202) {
    return { ok: false, error: body?.state ?? `HTTP ${response.status}` };
  }

  return { ok: true, error: null };
}

export async function sweepStalledTestRuns(
  options: SweepStalledTestRunsOptions,
  context: SweepStalledTestRunsContext,
  deps: SweepStalledTestRunsDeps,
): Promise<SweepStalledTestRunsResult> {
  const nowMs = (deps.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log;

  const candidates = await deps.port.listCandidates(options.limit);

  const outcomes: StalledTestRunOutcome[] = [];

  for (const candidate of candidates) {
    const lastActivityAt = lastActivityIso(candidate);
    const age = lastActivityAt === null ? null : stalledForMs(lastActivityAt, nowMs);
    const base = {
      runId: candidate.id,
      testId: candidate.test_id,
      status: candidate.status,
      lastActivityAt,
      stalledForMs: age,
    };

    if (age === null || age <= options.staleAfterMs) {
      outcomes.push({ ...base, action: 'skipped_fresh', error: null });
      continue;
    }

    if (options.dryRun) {
      outcomes.push({ ...base, action: 'would_rearm', error: null });
      continue;
    }

    let requeued = false;
    if (candidate.status === 'running') {
      const moved = await deps.port.requeueRunningRun(
        candidate.id,
        buildRequeuedSummary(candidate.summary, nowIso),
      );
      if (!moved) {
        outcomes.push({ ...base, action: 'skipped_claim_lost', error: null });
        continue;
      }
      requeued = true;
    } else if (!isRearmableQueuedRun(candidate)) {
      // A `queued` run that was never started is somebody's unexecuted create; not ours to start.
      outcomes.push({ ...base, action: 'skipped_fresh', error: null });
      continue;
    }

    const fired = await fireContinuation(candidate.id, context, fetchImpl);
    if (!fired.ok) {
      log?.('stalled_test_run_schedule_failed', {
        test_result_id: candidate.id,
        requeued,
        error: fired.error,
      });
      outcomes.push({ ...base, action: 'schedule_failed', error: fired.error });
      continue;
    }

    log?.('stalled_test_run_rearmed', {
      test_result_id: candidate.id,
      test_id: candidate.test_id,
      stalled_for_ms: age,
      requeued,
    });
    outcomes.push({
      ...base,
      action: requeued ? 'requeued_and_scheduled' : 'scheduled',
      error: null,
    });
  }

  const rearmed = outcomes.filter(
    (o) => o.action === 'requeued_and_scheduled' || o.action === 'scheduled' || o.action === 'would_rearm',
  ).length;
  const failed = outcomes.filter((o) => o.action === 'schedule_failed').length;

  return {
    sweptAt: nowIso,
    staleAfterMs: options.staleAfterMs,
    dryRun: options.dryRun,
    candidateCount: candidates.length,
    rearmed,
    skipped: outcomes.length - rearmed - failed,
    failed,
    outcomes,
  };
}
