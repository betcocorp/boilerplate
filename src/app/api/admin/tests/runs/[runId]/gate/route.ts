import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { authOptions } from '~/lib/auth';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';
import {
  computeAvgJudgmentConfidenceForResult,
  computeAvgSimilarityForResult,
  getTestById,
  getTestResultById,
} from '~/lib/tests/repository';
import { isTerminalRunStatus } from '~/lib/tests/types';

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.NAVIGATION_SIDEBAR_TESTS,
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
  // Confidence gate only applies to full-mode agent runs, and only when there is at least one
  // judgment-provenance item to average — a run with zero `validator_judged` items (e.g.
  // `useValidator` never enabled) must not silently pass or fail this gate on an empty population.
  const confidence_ok =
    run.run_mode === 'full' && avg_confidence !== null && confidence_population !== 'none'
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
  });
}
