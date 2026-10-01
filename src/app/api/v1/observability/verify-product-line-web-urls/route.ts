import { NextResponse } from 'next/server';

import { withApiV1 } from '~/lib/api/with-api-v1';
import { runProductLineWebUrlVerification } from '~/lib/observability/verify-product-line-web-urls';

/**
 * B0-1077 (epic B0-1073) — cron/manual entry point for the derived betco.com product-page URL
 * link checker (`rag.product_line_web_url`, B0-1074).
 *
 * AUTHENTICATED, never public: `withApiV1` enforces the same per-client bearer token as every
 * other `/api/v1/*` route and logs the invocation to `api_request_log` — identical posture to
 * `sweep-stalled-runs/route.ts` and `sweep-pending-reports/route.ts`.
 *
 * `GET` exists (in addition to `POST`) only because schedulers such as Vercel Cron issue GET with
 * an `Authorization: Bearer …` header and nothing else. Both take no body — the checker always
 * verifies every row of `rag.product_line_web_url` (~288 at time of writing; small enough to
 * check in full well within `maxDuration`). Both are `force-dynamic` so neither is ever
 * prerendered or cached.
 *
 * ## Wiring
 * `vercel.json` schedules the GET weekly. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`,
 * so `CRON_SECRET` must be a real provisioned API token (`bex_<env>_…`) from the client registry —
 * identical to the other observability cron routes.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * ~288 URLs at the checker's ~1.8 req/s rate limit is ~160s of sequential fetches; 280s leaves
 * comfortable headroom without approaching a 300s platform ceiling. If the corpus grows enough to
 * threaten this budget, the fix is the same yield/self-hop pattern already used by the golden-test
 * sweep cron, not a longer maxDuration.
 */
export const maxDuration = 280;

export const POST = withApiV1(async () => {
  const summary = await runProductLineWebUrlVerification();
  return NextResponse.json({ ok: true, summary });
});

/** Scheduler-friendly variant: identical to POST, no body to parse. */
export const GET = withApiV1(async () => {
  const summary = await runProductLineWebUrlVerification();
  return NextResponse.json({ ok: true, summary });
});
