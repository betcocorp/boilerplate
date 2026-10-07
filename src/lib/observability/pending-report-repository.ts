/**
 * B0-943 — Supabase wiring for the pending-report sweeper.
 *
 * All I/O for `~/lib/observability/pending-report-sweeper.ts` lives here so the sweeper itself
 * stays a pure decision module a unit test can drive with a stub port — the same split
 * `stalled-run-repository.ts` / `stalled-run-sweeper.ts` already uses.
 *
 * This module is strictly READ-ONLY. It never writes `test_results`: the only thing the sweeper
 * does with a candidate is ask `POST /api/admin/tests/runs/[runId]/report` to resume it, and that
 * route owns every write (including the `report_state.activeWorker` / `activeUntil` lease).
 *
 * ## Why the jsonb predicates are applied in TypeScript
 * The candidate set is "report not finished AND nobody has touched it recently", which lives in the
 * `report_state` jsonb: `status` plus `updatedAt`. PostgREST can express `->>` comparisons, but not
 * a timestamp cast on one, so the staleness half would end up as a brittle string comparison. The
 * cheap, index-friendly half of the predicate (`status`, `report is null`, `completed_at`) therefore
 * runs in Postgres, and the jsonb half runs here against `parseReportState` — the SAME Zod schema
 * the orchestrator resumes from, never a second hand-rolled copy of it.
 */

import {
  isResumableFailure,
  parseReportState,
  type ReportFailureClass,
  type ReportStatus,
} from '~/lib/tests/report/schemas';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/** Run statuses that mean "the run itself finished, so a report is owed". */
const COMPLETED_RUN_STATUSES = ['completed', 'completed_with_failures'] as const;

/**
 * `report_state.status` values that still owe work. `completed` and `failed` are terminal:
 * a genuinely failed report is a grading problem, not a lost-driver problem, and re-firing it on a
 * 10-minute cron would burn grading spend on something a human needs to look at.
 *
 * B0-991 — the one exception is a `failed` state classed `provider_unconfigured`: nothing was
 * graded (the host had no credentials for the grading provider), so once the host is fixed it is
 * exactly a lost-driver case. `isResumableFailure` (the orchestrator's own rule) decides that.
 */
const RESUMABLE_REPORT_STATUSES: readonly ReportStatus[] = ['idle', 'scoring', 'synthesizing'];

/**
 * How many rows to pull before the in-TypeScript jsonb filter runs. The DB-side predicate is
 * deliberately loose (it cannot see `report_state.status`), so over-fetch to keep a page of
 * recently-touched rows from starving genuinely stuck ones out of the result.
 */
const CANDIDATE_FETCH_MULTIPLIER = 10;
const MAX_CANDIDATE_FETCH = 200;

export type PendingReportCandidate = {
  runId: string;
  testId: string;
  completedAt: string | null;
  /** Parsed `report_state.status`, or `null` when the row has no `report_state` at all. */
  reportStatus: string | null;
  completedCases: number | null;
  totalCases: number | null;
  /** `report_state.updatedAt` — what the staleness window is measured against. */
  updatedAt: string | null;
};

export type ListPendingReportCandidatesOptions = {
  limit: number;
  lookbackHours: number;
  stalenessMinutes: number;
  /** Injectable clock; defaults to the wall clock. */
  now?: () => number;
};

/** The data access `sweepPendingReports` depends on. */
export type PendingReportSweeperPort = {
  listPendingReportCandidates(
    options: ListPendingReportCandidatesOptions,
  ): Promise<PendingReportCandidate[]>;
};

type ReportStateProbe = {
  status: string | null;
  updatedAt: string | null;
  completedCases: number | null;
  totalCases: number | null;
  /** B0-991 — only read on a `failed` state; null for anything else or a legacy row. */
  failureClass: ReportFailureClass | null;
};

function readFailureClass(value: unknown): ReportFailureClass | null {
  return value === 'provider_unconfigured' ? value : null;
}

/**
 * Read the three fields the predicate needs out of a persisted `report_state`.
 *
 * The happy path is `parseReportState`. The fallback exists because a `report_state` that FAILS to
 * parse is precisely the row the orchestrator would restart from scratch — skipping it silently
 * would leave it stuck forever — but its own `updatedAt`, if it has a usable one, still has to be
 * honoured so the sweeper does not fight a worker that is actively writing it.
 */
function probeReportState(value: unknown): ReportStateProbe | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = parseReportState(value);
  if (parsed) {
    return {
      status: parsed.status,
      updatedAt: parsed.updatedAt,
      completedCases: parsed.completedCases,
      totalCases: parsed.totalCases,
      failureClass: parsed.failureClass,
    };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return {
      status: null,
      updatedAt: null,
      completedCases: null,
      totalCases: null,
      failureClass: null,
    };
  }

  const raw = value as Record<string, unknown>;
  return {
    status: typeof raw.status === 'string' ? raw.status : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    completedCases: typeof raw.completedCases === 'number' ? raw.completedCases : null,
    totalCases: typeof raw.totalCases === 'number' ? raw.totalCases : null,
    failureClass: readFailureClass(raw.failureClass),
  };
}

/** True when this `report_state` still owes work (including "there is no state yet"). */
function isResumableProbe(probe: ReportStateProbe): boolean {
  if (probe.status === null) {
    return true;
  }
  if (probe.status === 'failed') {
    return isResumableFailure({ status: 'failed', failureClass: probe.failureClass });
  }
  return (RESUMABLE_REPORT_STATUSES as readonly string[]).includes(probe.status);
}

/**
 * True when nothing has written this report recently, so resuming it cannot collide with an open
 * report page or an in-flight hop. An unparseable `updatedAt` counts as stale: a row whose
 * timestamp we cannot read is no evidence of a live worker.
 */
function isStaleEnough(updatedAt: string | null, nowMs: number, stalenessMs: number): boolean {
  if (!updatedAt) {
    return true;
  }
  const updatedMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedMs)) {
    return true;
  }
  return nowMs - updatedMs > stalenessMs;
}

/**
 * Runs whose execution finished but whose report never reached a terminal state.
 *
 * Predicate, in full:
 * - `status in ('completed','completed_with_failures')` (Postgres)
 * - `report is null` (Postgres)
 * - `completed_at > now() - lookbackHours` (Postgres)
 * - `report_state` is null OR `report_state.status in ('idle','scoring','synthesizing')` OR
 *   `status = 'failed' AND failureClass = 'provider_unconfigured'` (here)
 * - `report_state.updatedAt` is null/unreadable OR older than `stalenessMinutes` (here)
 *
 * Newest first, capped at `limit`.
 */
export async function listPendingReportCandidates(
  options: ListPendingReportCandidatesOptions,
): Promise<PendingReportCandidate[]> {
  const nowMs = (options.now ?? Date.now)();
  const lookbackIso = new Date(nowMs - options.lookbackHours * 60 * 60 * 1000).toISOString();
  const stalenessMs = options.stalenessMinutes * 60 * 1000;

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('test_results')
    .select('id,test_id,completed_at,report_state')
    .in('status', [...COMPLETED_RUN_STATUSES])
    .is('report', null)
    .gt('completed_at', lookbackIso)
    .order('completed_at', { ascending: false })
    .limit(Math.min(options.limit * CANDIDATE_FETCH_MULTIPLIER, MAX_CANDIDATE_FETCH));

  if (error) {
    throw new Error(error.message);
  }

  const candidates: PendingReportCandidate[] = [];

  for (const row of data ?? []) {
    const probe = probeReportState(row.report_state);

    if (probe && !isResumableProbe(probe)) {
      continue;
    }
    if (probe && !isStaleEnough(probe.updatedAt, nowMs, stalenessMs)) {
      continue;
    }

    candidates.push({
      runId: row.id,
      testId: row.test_id,
      completedAt: row.completed_at,
      reportStatus: probe?.status ?? null,
      completedCases: probe?.completedCases ?? null,
      totalCases: probe?.totalCases ?? null,
      updatedAt: probe?.updatedAt ?? null,
    });

    if (candidates.length >= options.limit) {
      break;
    }
  }

  return candidates;
}

export function createSupabasePendingReportSweeperPort(): PendingReportSweeperPort {
  return { listPendingReportCandidates };
}
