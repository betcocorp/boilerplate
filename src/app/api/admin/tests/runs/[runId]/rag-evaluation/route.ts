import { after } from 'next/server';
import { NextResponse } from 'next/server';

export const maxDuration = 300;

import { authorizeAdminTestsRoute } from '~/lib/api/admin-tests-auth';
import { logWarn } from '~/lib/observability/logger';
import { ragEvaluationPostBodySchema } from '~/lib/tests/rag-evaluation/api-schema';
import {
  evaluateAndPersistRagRun,
  isRagEvaluationEligible,
} from '~/lib/tests/rag-evaluation/evaluate-run';
import {
  getRagEvaluation,
  queueRagEvaluation,
} from '~/lib/tests/rag-evaluation/persistence';

function publicEvaluation(evaluation: Awaited<ReturnType<typeof getRagEvaluation>>) {
  if (!evaluation) return null;
  return {
    testResultId: evaluation.test_result_id,
    status: evaluation.status,
    error: evaluation.error_message,
    completedAt: evaluation.completed_at,
    coverage: evaluation.snapshot?.coverage ?? null,
    labelling: evaluation.snapshot?.labelling ?? null,
    aggregates: evaluation.snapshot?.aggregates ?? [],
    episodes: evaluation.status === 'ready' ? (evaluation.snapshot?.episodes ?? []) : [],
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const denied = await authorizeAdminTestsRoute(
    request,
    'GET /api/admin/tests/runs/[runId]/rag-evaluation',
  );
  if (denied) return denied;

  const { runId } = await context.params;
  const [evaluation, eligibility] = await Promise.all([
    getRagEvaluation(runId),
    isRagEvaluationEligible(runId),
  ]);
  return NextResponse.json({
    ok: true,
    runId,
    eligible: eligibility.eligible,
    ineligibleReason: eligibility.reason,
    evaluation: publicEvaluation(evaluation),
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const denied = await authorizeAdminTestsRoute(
    request,
    'POST /api/admin/tests/runs/[runId]/rag-evaluation',
  );
  if (denied) return denied;

  const { runId } = await context.params;
  const parsedBody = ragEvaluationPostBodySchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: 'Invalid request body.', issues: parsedBody.error.issues },
      { status: 400 },
    );
  }
  const force = parsedBody.data.action === 'recompute';
  const eligibility = await isRagEvaluationEligible(runId);
  if (!eligibility.eligible) {
    return NextResponse.json(
      { error: 'Run is not eligible for RAG evaluation.', reason: eligibility.reason },
      { status: 409 },
    );
  }

  const queued = await queueRagEvaluation(runId, { force });
  if (queued.status === 'ready' && !force) {
    return NextResponse.json({ ok: true, runId, state: 'ready' });
  }
  if (queued.status === 'running' && !force) {
    return NextResponse.json({ ok: true, runId, state: 'running' }, { status: 202 });
  }

  after(async () => {
    try {
      await evaluateAndPersistRagRun(runId);
    } catch (error) {
      logWarn('test_run_rag_evaluation_error', {
        testResultId: runId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return NextResponse.json({ ok: true, runId, state: 'scheduled' }, { status: 202 });
}
