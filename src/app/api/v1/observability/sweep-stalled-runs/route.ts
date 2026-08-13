import { NextResponse } from 'next/server';

import { withApiV1 } from '~/lib/api/with-api-v1';
import { runStalledRunSweep } from '~/lib/observability/run-stalled-run-sweep';
import { sweepStalledRunsInputSchema } from '~/lib/observability/stalled-run-sweeper';

/**
 * B0-371 — cron/manual entry point for the orphaned-run sweeper.
 *
 * AUTHENTICATED, never public: `withApiV1` enforces the same per-client bearer token
 * as every other `/api/v1/*` route (`api_project` → `api_app` → `api_key` chain check,
 * uniform 401) and logs the invocation to `api_request_log`. There is no shared secret
 * and no `NODE_ENV` bypass.
 *
 * `POST` is the honest verb for a mutation and accepts an optional
 * `{ staleAfterMs, limit, dryRun }` body. `GET` exists only because schedulers such as
 * Vercel Cron can issue GET with an `Authorization: Bearer …` header and nothing else;
 * it runs the sweep with defaults. Both are `force-dynamic` so neither is ever
 * prerendered or cached.
 *
 * ## Wiring
 * `vercel.json` schedules the GET hourly. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`, so the `CRON_SECRET` environment variable must
 * be set to a real provisioned API token (`bex_<env>_…`) from the client registry —
 * that is what keeps the endpoint on the standard auth path instead of introducing a
 * second, weaker secret. Without that env var the cron simply gets the uniform 401 and
 * nothing is swept.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** A full batch is up to 200 rows × 2 writes; well clear of the default 10s budget. */
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

  const parsed = sweepStalledRunsInputSchema.safeParse(body ?? {});
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

  const result = await runStalledRunSweep(parsed.data);
  return NextResponse.json({ ok: true, result });
});

/** Scheduler-friendly variant: defaults only, no body. */
export const GET = withApiV1(async () => {
  const result = await runStalledRunSweep();
  return NextResponse.json({ ok: true, result });
});
