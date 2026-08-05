/**
 * B0-371 — reconciliation sweeper for orphaned `workflow_runs` / `workflow_steps`
 * (epic B0-330, observability).
 *
 * ## The problem this exists for
 * `runProductSupportWorkflow` inserts a `workflow_runs` row with `status = 'running'`
 * and a `workflow_steps` row per stage, then writes the terminal state in either the
 * success path or the `catch` block. If the PROCESS DIES mid-step (deploy, function
 * timeout, OOM) neither path runs, so the rows keep `status = 'running'` for ever and
 * there is no terminal audit row either. Nothing else in the codebase reconciles them,
 * so they quietly skew every aggregate that filters on status.
 *
 * ## Trigger mechanism: explicit cron, not on-read
 * An on-read reconciliation would have to write from a server component render
 * (`/admin/observability`), which makes an otherwise read-only page mutate data as a
 * side effect of being looked at, and would leave runs unreconciled whenever nobody
 * opens the dashboard. This module is therefore driven by an authenticated
 * cron/manual endpoint — `POST|GET /api/v1/observability/sweep-stalled-runs` — so the
 * reconciliation happens on a schedule regardless of who is watching, and every
 * invocation is attributable in `api_request_log`.
 *
 * ## Purity / testability
 * `sweepStalledRuns` takes its data access and its clock as injected `deps`, so the
 * whole decision surface is unit-testable against stubs and no test needs a database
 * (see `stalled-run-sweeper.test.ts`). The Supabase-backed implementation of the port
 * lives in `~/lib/observability/stalled-run-repository.ts`.
 *
 * ## Clock-skew landmine (do not "fix" this)
 * `workflow_steps.started_at` / `workflow_runs.created_at` default to Postgres
 * `now()`, while the completion side is stamped from the NODE clock. The two clocks
 * disagree by up to ~13.5s in this project's live data, so a naive
 * `Date.now() - started_at` can come out NEGATIVE for a row that was created moments
 * ago. Staleness is therefore computed with {@link stalledForMs}, which CLAMPS AT 0.
 * Never filter rows out for having a negative age: that would silently drop
 * legitimately fresh rows from consideration (and, in the duration-measurement
 * direction, erase the fast steps entirely).
 */

import { z } from 'zod';

import type { Json } from '~/types/supabase.public';

/**
 * The distinct terminal reason a swept row carries. Handled failures write the
 * caught exception's message into `workflow_runs.final_output.error` (see the
 * `catch` block of `run-product-support-workflow.ts`), so this fixed sentinel can
 * never collide with one and any consumer can tell "we killed this record because
 * nobody ever closed it" apart from "the workflow itself errored".
 */
export const ORPHANED_SWEEP_ERROR = 'orphaned_no_terminal_row';

/** Provenance stamp written alongside {@link ORPHANED_SWEEP_ERROR}. */
export const ORPHANED_SWEEP_MARKER = 'stalled-run-sweeper';

/** Audit event type recorded for a swept run — deliberately NOT `workflow_failed`. */
export const ORPHANED_SWEEP_AUDIT_EVENT = 'workflow_swept_orphaned';

/**
 * Staleness threshold: 2 hours.
 *
 * Derived from the live distribution of terminal step durations in
 * `public.workflow_steps` (26,831 rows with a `completed_at`, measured 2026-08-04,
 * clamped at 0 per the note above):
 *
 * | step                     |   p50 |    p95 |    p99 |   p99.9 |       max |
 * | ------------------------ | ----: | -----: | -----: | ------: | --------: |
 * | `openai_responses_agent` | 4.6s  | 26.0s  | 65.7s  | 18m22s  | 1h43m24s  |
 * | `validator`              | 0ms   | 104ms  | 1.2s   |  34.3s  |    29m22s |
 * | `orchestration_planner`  | 0ms   | 0ms    | 0ms    |   0ms   |       0ms |
 * | `early_decline_gate`     | 0ms   | 0ms    | 0ms    |   0ms   |       0ms |
 *
 * Whole-run spans agree: p99 68.4s, p99.9 18m28s, max 1h43m25s. Only 7 of 26,831
 * steps exceeded 30 minutes, exactly 1 exceeded 60 minutes, and ZERO exceeded 120
 * minutes. A 2-hour threshold therefore keeps ~16 minutes of headroom over the
 * slowest run ever observed and would not have swept a single legitimate row in the
 * project's entire history, while still catching every real orphan (the youngest of
 * the 27 known orphans was 7.7 hours old).
 */
export const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** Lower bound accepted from a caller; below this the sweep could race live traffic. */
export const MIN_STALE_AFTER_MS = 5 * 60 * 1000;

/** Default / maximum rows examined per table per invocation. */
export const DEFAULT_SWEEP_LIMIT = 200;
export const MAX_SWEEP_LIMIT = 1000;

/* -------------------------------------------------------------------------- *
 * Contracts (Zod first, per AGENTS.md)
 * -------------------------------------------------------------------------- */

export const sweepStalledRunsInputSchema = z.object({
  /** How long a row may sit in `running` before it is considered orphaned. */
  staleAfterMs: z.number().int().min(MIN_STALE_AFTER_MS).default(DEFAULT_STALE_AFTER_MS),
  /** Max candidate rows examined per table; the next invocation picks up the rest. */
  limit: z.number().int().min(1).max(MAX_SWEEP_LIMIT).default(DEFAULT_SWEEP_LIMIT),
  /** Report what would be swept without writing anything. */
  dryRun: z.boolean().default(false),
});

export type SweepStalledRunsInput = z.input<typeof sweepStalledRunsInputSchema>;
export type SweepStalledRunsOptions = z.output<typeof sweepStalledRunsInputSchema>;

const sweepTallySchema = z.object({
  /** Rows the query returned as possibly stale. */
  candidates: z.number().int().nonnegative(),
  /** Rows confirmed stale and transitioned (or that would be, when `dryRun`). */
  swept: z.number().int().nonnegative(),
  /** Candidates left alone — still within the threshold, or an unusable timestamp. */
  skipped: z.number().int().nonnegative(),
  /** Rows whose write failed; they stay in `running` and are retried next sweep. */
  failed: z.number().int().nonnegative(),
  ids: z.array(z.string()),
});

export const sweepStalledRunsResultSchema = z.object({
  sweptAt: z.string(),
  staleAfterMs: z.number().int().nonnegative(),
  /** Rows created/started at or before this instant are candidates. */
  cutoff: z.string(),
  dryRun: z.boolean(),
  error: z.literal(ORPHANED_SWEEP_ERROR),
  runs: sweepTallySchema,
  steps: sweepTallySchema,
});

export type SweepStalledRunsResult = z.output<typeof sweepStalledRunsResultSchema>;

/* -------------------------------------------------------------------------- *
 * Data-access port
 * -------------------------------------------------------------------------- */

/** Minimal projection of a `workflow_runs` row the sweeper needs. */
export type StalledRunCandidate = {
  id: string;
  conversation_id: string;
  created_at: string;
  final_output: Json | null;
};

/** Minimal projection of a `workflow_steps` row the sweeper needs. */
export type StalledStepCandidate = {
  id: string;
  workflow_run_id: string;
  step_name: string;
  started_at: string;
  error: Json | null;
};

export type StalledRunSweeperPort = {
  /** `workflow_runs` in `running` whose `created_at <= cutoff`, oldest first. */
  listStalledRunCandidates(cutoffIso: string, limit: number): Promise<StalledRunCandidate[]>;
  /**
   * `workflow_steps` in `running` whose `started_at <= cutoff`, oldest first.
   * Deliberately NOT joined to the run's status: 2 of the 19 live orphaned steps
   * hang off a run that already reached a terminal state.
   */
  listStalledStepCandidates(cutoffIso: string, limit: number): Promise<StalledStepCandidate[]>;
  markRunOrphaned(input: {
    id: string;
    finalOutput: Json;
    updatedAtIso: string;
  }): Promise<void>;
  markStepOrphaned(input: { id: string; error: Json }): Promise<void>;
  /** Terminal audit row for a swept run — the row process death never wrote. */
  recordSweepAudit(input: {
    runId: string;
    conversationId: string | null;
    payload: Record<string, unknown>;
  }): Promise<void>;
};

export type SweepStalledRunsDeps = {
  port: StalledRunSweeperPort;
  /** Injected clock (ms since epoch). Defaults to `Date.now` in the repository wiring. */
  now: () => number;
  /** Structured logging hook; injected so tests stay silent. */
  log?: (event: string, fields: Record<string, unknown>) => void;
};

/* -------------------------------------------------------------------------- *
 * Staleness maths
 * -------------------------------------------------------------------------- */

/**
 * Age of a `running` row in ms, CLAMPED AT 0.
 *
 * Returns `null` only when the timestamp cannot be parsed at all — that is a
 * "cannot decide", which the caller must treat as "leave the row alone", never as
 * "sweep it".
 *
 * The clamp exists because `started_at`/`created_at` come from Postgres `now()`
 * while the caller's clock is the Node clock; a fresh row can legitimately look
 * "-13s old". Clamping to 0 makes such a row unambiguously NOT stale. Rejecting or
 * filtering negatives instead would drop real rows.
 */
export function stalledForMs(startedAtIso: string, nowMs: number): number | null {
  const started = Date.parse(startedAtIso);
  if (!Number.isFinite(started) || !Number.isFinite(nowMs)) {
    return null;
  }
  return Math.max(0, nowMs - started);
}

/** True only when the row's clamped age strictly exceeds the threshold. */
export function isStalled(
  startedAtIso: string,
  nowMs: number,
  staleAfterMs: number,
): boolean {
  const age = stalledForMs(startedAtIso, nowMs);
  return age !== null && age > staleAfterMs;
}

/** ISO instant at/below which a `running` row is a sweep candidate. */
export function staleCutoffIso(nowMs: number, staleAfterMs: number): string {
  return new Date(nowMs - staleAfterMs).toISOString();
}

/**
 * `workflow_runs.final_output` for a swept run. Any pre-existing object is spread
 * first so nothing is destroyed, then the sweep marker wins.
 */
export function buildOrphanedRunFinalOutput(
  existing: Json | null,
  marker: { sweptAt: string; stalledForMs: number },
): Json {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};

  return {
    ...base,
    error: ORPHANED_SWEEP_ERROR,
    sweptBy: ORPHANED_SWEEP_MARKER,
    sweptAt: marker.sweptAt,
    stalledForMs: marker.stalledForMs,
  } as Json;
}

/** `workflow_steps.error` for a swept step. */
export function buildOrphanedStepError(
  existing: Json | null,
  marker: { sweptAt: string; stalledForMs: number; stepName: string },
): Json {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};

  return {
    ...base,
    message: ORPHANED_SWEEP_ERROR,
    error: ORPHANED_SWEEP_ERROR,
    sweptBy: ORPHANED_SWEEP_MARKER,
    sweptAt: marker.sweptAt,
    stalledForMs: marker.stalledForMs,
    stepName: marker.stepName,
  } as Json;
}

/* -------------------------------------------------------------------------- *
 * The sweep
 * -------------------------------------------------------------------------- */

type MutableTally = {
  candidates: number;
  swept: number;
  skipped: number;
  failed: number;
  ids: string[];
};

function emptyTally(): MutableTally {
  return { candidates: 0, swept: 0, skipped: 0, failed: 0, ids: [] };
}

/**
 * Transition every `workflow_runs` / `workflow_steps` row that has been sitting in
 * `running` longer than the threshold to `failed` with {@link ORPHANED_SWEEP_ERROR}.
 *
 * Idempotent: selection is on `status = 'running'`, so an already-swept row is never
 * a candidate again. A per-row write failure is counted and skipped rather than
 * aborting the sweep — the row simply stays `running` and is retried next time.
 *
 * Steps are swept BEFORE runs so that, once the run flips to `failed`, the timeline's
 * `not_reached` projection (`~/lib/observability/timeline.ts`) already sees a `failed`
 * step to anchor on and greys out the stages that never ran.
 */
export async function sweepStalledRuns(
  deps: SweepStalledRunsDeps,
  input: SweepStalledRunsInput = {},
): Promise<SweepStalledRunsResult> {
  const options = sweepStalledRunsInputSchema.parse(input);
  const nowMs = deps.now();
  const sweptAt = new Date(nowMs).toISOString();
  const cutoff = staleCutoffIso(nowMs, options.staleAfterMs);
  const log = deps.log;

  const steps = emptyTally();
  const runs = emptyTally();

  /* --- orphaned steps ---------------------------------------------------- */
  const stepCandidates = await deps.port.listStalledStepCandidates(cutoff, options.limit);
  steps.candidates = stepCandidates.length;

  for (const step of stepCandidates) {
    // Re-check in Node with the clamped age: the SQL cutoff is a coarse prefilter,
    // this is the authoritative decision and it can never fire on a fresh row.
    const age = stalledForMs(step.started_at, nowMs);
    if (age === null || age <= options.staleAfterMs) {
      steps.skipped += 1;
      continue;
    }

    if (options.dryRun) {
      steps.swept += 1;
      steps.ids.push(step.id);
      continue;
    }

    try {
      // `completed_at` is deliberately LEFT NULL: process death means we never
      // learned when the step ended, and back-filling `now()` would inject
      // multi-day durations into the latency-by-step aggregate this ticket is
      // trying to stop skewing. `status = 'failed'` is what makes it terminal.
      await deps.port.markStepOrphaned({
        id: step.id,
        error: buildOrphanedStepError(step.error, {
          sweptAt,
          stalledForMs: age,
          stepName: step.step_name,
        }),
      });
      steps.swept += 1;
      steps.ids.push(step.id);
    } catch (error) {
      steps.failed += 1;
      log?.('stalled_step_sweep_failed', {
        step_id: step.id,
        workflow_run_id: step.workflow_run_id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /* --- orphaned runs ----------------------------------------------------- */
  const runCandidates = await deps.port.listStalledRunCandidates(cutoff, options.limit);
  runs.candidates = runCandidates.length;

  for (const run of runCandidates) {
    const age = stalledForMs(run.created_at, nowMs);
    if (age === null || age <= options.staleAfterMs) {
      runs.skipped += 1;
      continue;
    }

    if (options.dryRun) {
      runs.swept += 1;
      runs.ids.push(run.id);
      continue;
    }

    try {
      await deps.port.markRunOrphaned({
        id: run.id,
        finalOutput: buildOrphanedRunFinalOutput(run.final_output, {
          sweptAt,
          stalledForMs: age,
        }),
        updatedAtIso: sweptAt,
      });
      runs.swept += 1;
      runs.ids.push(run.id);
    } catch (error) {
      runs.failed += 1;
      log?.('stalled_run_sweep_failed', {
        workflow_run_id: run.id,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    // Best-effort terminal audit row. A failure here must not undo the transition,
    // so it is logged and swallowed.
    try {
      await deps.port.recordSweepAudit({
        runId: run.id,
        conversationId: run.conversation_id ?? null,
        payload: {
          reason: ORPHANED_SWEEP_ERROR,
          swept_by: ORPHANED_SWEEP_MARKER,
          swept_at: sweptAt,
          stalled_for_ms: age,
          stale_after_ms: options.staleAfterMs,
        },
      });
    } catch (error) {
      log?.('stalled_run_sweep_audit_failed', {
        workflow_run_id: run.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const result: SweepStalledRunsResult = {
    sweptAt,
    staleAfterMs: options.staleAfterMs,
    cutoff,
    dryRun: options.dryRun,
    error: ORPHANED_SWEEP_ERROR,
    runs,
    steps,
  };

  log?.('stalled_run_sweep_completed', {
    stale_after_ms: result.staleAfterMs,
    dry_run: result.dryRun,
    runs_swept: runs.swept,
    runs_skipped: runs.skipped,
    runs_failed: runs.failed,
    steps_swept: steps.swept,
    steps_skipped: steps.skipped,
    steps_failed: steps.failed,
  });

  return result;
}
