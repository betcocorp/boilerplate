import { APP_VERSION } from '~/lib/app-version';
import type { BexModelTag } from '~/lib/constants/models';
import {
  createTestResult,
  getTestById,
  getTestItemsByTestId,
  updateTestRecord,
} from '~/lib/tests/repository';

/**
 * B0-600 — one-call setup for a model A/B test (B0-603 validator, B0-604 orchestrator routing).
 *
 * Lives here rather than in `runner.ts` (which the ticket names) because `runner.ts` is per-ITEM
 * execution and grading; this is run SETUP. Putting run creation there would have it importing the
 * repository purely for this helper.
 *
 * Creates one queued run per model against the SAME suite, so both arms grade the identical
 * question set and stay comparable. Field-for-field identical to `runTestAction` /
 * `POST /api/admin/tests/runs` — same `queued` status, `run_options` and `summary` seed — because
 * `POST /api/admin/tests/runs/[runId]` and `executeTestRun` read those exact fields.
 *
 * Creation only: nothing is executed here. Start each returned run through
 * `POST /api/admin/tests/runs/[runId]`, which keeps the arms serialized instead of having two full
 * suites contend for the same rate limit and skew the latency numbers the A/B is measuring.
 */
export async function createModelComparisonRun(input: {
  testId: string;
  /** One arm per tag, in order. Use 'preview' for the baseline arm. */
  models: readonly BexModelTag[];
  /** Both arms get the same setting — otherwise the comparison is not like-for-like. */
  useValidator?: boolean;
  /**
   * B0-687 — actor stamped on every arm's `test_results.triggered_by`. Optional and defaulting to
   * null: this helper has no request context of its own, so the caller supplies the session email
   * when it has one rather than this module inventing an actor.
   */
  triggeredBy?: string | null;
}): Promise<{
  testId: string;
  suiteVersion: string;
  totalItems: number;
  runs: Array<{ modelTag: BexModelTag; runId: string }>;
}> {
  if (input.models.length < 2) {
    throw new Error('A model comparison needs at least two models to compare.');
  }

  const uniqueModels = [...new Set(input.models)];
  if (uniqueModels.length !== input.models.length) {
    throw new Error('A model comparison needs distinct models; duplicate arms are not comparable.');
  }

  const test = await getTestById(input.testId);
  const items = await getTestItemsByTestId(input.testId);
  if (items.length === 0) {
    throw new Error('This test has no items to run.');
  }

  const useValidator = input.useValidator ?? false;
  const runs: Array<{ modelTag: BexModelTag; runId: string }> = [];

  // Sequential on purpose: `createTestResult` rows carry `started_at`, and creating them in a
  // deterministic order keeps the arms readable in the runs list.
  for (const modelTag of uniqueModels) {
    const run = await createTestResult({
      test_id: input.testId,
      status: 'queued',
      run_mode: 'full',
      total_items: items.length,
      passed_items: 0,
      failed_items: 0,
      started_at: new Date().toISOString(),
      run_options: { modelTag, useValidator },
      app_version: APP_VERSION,
      triggered_by: input.triggeredBy ?? null,
      summary: {
        completed_items: 0,
        total_items: items.length,
        progress_percent: 0,
        runner_state: 'queued',
      },
    });
    runs.push({ modelTag, runId: run.id });
  }

  await updateTestRecord(input.testId, { status: 'running' });

  return {
    testId: input.testId,
    suiteVersion: test.suite_version,
    totalItems: items.length,
    runs,
  };
}
