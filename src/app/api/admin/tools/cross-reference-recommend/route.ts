import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { APP_VERSION } from '~/lib/app-version';
import { authOptions } from '~/lib/auth';
import { createConversation } from '~/lib/conversations/conversation-repository';
import { insertWorkflowRun, updateWorkflowRun } from '~/lib/conversations/workflow-repository';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';
import { runCrossReferenceRecommendation } from '~/lib/recommendations/persist-recommendation';
import { recommendCrossReferenceInputSchema } from '~/lib/tools/tool-schemas';
import { getErrorMessage } from '~/lib/utils';
import { PROMPT_BUNDLE_VERSION } from '~/lib/workflows/product-support/prompt-version';

export const runtime = 'nodejs';

/**
 * B0-94 — admin tester endpoint for the web-grounded cross-reference recommendation. Session-auth'd
 * (same NextAuth pattern as the other admin tool routes); computes + persists the recommendation
 * (B0-89) and returns the result with its `recommendationId`.
 */
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.NAVIGATION_SIDEBAR_TOOLS,
    'POST /api/admin/tools/cross-reference-recommend',
  );
  if (denied) return denied;

  const raw = await request.json().catch(() => null);
  const parsed = recommendCrossReferenceInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  /**
   * B0-1056 — this manual admin tester used to persist recommendations under a bare correlation
   * id with nothing in `workflow_runs` for it to match, so its trace link 404'd. Creates a real
   * `agent_conversations` + `workflow_runs` row up front (same `source: 'test_run'` convention the
   * `/api/v1/agents/*` server-to-server callers use) so `traceId` is a genuine `workflow_runs.id`.
   */
  const conversation = await createConversation({ user_id: null, source: 'test_run' });
  const run = await insertWorkflowRun({
    conversation_id: conversation.id,
    workflow_name: 'cross-reference-recommendation',
    status: 'running',
    source: 'orchestrator_api',
    app_version: APP_VERSION,
    prompt_bundle_version: PROMPT_BUNDLE_VERSION,
    user_input: {
      competitorProduct: parsed.data.competitorProduct,
      competitorBrand: parsed.data.competitorBrand ?? null,
    },
  });
  const traceId = run.id;
  try {
    const result = await runCrossReferenceRecommendation(
      {
        competitorProduct: parsed.data.competitorProduct,
        competitorBrand: parsed.data.competitorBrand ?? null,
      },
      { traceId, createdBy: session.user.email ?? 'admin' },
    );

    await updateWorkflowRun(run.id, {
      status: 'completed',
      confidence: result.overallConfidence,
      final_output: {
        status: result.status,
        answered: result.answered,
        recommendationId: result.recommendationId,
      },
    });

    const maxResults = parsed.data.maxResults ?? 5;
    return NextResponse.json({
      ok: true,
      ...result,
      candidates: result.candidates.slice(0, maxResults),
    });
  } catch (err) {
    await updateWorkflowRun(run.id, {
      status: 'failed',
      final_output: { error: getErrorMessage(err, 'Cross-reference recommendation failed') },
    }).catch(() => undefined);
    return NextResponse.json(
      { error: getErrorMessage(err, 'Cross-reference recommendation failed') },
      { status: 500 },
    );
  }
}
