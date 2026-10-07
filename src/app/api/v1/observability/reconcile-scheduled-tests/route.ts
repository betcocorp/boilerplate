import { NextResponse } from 'next/server';

import { withApiV1 } from '~/lib/api/with-api-v1';
import { reconcileScheduledTestsInputSchema } from '~/lib/observability/reconcile-scheduled-tests';
import { runScheduledTestReconciliation } from '~/lib/observability/scheduled-test-repository';

/**
 * B0-941 — cron/manual entry point for the scheduled-test reconciler.
 *
 * AUTHENTICATED, never public: `withApiV1` enforces the same per-client bearer token as every
 * other `/api/v1/*` route (`api_project` → `api_app` → `api_key` chain check, uniform 401) and
 * logs the invocation to `api_request_log`. There is no shared secret and no `NODE_ENV` bypass.
 *
 * `POST` is the honest verb for a mutation and accepts an optional
 * `{ staleAfterMs, limit, dryRun }` body. `GET` exists only because schedulers such as Vercel Cron
 * can issue GET with an `Authorization: Bearer …` header and nothing else; it reconciles with
 * defaults. Both are `force-dynamic` so neither is ever prerendered or cached.
 *
 * ## Wiring
 * `vercel.json` schedules the GET hourly at :30 — deliberately offset from the stalled-run sweep
 * at :00 so the two never contend. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`, so
 * `CRON_SECRET` must be a real provisioned API token (`bex_<env>_…`); see
 * `sweep-stalled-runs/route.ts` for the identical pattern.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** A full batch is up to 200 children, each a small read + write; well clear of the default. */
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

  const parsed = reconcileScheduledTestsInputSchema.safeParse(body ?? {});
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

  const result = await runScheduledTestReconciliation(parsed.data);
  return NextResponse.json({ ok: true, result });
});

/** Scheduler-friendly variant: defaults only, no body. */
export const GET = withApiV1(async () => {
  const result = await runScheduledTestReconciliation();
  return NextResponse.json({ ok: true, result });
});
