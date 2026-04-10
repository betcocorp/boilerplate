import { NextResponse } from 'next/server';

import { canPostBexChat } from '~/lib/api/bex-api-auth';
import { bexChatPostBodySchema } from '~/lib/conversations/conversation-schemas';
import { runBexChatTurn } from '~/lib/bex/run-chat-turn';
import { logInfo } from '~/lib/observability/logger';
import { newCorrelationId } from '~/lib/observability/correlation-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: unknown = {};

  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (!canPostBexChat(request, body)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = bexChatPostBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const traceId = newCorrelationId();
  logInfo('request_received', {
    trace_id: traceId,
    route: 'POST /api/bex/chat',
    hasConversationId: Boolean(parsed.data.conversationId),
    useValidator: parsed.data.useValidator ?? false,
    agentMode: parsed.data.agentMode ?? 'orchestrator',
  });

  try {
    const result = await runBexChatTurn({
      conversationId: parsed.data.conversationId,
      message: parsed.data.message,
      modelTag: parsed.data.model,
      useValidator: parsed.data.useValidator ?? false,
      agentMode: parsed.data.agentMode ?? 'orchestrator',
    });

    return NextResponse.json({
      ok: true,
      traceId: result.traceId,
      conversationId: result.conversationId,
      assistant: {
        text: result.answerText,
        sources: result.sources ?? [],
        confidence: result.confidence,
        workflowRunId: result.workflowRunId,
        validation: result.validation,
        latestOpenaiResponseId: result.latestOpenaiResponseId,
        routingDecision: result.routingDecision,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Chat workflow failed.';

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
