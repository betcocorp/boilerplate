import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authorizeAdminTestsRoute } from '~/lib/api/admin-tests-auth';
import { APP_VERSION } from '~/lib/app-version';
import { authOptions } from '~/lib/auth';
import supportedModels from '~/lib/constants/models';
import {
  createTestResult,
  getTestById,
  getTestItemsByTestId,
  updateTestRecord,
} from '~/lib/tests/repository';

const ROUTE = 'POST /api/admin/tests/runs';

/**
 * B0-465 — creates a fresh run for a test suite so CI can gate a PR on a NEW golden-set run
 * instead of re-reading one pinned `BEX_GATE_LATEST_RUN_ID` secret forever.
 *
 * Mirrors `runTestAction` / `runSearchEvalAction` (`app/(authenticated)/admin/tests/actions.ts`)
 * exactly — same `queued` status, same `run_options` shape, same summary seed — because
 * `POST /api/admin/tests/runs/[runId]` and both executors read those fields. This route only
 * CREATES the run; execution stays with that existing endpoint.
 *
 * The search-mode flags default to `false`, matching an unchecked checkbox in the admin form, so a
 * caller that omits them gets the same run the UI would produce. CI passes them explicitly.
 */
const supportedModelNames = supportedModels.map((m) => m.name);
const createRunBodySchema = z.object({
  testId: z.string().min(1),
  runMode: z.enum(['full', 'search']).default('full'),
  /**
   * Maps to a concrete chat model in `resolveResponsesModel()`.
   *
   * B0-757 — defaults to `gpt-4.1`, not `preview`. This route is the CI eval-gate's run-creation
   * call (B0-465): a caller (CI) that omits `modelTag` entirely used to silently land on whatever
   * `BEX_RESPONSES_MODEL` resolves `preview` to (gpt-4.1-mini today), invalidating the 234-item
   * regression run on 2026-08-29 (7fb79091-e93b-4d52-a38b-4283f5cd639f, 64.6/D vs 71.3/C for the
   * same set on gpt-4.1). `preview` is still selectable when a caller passes it explicitly — this
   * only changes what an OMITTED field resolves to, matching the "Run dataset" form's own default
   * (B0-614, `TestRunModelControls`).
   */
  modelTag: z.enum(['preview', ...supportedModelNames]).default('gpt-4.1'),
  /**
   * B0-600 / B0-603 — enables the validator pass for a full-mode run so a validator A/B test can be
   * configured. Defaults false, matching every run created before this field existed.
   */
  useValidator: z.boolean().default(false),
  useHybrid: z.boolean().default(false),
  useReranker: z.boolean().default(false),
  useMultiIntent: z.boolean().default(false),
});

export async function POST(request: Request) {
  const denied = await authorizeAdminTestsRoute(request, ROUTE);
  if (denied) return denied;

  const rawBody = await request.json().catch(() => null);
  const parsed = createRunBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const {
    testId,
    runMode,
    modelTag,
    useValidator,
    useHybrid,
    useReranker,
    useMultiIntent,
  } = parsed.data;

  const test = await getTestById(testId).catch(() => null);
  if (!test) {
    return NextResponse.json({ error: 'Test not found' }, { status: 404 });
  }

  const items = await getTestItemsByTestId(testId);
  if (items.length === 0) {
    return NextResponse.json(
      { error: 'This test has no items to run' },
      { status: 409 },
    );
  }

  /**
   * B0-687 — `authorizeAdminTestsRoute` accepts either a signed-in admin OR a client token, so the
   * actor is resolved separately here. No session means the request authenticated with a service
   * token (the CI eval gate), which carries no NextAuth user — labeled `api-client` rather than
   * left null, so a CI-created run is never mistaken for a pre-B0-687 run of unknown origin.
   */
  const session = await getServerSession(authOptions);
  const triggeredBy = session?.user?.email ?? 'api-client';

  const run = await createTestResult({
    test_id: testId,
    status: 'queued',
    run_mode: runMode,
    total_items: items.length,
    passed_items: 0,
    failed_items: 0,
    started_at: new Date().toISOString(),
    run_options:
      runMode === 'search'
        ? { useHybrid, useReranker, useMultiIntent }
        : { modelTag, useValidator },
    app_version: APP_VERSION,
    triggered_by: triggeredBy,
    summary: {
      completed_items: 0,
      total_items: items.length,
      progress_percent: 0,
      runner_state: 'queued',
    },
  });

  // Only the chat runner flips the parent record to `running` (search runs leave it alone),
  // matching `runTestAction` vs `runSearchEvalAction`.
  if (runMode === 'full') {
    await updateTestRecord(testId, { status: 'running' });
  }

  return NextResponse.json({
    ok: true,
    runId: run.id,
    testId,
    runMode,
    totalItems: items.length,
    suiteVersion: test.suite_version,
  });
}
