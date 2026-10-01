import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { authorizeAdminTestsRoute } from '~/lib/api/admin-tests-auth';
import { APP_VERSION } from '~/lib/app-version';
import { authOptions } from '~/lib/auth';
import { createRunBodySchema } from '~/lib/tests/create-run-body';
import {
  createTestResult,
  getTestById,
  getTestItemsByTestId,
  updateTestRecord,
} from '~/lib/tests/repository';
import { buildTestRunOptions } from '~/lib/tests/run-config';

const ROUTE = 'POST /api/admin/tests/runs';

/**
 * B0-465 — creates a fresh run for a test suite so CI can gate a PR on a NEW golden-set run
 * instead of re-reading one pinned `BEX_GATE_LATEST_RUN_ID` secret forever.
 *
 * Mirrors `runTestAction` / `runSearchEvalAction` (`app/(authenticated)/admin/tests/actions.ts`)
 * exactly — same `queued` status, same `run_options` shape (full-mode runs go through the same
 * `buildTestRunOptions`, including the optional `agentMode` / `routerType` added by B0-880), same
 * summary seed — because `POST /api/admin/tests/runs/[runId]` and both executors read those fields.
 * This route only CREATES the run; execution stays with that existing endpoint.
 *
 * The request contract is `createRunBodySchema` (`~/lib/tests/create-run-body`).
 */
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
    agentMode,
    routerType,
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
        : buildTestRunOptions({ modelTag, useValidator, agentMode, routerType }),
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
