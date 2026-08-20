import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authorizeAdminTestsRoute } from '~/lib/api/admin-tests-auth';
import { APP_VERSION } from '~/lib/app-version';
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
const createRunBodySchema = z.object({
  testId: z.string().min(1),
  runMode: z.enum(['full', 'search']).default('full'),
  /** Maps to a concrete chat model in `resolveResponsesModel()`; `preview` is the configured default. */
  modelTag: z.enum(['preview', 'gpt-4o', 'gpt-4.1']).default('preview'),
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

  const { testId, runMode, modelTag, useHybrid, useReranker, useMultiIntent } = parsed.data;

  const test = await getTestById(testId).catch(() => null);
  if (!test) {
    return NextResponse.json({ error: 'Test not found' }, { status: 404 });
  }

  const items = await getTestItemsByTestId(testId);
  if (items.length === 0) {
    return NextResponse.json({ error: 'This test has no items to run' }, { status: 409 });
  }

  const run = await createTestResult({
    test_id: testId,
    status: 'queued',
    run_mode: runMode,
    total_items: items.length,
    passed_items: 0,
    failed_items: 0,
    started_at: new Date().toISOString(),
    run_options:
      runMode === 'search' ? { useHybrid, useReranker, useMultiIntent } : { modelTag },
    app_version: APP_VERSION,
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
