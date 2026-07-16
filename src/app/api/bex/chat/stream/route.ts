import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { NextResponse } from 'next/server';

import { runBexChatTurn } from '~/lib/bex/run-chat-turn';
import { hasBexSession } from '~/lib/api/bex-api-auth';
import { bexChatPostBodySchema } from '~/lib/conversations/conversation-schemas';
import { newCorrelationId } from '~/lib/observability/correlation-id';
import { logInfo } from '~/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function isStreamingEnabled(): boolean {
  return process.env.BEX_AI_SDK_STREAMING_ENABLED === 'true';
}

function streamingRolloutMode(): 'all' | 'internal' {
  return process.env.BEX_AI_SDK_STREAMING_ROLLOUT_MODE === 'internal'
    ? 'internal'
    : 'all';
}

function isRequestInStreamingCohort(request: Request): boolean {
  const mode = streamingRolloutMode();
  if (mode === 'all') {
    return true;
  }

  return request.headers.get('x-bex-streaming-cohort') === 'internal';
}

function chunkText(input: string, chunkSize = 120): string[] {
  if (!input) {
    return [];
  }

  const chunks: string[] = [];
  for (let index = 0; index < input.length; index += chunkSize) {
    chunks.push(input.slice(index, index + chunkSize));
  }
  return chunks;
}

export async function POST(request: Request) {
  if (!isStreamingEnabled()) {
    return NextResponse.json(
      { error: 'Streaming endpoint is disabled.' },
      { status: 404 },
    );
  }
  if (!isRequestInStreamingCohort(request)) {
    return NextResponse.json(
      { error: 'Streaming rollout cohort does not include this request.' },
      { status: 404 },
    );
  }

  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
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
    route: 'POST /api/bex/chat/stream',
    rollout_mode: streamingRolloutMode(),
    rollout_cohort: request.headers.get('x-bex-streaming-cohort') ?? 'none',
    hasConversationId: Boolean(parsed.data.conversationId),
    useValidator: parsed.data.useValidator ?? false,
    agentMode: parsed.data.agentMode ?? 'orchestrator',
  });

  const requestStartedAtMs = Date.now();
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: async ({ writer }) => {
        const textId = `assistant-${traceId}`;
        let hasAssistantDelta = false;
        let firstTokenAtMs: number | null = null;
        let deltaCount = 0;

        writer.write({
          type: 'data-bex-event',
          data: {
            type: 'status',
            stage: 'request_started',
            traceId,
          },
        });
        writer.write({ type: 'text-start', id: textId });

        try {
          const result = await runBexChatTurn({
            conversationId: parsed.data.conversationId,
            message: parsed.data.message,
            modelTag: parsed.data.model,
            useValidator: parsed.data.useValidator ?? false,
            agentMode: parsed.data.agentMode ?? 'orchestrator',
            onWorkflowEvent: (event) => {
              writer.write({
                type: 'data-bex-event',
                data: event,
              });
            },
            onAssistantDelta: (delta) => {
              hasAssistantDelta = true;
              deltaCount += 1;
              if (firstTokenAtMs === null) {
                firstTokenAtMs = Date.now();
              }
              writer.write({ type: 'text-delta', id: textId, delta });
            },
          });
          const completedAtMs = Date.now();
          const streamMetrics = {
            totalMs: completedAtMs - requestStartedAtMs,
            timeToFirstTokenMs:
              firstTokenAtMs === null ? null : firstTokenAtMs - requestStartedAtMs,
            deltaCount,
            usedFallbackChunking: !hasAssistantDelta,
          };

          writer.write({
            type: 'data-bex-meta',
            data: {
              traceId: result.traceId,
              conversationId: result.conversationId,
              workflowRunId: result.workflowRunId,
              latestOpenaiResponseId: result.latestOpenaiResponseId,
              routingDecision: result.routingDecision,
              streamMetrics,
            },
          });

          if (!hasAssistantDelta) {
            const chunks = chunkText(result.answerText);
            for (const chunk of chunks) {
              writer.write({ type: 'text-delta', id: textId, delta: chunk });
            }
          }
          writer.write({ type: 'text-end', id: textId });
          logInfo('stream_response_completed', {
            trace_id: traceId,
            route: 'POST /api/bex/chat/stream',
            conversationId: result.conversationId,
            ...streamMetrics,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Chat workflow failed.';
          const failedAtMs = Date.now();
          writer.write({
            type: 'data-bex-event',
            data: {
              type: 'status',
              stage: 'request_failed',
              error: message,
            },
          });
          writer.write({ type: 'text-end', id: textId });
          logInfo('stream_response_failed', {
            trace_id: traceId,
            route: 'POST /api/bex/chat/stream',
            error: message,
            totalMs: failedAtMs - requestStartedAtMs,
            timeToFirstTokenMs:
              firstTokenAtMs === null ? null : firstTokenAtMs - requestStartedAtMs,
            deltaCount,
          });
          throw error;
        }
      },
    }),
  });
}
