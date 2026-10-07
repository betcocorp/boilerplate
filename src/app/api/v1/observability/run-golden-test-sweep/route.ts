import { NextResponse } from 'next/server';

import { withApiV1 } from '~/lib/api/with-api-v1';
import {
  runGoldenTestSweep,
  runGoldenTestSweepInputSchema,
} from '~/lib/observability/run-golden-test-sweep';

/**
 * B0-766 — cron/manual entry point for the nightly "run every golden test" sweep.
 *
 * AUTHENTICATED, never public: `withApiV1` enforces the same per-client bearer token as every
 * other `/api/v1/*` route. The incoming `Authorization` header is forwarded as-is to the
 * `POST /api/admin/tests/runs*` calls `runGoldenTestSweep` makes, rather than minting a second
 * token, so the sweep can never drift from what a human clicking "Run dataset" is authorized to do.
 *
 * `POST` accepts an optional `{ dryRun }` body. `GET` exists only because schedulers such as
 * Vercel Cron issue GET with an `Authorization: Bearer …` header and nothing else; it runs the
 * sweep with defaults (`dryRun: false`). Both are `force-dynamic` so neither is ever prerendered.
 *
 * ## Wiring
 * `vercel.json` schedules the GET nightly at 00:00. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`, so `CRON_SECRET` must be a real provisioned API token
 * (`bex_<env>_…`) already authorized for `/api/admin/tests/runs*` — see
 * `sweep-stalled-runs/route.ts` for the identical pattern.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Golden tests run concurrently, but the slowest single test can still take minutes. */
export const maxDuration = 280;

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

  const parsed = runGoldenTestSweepInputSchema.safeParse(body ?? {});
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

  const result = await runGoldenTestSweep(parsed.data, { origin, authorization });
  return NextResponse.json({ ok: true, result });
});

/** Scheduler-friendly variant: defaults only, no body. */
export const GET = withApiV1(async (request) => {
  const authorization = request.headers.get('authorization') ?? '';
  const origin = new URL(request.url).origin;

  const result = await runGoldenTestSweep(
    runGoldenTestSweepInputSchema.parse({}),
    { origin, authorization },
  );
  return NextResponse.json({ ok: true, result });
});
