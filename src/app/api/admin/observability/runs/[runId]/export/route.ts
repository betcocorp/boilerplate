import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { authOptions } from '~/lib/auth';
import { getWorkflowRunTrace } from '~/lib/observability/runs-repository';

import type { TimelineEvent } from '~/types/observability';

/**
 * Full-fidelity JSON export of one workflow run's trace (epic B0-330), for
 * offline analysis.
 *
 * Unlike the trace page — which renders previews and folds tool traces into the
 * timeline — this returns the raw `workflow_runs` / `workflow_steps` /
 * `audit_logs` rows alongside the assembled timeline, so nothing is lost to
 * formatting. Session-gated like the sibling insights route.
 *
 * Prompt insights are NOT included here: they are generated on demand and never
 * persisted (see `~/lib/observability/prompt-insights`). The download button
 * merges whatever the browser currently holds into `promptInsights`.
 */

export const EXPORT_FORMAT = 'bex.observability.run-trace.v1';

function durationMsBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  const delta = end - start;
  return delta >= 0 ? delta : null;
}

export async function GET(
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

  const { run, steps, auditLogs, timeline } = trace;

  const toolCalls = timeline.filter(
    (event): event is Extract<TimelineEvent, { kind: 'tool_call' }> =>
      event.kind === 'tool_call',
  );

  return NextResponse.json({
    exportFormat: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    runId,
    // Filled in client-side from the AI-analysis panel; null when nothing has
    // been generated for this run in the current browser session.
    promptInsights: null,
    summary: {
      status: run.status,
      workflowName: run.workflow_name,
      confidence: run.confidence,
      // Wall-clock for the whole run. NOTE: step and tool-call durations are
      // NESTED inside it (a tool call runs *within* its step), so they do not
      // sum to this number.
      totalDurationMs: durationMsBetween(run.created_at, run.updated_at),
      stepCount: steps.length,
      auditLogCount: auditLogs.length,
      timelineEventCount: timeline.length,
      toolCallCount: toolCalls.length,
      // B0-417 — strictly `false`: a reconstructed call that never settled has
      // `ok === null` (outcome unknown) and is not a failure.
      failedToolCallCount: toolCalls.filter((event) => event.ok === false).length,
    },
    run,
    steps,
    auditLogs,
    timeline,
  });
}
