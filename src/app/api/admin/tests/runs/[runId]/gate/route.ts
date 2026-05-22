import { NextResponse } from 'next/server';

import {
  computeAvgSimilarityForResult,
  getTestById,
  getTestResultById,
} from '~/lib/tests/repository';
import { isTerminalRunStatus } from '~/lib/tests/types';

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
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
  const avg_confidence = run.avg_confidence ?? null;

  const similarity_floor = test.similarity_floor;
  const confidence_floor = test.confidence_floor;

  const similarity_ok = avg_similarity !== null ? avg_similarity >= similarity_floor : null;
  // Confidence gate only applies to full-mode agent runs.
  const confidence_ok =
    run.run_mode === 'full' && avg_confidence !== null
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
  });
}
