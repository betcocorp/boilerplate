import { NextResponse } from 'next/server';

import { withApiV1 } from '~/lib/api/with-api-v1';
import { runStalledTestRunSweep } from '~/lib/observability/stalled-test-run-repository';
import { sweepStalledTestRunsInputSchema } from '~/lib/observability/stalled-test-run-sweeper';

/**
 * B0-990 — cron/manual entry point for the stalled eval test-run recovery sweep.
 *
 * AUTHENTICATED, never public: `withApiV1` enforces the same per-client bearer token as every other
 * `/api/v1/*` route and logs the invocation to `api_request_log`. The incoming `Authorization`
 * header is FORWARDED as-is to the `POST /api/admin/tests/runs/[runId]` calls the sweep makes rather
 * than a second token being minted, so the sweep can never be authorized to do something a human
 * clicking "Run dataset" is not.
 *
 * `POST` accepts an optional `{ staleAfterMs, limit, dryRun }` body. `GET` exists only because
 * schedulers such as Vercel Cron issue GET with an `Authorization: Bearer …` header and nothing
 * else; it runs the sweep with defaults. Both are `force-dynamic` so neither is ever prerendered.
 *
 * ## Wiring
 * `vercel.json` schedules the GET four times an hour, offset from the other observability crons.
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`, so `CRON_SECRET` must be a real
 * provisioned API token (`bex_<env>_…`) already authorized for `/api/admin/tests/runs*` — identical
 * to `sweep-pending-reports/route.ts` and `run-golden-test-sweep/route.ts`.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Every downstream call answers 202 immediately (execution happens in the callee's own `after()`),
 * so a full batch is a handful of instant round-trips plus one small write each. 60s is generous.
 */
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

  const parsed = sweepStalledTestRunsInputSchema.safeParse(body ?? {});
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

  const authorization = request.headers.get('authorization') ?? '';
  const origin = new URL(request.url).origin;

  const result = await runStalledTestRunSweep(parsed.data, { origin, authorization });
  return NextResponse.json({ ok: true, result });
});

/** Scheduler-friendly variant: defaults only, no body. */
export const GET = withApiV1(async (request) => {
  const authorization = request.headers.get('authorization') ?? '';
  const origin = new URL(request.url).origin;

  const result = await runStalledTestRunSweep({}, { origin, authorization });
  return NextResponse.json({ ok: true, result });
});
