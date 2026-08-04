import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

import { authOptions } from '~/lib/auth';
import {
  buildPromptAnalysisPayload,
  normalizePromptInsights,
  PROMPT_INSIGHT_SYSTEM_PROMPT,
  promptInsightsResponseSchema,
} from '~/lib/observability/prompt-insights';
import { getWorkflowRunTrace } from '~/lib/observability/runs-repository';
import { getOpenAIClient } from '~/lib/openai/client';

/**
 * Single-prompt AI analysis for the Prompt Observability trace page (epic B0-330).
 *
 * Mirrors `/api/admin/tests/runs/[runId]/insights` in response contract
 * (`{ ok, insights, generatedAt }`) so the UI panels stay interchangeable, but
 * reasons over ONE prompt's trace. POST only: results are not persisted, so
 * there is nothing for a GET to read back.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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

  const openai = getOpenAIClient();
  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: PROMPT_INSIGHT_SYSTEM_PROMPT },
      { role: 'user', content: buildPromptAnalysisPayload(trace) },
    ],
    temperature: 0.3,
    max_tokens: 1200,
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { error: 'Failed to parse analysis response.' },
      { status: 500 },
    );
  }

  const parsed = promptInsightsResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Unexpected analysis response shape.', issues: parsed.error.issues },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    insights: normalizePromptInsights(parsed.data.insights),
    generatedAt: new Date().toISOString(),
  });
}
