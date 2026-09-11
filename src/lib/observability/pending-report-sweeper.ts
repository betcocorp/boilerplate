/**
 * B0-943 — recovery net for eval reports whose generation lost its driver.
 *
 * ## The problem this exists for
 * `generateReport` (`~/lib/tests/report/orchestrator.ts`) is not a job — it is a single
 * TIME-BOUNDED SLICE. It grades as many cases as it can inside the function budget, checkpoints
 * its progress into `test_results.report_state`, and returns `status: 'scoring'`, expecting the
 * caller to invoke it again. Historically the ONLY thing that ever did that was the browser: a
 * human sitting on `/admin/tests/[testId]/runs/[runId]/report` re-POSTing each time the response
 * came back non-terminal. Close the tab and the report simply stops, half-graded, forever. Live
 * evidence at the time of writing: 24 of 154 completed runs in the trailing 30 days had no report,
 * 14 of them frozen at `report_state.status = 'scoring'`.
 *
 * ## Where this sits
 * The PRIMARY fix is the self-chaining background mode on
 * `POST /api/admin/tests/runs/[runId]/report` (`x-bex-report-mode: background`), which answers 202
 * and keeps re-invoking itself in `after()` until the report is terminal. That chain is what
 * normally carries a report to completion. THIS module is the safety net for the case that chain
 * cannot cover: a hop that dies mid-flight (deploy, OOM, function kill) leaves nobody to fire the
 * next one, and the 24 runs already stuck predate the chain entirely. A cron
 * (`/api/v1/observability/sweep-pending-reports`, every 10 minutes) re-arms them.
 *
 * ## Why this cannot double-grade
 * It does not coordinate with the browser or the chain itself — the CALLEE's lease does. The
 * background handler skips its work when `report_state.activeWorker` / `activeUntil` show another
 * worker holds a fresh lease, so a run a human's open tab is actively driving costs this sweeper a
 * 202 and nothing else. The staleness window here (default 10 minutes) is a cheap second line of
 * defence that keeps the sweeper from even asking about a report something touched moments ago.
 *
 * ## Self-HTTP, not a direct import
 * Like `run-golden-test-sweep.ts`, every hand-off is a real HTTP call back into this same
 * deployment, and the caller's own `Authorization` header is FORWARDED rather than a token minted
 * here: the cron's `Authorization: Bearer $CRON_SECRET` is a real `bex_<env>_…` registry token that
 * `authorizeAdminTestsRoute` already accepts, so the sweeper can never be authorized to do
 * something a human on that page is not.
 */

import { z } from 'zod';

import {
  listPendingReportCandidates,
  type PendingReportCandidate,
  type PendingReportSweeperPort,
} from '~/lib/observability/pending-report-repository';

const REPORT_PATH = (runId: string) => `/api/admin/tests/runs/${runId}/report`;

/** Header contract owned by the background handler (part A of B0-943). */
const REPORT_MODE_HEADER = 'x-bex-report-mode';
const REPORT_HOP_HEADER = 'x-bex-report-hop';
const BACKGROUND_MODE = 'background';
/** The sweeper always starts a fresh chain, so it is always hop 1. */
const FIRST_HOP = '1';

/* -------------------------------------------------------------------------- *
 * Contracts (Zod first, per AGENTS.md)
 * -------------------------------------------------------------------------- */

export const sweepPendingReportsInputSchema = z.object({
  /** Report which runs would be re-armed without firing anything. */
  dryRun: z.boolean().default(false),
  /** Maximum runs to re-arm in one sweep. */
  limit: z.number().int().min(1).max(100).default(10),
  /** How far back to look for completed runs missing a report. */
  lookbackHours: z.number().int().min(1).max(24 * 30).default(72),
  /** A report touched more recently than this is left alone — something is already driving it. */
  stalenessMinutes: z.number().int().min(1).max(24 * 60).default(10),
});

export type SweepPendingReportsInput = z.input<typeof sweepPendingReportsInputSchema>;
export type SweepPendingReportsOptions = z.output<typeof sweepPendingReportsInputSchema>;

export const pendingReportSweepOutcomeSchema = z.object({
  runId: z.string(),
  testId: z.string(),
  ok: z.boolean(),
  /** The candidate's `report_state.status` as read, or null when it had no `report_state`. */
  reportStatus: z.string().nullable(),
  completedCases: z.number().int().nonnegative().nullable(),
  totalCases: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});
export type PendingReportSweepOutcome = z.infer<typeof pendingReportSweepOutcomeSchema>;

export const sweepPendingReportsResultSchema = z.object({
  dryRun: z.boolean(),
  candidateCount: z.number().int().nonnegative(),
  scheduled: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  outcomes: z.array(pendingReportSweepOutcomeSchema),
});
export type SweepPendingReportsResult = z.infer<typeof sweepPendingReportsResultSchema>;

export type SweepPendingReportsContext = {
  origin: string;
  authorization: string;
};

export type SweepPendingReportsDeps = {
  /** Injected so unit tests never need a database. */
  port?: PendingReportSweeperPort;
  /** Injected so unit tests never need a network. */
  fetchImpl?: typeof fetch;
};

function baseOutcome(candidate: PendingReportCandidate) {
  return {
    runId: candidate.runId,
    testId: candidate.testId,
    reportStatus: candidate.reportStatus,
    completedCases: candidate.completedCases,
    totalCases: candidate.totalCases,
  };
}

async function scheduleBackgroundReport(
  candidate: PendingReportCandidate,
  context: SweepPendingReportsContext,
  fetchImpl: typeof fetch,
): Promise<PendingReportSweepOutcome> {
  const base = baseOutcome(candidate);

  let response: Response;
  try {
    response = await fetchImpl(`${context.origin}${REPORT_PATH(candidate.runId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: context.authorization,
        [REPORT_MODE_HEADER]: BACKGROUND_MODE,
        [REPORT_HOP_HEADER]: FIRST_HOP,
      },
    });
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : 'Network error scheduling report',
    };
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return { ...base, ok: false, error: body?.error ?? `HTTP ${response.status}` };
  }

  return { ...base, ok: true, error: null };
}

/**
 * Re-arm every report left non-terminal by a dead driver.
 *
 * Each hand-off is fired CONCURRENTLY: the background handler answers 202 the moment it has
 * accepted the work, so the whole sweep is milliseconds of HTTP, not the minutes the grading
 * itself takes. A non-2xx or a network error on one run is recorded in that run's outcome and
 * never aborts the others.
 */
export async function sweepPendingReports(
  options: SweepPendingReportsOptions,
  context: SweepPendingReportsContext,
  deps: SweepPendingReportsDeps = {},
): Promise<SweepPendingReportsResult> {
  // Called through the port object rather than destructured off it, so a stub that relies on
  // `this` (or a future Supabase adapter that does) is not silently unbound.
  const { port } = deps;
  const listCandidates: PendingReportSweeperPort['listPendingReportCandidates'] = port
    ? (query) => port.listPendingReportCandidates(query)
    : listPendingReportCandidates;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const candidates = await listCandidates({
    limit: options.limit,
    lookbackHours: options.lookbackHours,
    stalenessMinutes: options.stalenessMinutes,
  });

  if (options.dryRun || candidates.length === 0) {
    return {
      dryRun: options.dryRun,
      candidateCount: candidates.length,
      scheduled: 0,
      failed: 0,
      outcomes: candidates.map((candidate) => ({
        ...baseOutcome(candidate),
        ok: true,
        error: null,
      })),
    };
  }

  const outcomes = await Promise.all(
    candidates.map((candidate) => scheduleBackgroundReport(candidate, context, fetchImpl)),
  );

  return {
    dryRun: false,
    candidateCount: candidates.length,
    scheduled: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok).length,
    outcomes,
  };
}
