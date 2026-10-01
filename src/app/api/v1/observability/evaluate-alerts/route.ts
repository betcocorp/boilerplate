import { NextResponse } from 'next/server';

import { withApiV1 } from '~/lib/api/with-api-v1';
import { listRecentAlertEvaluations } from '~/lib/observability/alert-evaluation-repository';
import {
  evaluateAlertsInputSchema,
  recordAlertEvaluationFailure,
  runAlertEvaluation,
} from '~/lib/observability/run-alert-evaluation';

/**
 * B0-466 — cron/manual entry point for observability alerting (tool-call failure rate,
 * golden-set pass-rate regressions).
 *
 * AUTHENTICATED, never public: `withApiV1` enforces the same per-client bearer token as every
 * other `/api/v1/*` route (`api_project` → `api_app` → `api_key` chain check, uniform 401) and
 * logs the invocation to `api_request_log`. There is no shared secret and no `NODE_ENV` bypass.
 * This mirrors `/api/v1/observability/sweep-stalled-runs` exactly.
 *
 * `GET`  — the scheduler path (Vercel Cron issues GET with `Authorization: Bearer $CRON_SECRET`),
 *          runs with the thresholds resolved from `settings`, recorded as `trigger = 'cron'`.
 *          `?history=1` returns the last evaluations instead of running one — the "did the alerter
 *          actually run?" read, with no side effects.
 * `POST`  — the operator path, `trigger = 'manual'`, accepting
 *          `{ lookbackDays, bucketSize, dryRun, thresholds }`. The partial `thresholds` override is
 *          how a tester forces an alert on demand without retuning the shared `settings` rows.
 *
 * ## Wiring
 * `vercel.json` schedules the GET daily at 07:10 EST. As with the sweeper, `CRON_SECRET` must be a
 * real provisioned API token (`bex_<env>_…`) from the client registry; without it the cron simply
 * receives the uniform 401 and nothing is evaluated — which is why the persisted evaluation trail
 * (`observability_alert_evaluations`) is the thing to check when confirming the alerter is alive.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Two paged scans plus optional outbound delivery; well clear of the default budget. */
export const maxDuration = 60;

async function readBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

export const POST = withApiV1(async (request) => {
  let body: unknown;
  try {
    body = await readBody(request);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = evaluateAlertsInputSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Invalid request',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const startedAtMs = Date.now();
  try {
    const result = await runAlertEvaluation(parsed.data, 'manual');
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    await recordAlertEvaluationFailure({ error, trigger: 'manual', startedAtMs });
    return NextResponse.json({ error: 'Alert evaluation failed' }, { status: 500 });
  }
});

/** Scheduler-friendly variant: defaults only, no body. `?history=1` reads the trail instead. */
export const GET = withApiV1(async (request) => {
  const url = new URL(request.url);
  if (url.searchParams.get('history')) {
    const limit = Number(url.searchParams.get('limit') ?? '10');
    const evaluations = await listRecentAlertEvaluations(
      Number.isFinite(limit) ? limit : 10,
    );
    return NextResponse.json({ ok: true, evaluations });
  }

  const startedAtMs = Date.now();
  try {
    const result = await runAlertEvaluation({}, 'cron');
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    await recordAlertEvaluationFailure({ error, trigger: 'cron', startedAtMs });
    return NextResponse.json({ error: 'Alert evaluation failed' }, { status: 500 });
  }
});
