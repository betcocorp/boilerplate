import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

import {
  listAiSuggestions,
  replaceAiSuggestions,
} from '~/lib/ai-suggestions/repository';
import { authOptions } from '~/lib/auth';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';
import {
  getHarnessContextForRun,
  type HarnessRunContext,
} from '~/lib/observability/harness-linkage';
import { logWarn } from '~/lib/observability/logger';
import {
  buildPromptAnalysisPayload,
  buildPromptInsightSystemPrompt,
  normalizePromptInsights,
  parseStoredPromptInsights,
  PROMPT_INSIGHT_ENTITY_TYPE,
  PROMPT_INSIGHT_MODEL,
  promptInsightsResponseSchema,
  toStoredPromptInsights,
  type PromptGradingContext,
  type PromptInsight,
  type WorkflowRunTrace,
} from '~/lib/observability/prompt-insights';
import { getWorkflowRunTrace } from '~/lib/observability/runs-repository';
import { getOpenAIClient } from '~/lib/openai/client';

/**
 * Single-prompt AI analysis for the Prompt Observability trace page (epic B0-330).
 *
 * Mirrors `/api/admin/tests/runs/[runId]/insights` in response contract
 * (`{ ok, insights, generatedAt }`) so the two UI panels stay interchangeable, but
 * reasons over ONE prompt's trace.
 *
 * B0-420:
 *  - **GET** reads the persisted set out of `ai_suggestions` (scope `workflow_run`)
 *    with no model call. A completed run is immutable, so the previous POST-only
 *    design re-billed `gpt-4.1-mini` over identical input on every panel open.
 *  - **POST** regenerates and persists.
 *  - The route resolves the harness linkage itself, server-side. Grading context is
 *    deliberately NOT threaded through the trace page or the client.
 */

type GeneratedInsights = {
  insights: PromptInsight[];
  generatedAt: string;
};

/** Narrows the harness row to the four fields the analysis is allowed to see. */
function toGradingContext(
  harness: HarnessRunContext | null,
): PromptGradingContext | null {
  return harness
    ? {
        passed: harness.passed,
        expectedShouldAnswer: harness.expectedShouldAnswer,
        idealResponse: harness.idealResponse,
        similarity: harness.similarity,
      }
    : null;
}

/**
 * One model call plus one write. Returns `null` when the model's output cannot be
 * trusted, so the caller decides whether that is a 500 (POST) or a fall-back to the
 * stored set (GET).
 */
async function generateAndPersist(
  runId: string,
  trace: WorkflowRunTrace,
  grading: PromptGradingContext | null,
): Promise<GeneratedInsights | { error: string; issues?: unknown }> {
  const openai = getOpenAIClient();
  const completion = await openai.chat.completions.create({
    model: PROMPT_INSIGHT_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildPromptInsightSystemPrompt(grading) },
      { role: 'user', content: buildPromptAnalysisPayload(trace, grading) },
    ],
    temperature: 0.3,
    max_tokens: 1200,
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { error: 'Failed to parse analysis response.' };
  }

  const parsed = promptInsightsResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      error: 'Unexpected analysis response shape.',
      issues: parsed.error.issues,
    };
  }

  const insights = normalizePromptInsights(parsed.data.insights);

  // A failed write must not lose the insights the user just paid for: return them and
  // let the next open regenerate.
  const saved = await replaceAiSuggestions(
    PROMPT_INSIGHT_ENTITY_TYPE,
    runId,
    toStoredPromptInsights(insights, { gradingContext: grading !== null }),
  ).catch((error: unknown) => {
    logWarn('prompt_insights_persist_failed', {
      runId,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  });

  return {
    insights,
    generatedAt: saved[0]?.created_at ?? new Date().toISOString(),
  };
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.NAVIGATION_SIDEBAR_OBSERVABILITY,
    'POST /api/admin/observability/runs/[runId]/insights',
  );
  if (denied) return denied;

  const { runId } = await context.params;

  const trace = await getWorkflowRunTrace(runId).catch(() => null);
  if (!trace) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  if (trace.timeline.length === 0) {
    return NextResponse.json(
      { error: 'This run has no trace events to analyze.' },
      { status: 422 },
    );
  }

  // Never throws: a live run, or a harness run whose test data was deleted, resolves
  // to null and the analysis behaves exactly as it did before B0-420.
  const grading = toGradingContext(await getHarnessContextForRun(runId));

  const result = await generateAndPersist(runId, trace, grading);
  if ('error' in result) {
    return NextResponse.json(
      { error: result.error, ...(result.issues ? { issues: result.issues } : {}) },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    insights: result.insights,
    generatedAt: result.generatedAt,
  });
}

/**
 * Reads the persisted set. No model call — except in exactly one case: the stored set
 * was generated WITHOUT grading context and the harness linkage now resolves. That
 * happens when a run was triaged before its `test_result_items` row existed (the
 * harness writes the link after the run completes), and serving those trace-only
 * insights forever would silently misrepresent them as grading-aware.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { runId } = await context.params;

  const rows = await listAiSuggestions(PROMPT_INSIGHT_ENTITY_TYPE, runId).catch(
    (error: unknown) => {
      logWarn('prompt_insights_read_failed', {
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    },
  );

  const stored = parseStoredPromptInsights(rows);
  const storedResponse = () =>
    NextResponse.json({
      ok: true,
      insights: stored.insights,
      generatedAt: stored.generatedAt,
    });

  if (stored.insights === null || stored.gradingContext) {
    return storedResponse();
  }

  // Stale set: grading-blind. Refresh it only if there is now something to see.
  const grading = toGradingContext(await getHarnessContextForRun(runId));
  if (!grading) {
    return storedResponse();
  }

  const trace = await getWorkflowRunTrace(runId).catch(() => null);
  if (!trace || trace.timeline.length === 0) {
    return storedResponse();
  }

  // A read must never fail because a refresh could not be produced; the stored set is
  // still better than nothing, and POST remains available.
  const result = await generateAndPersist(runId, trace, grading).catch(
    (error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  if ('error' in result) {
    logWarn('prompt_insights_regenerate_failed', { runId, message: result.error });
    return storedResponse();
  }

  return NextResponse.json({
    ok: true,
    insights: result.insights,
    generatedAt: result.generatedAt,
  });
}
