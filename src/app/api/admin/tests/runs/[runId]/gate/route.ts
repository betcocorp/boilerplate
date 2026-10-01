import { NextResponse } from 'next/server';

import { authorizeAdminTestsRoute } from '~/lib/api/admin-tests-auth';
import {
  anyResultItemHasConfidenceGatingDisabled,
  computeAvgJudgmentConfidenceForResult,
  computeAvgSimilarityForResult,
  getTestById,
  getTestResultById,
} from '~/lib/tests/repository';
import { isTerminalRunStatus } from '~/lib/tests/types';

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  // B0-465 — session OR CI service token; the pinned-run-id gate could never authenticate.
  const denied = await authorizeAdminTestsRoute(
    request,
    'GET /api/admin/tests/runs/[runId]/gate',
  );
  if (denied) return denied;

  const { runId } = await context.params;
  const run = await getTestResultById(runId).catch(() => null);

  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  if (!isTerminalRunStatus(run.status)) {
    return NextResponse.json(
      { error: 'Run is not yet complete', run_status: run.status },
      { status: 409 },
    );
  }

  const test = await getTestById(run.test_id);

  // Use stored avg if available (written at run completion), else compute on demand.
  const avg_similarity = run.avg_similarity ?? (await computeAvgSimilarityForResult(run.id));

  /**
   * B0-492 — `test_results.avg_confidence` (when populated by an older write path) has no
   * recorded provenance breakdown, so a value read from it cannot be claimed as "judgment-only".
   * The on-demand computation, by contrast, is DEFINED as judgment-only (`validator_judged` items
   * only — see `computeAvgJudgmentConfidenceForResult`). CI must know which one it got, so both
   * are reported via `confidence_population` rather than silently coalescing them into one number
   * the way `avg_similarity` above still does.
   */
  const judgmentConfidence = await computeAvgJudgmentConfidenceForResult(run.id);
  const avg_confidence = run.avg_confidence ?? judgmentConfidence.avg;
  const confidence_population: 'judgment_only' | 'unknown_legacy' | 'none' =
    run.avg_confidence != null
      ? 'unknown_legacy'
      : judgmentConfidence.avg != null
        ? 'judgment_only'
        : 'none';
  const confidence_item_count =
    run.avg_confidence != null ? run.total_items : judgmentConfidence.itemCount;

  const similarity_floor = test.similarity_floor;
  const confidence_floor = test.confidence_floor;

  const similarity_ok = avg_similarity !== null ? avg_similarity >= similarity_floor : null;

  /**
   * B0-494 — a run executed with the B0-452 kill switch on has FICTIONAL confidence caps (the
   * gate detected something but was told not to act), so it must never silently satisfy
   * `confidence_floor`. Checked before deciding `confidence_ok` so this can force it to null
   * regardless of what `avg_confidence` happens to compute to.
   */
  const confidence_gating_disabled_for_any_item =
    await anyResultItemHasConfidenceGatingDisabled(run.id);

  // Confidence gate only applies to full-mode agent runs, only when there is at least one
  // judgment-provenance item to average (a run with zero `validator_judged` items must not
  // silently pass or fail on an empty population), and never when any item ran with confidence
  // gating disabled.
  const confidence_ok =
    run.run_mode === 'full' &&
    avg_confidence !== null &&
    confidence_population !== 'none' &&
    !confidence_gating_disabled_for_any_item
      ? avg_confidence >= confidence_floor
      : null;

  // Pass if neither gate that has a value is failing.
  const pass = similarity_ok !== false && confidence_ok !== false;

  return NextResponse.json({
    ok: true,
    pass,
    runId: run.id,
    testId: run.test_id,
    suite_version: test.suite_version,
    run_mode: run.run_mode,
    item_count: run.total_items,
    avg_similarity,
    similarity_floor,
    similarity_ok,
    avg_confidence,
    confidence_floor,
    confidence_ok,
    // B0-492 — which population `avg_confidence` was averaged over, and how many items.
    confidence_population,
    confidence_item_count,
    // B0-494 — true when any item in this run executed with BEX_DISABLE_CONFIDENCE_GATING on;
    // when true, `confidence_ok` is forced to null above regardless of `avg_confidence`.
    confidence_gating_disabled_for_any_item,
  });
}
