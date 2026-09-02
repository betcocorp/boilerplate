import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { NextResponse } from 'next/server';

import { type BexChatTurnResult, runBexChatTurn } from '~/lib/bex/run-chat-turn';
import { getBexActor } from '~/lib/api/bex-actor';
import { hasBexSession } from '~/lib/api/bex-api-auth';
import { writeAuditLog } from '~/lib/audit/audit-log';
import { resolveConversationOwnerUserId } from '~/lib/conversations/conversation-owner';
import { getConversationById } from '~/lib/conversations/conversation-repository';
import { bexChatPostBodySchema } from '~/lib/conversations/conversation-schemas';
import { newCorrelationId } from '~/lib/observability/correlation-id';
import { logInfo } from '~/lib/observability/logger';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * B0-68 — streaming is unconditional. The transitional rollout gates
 * (`BEX_AI_SDK_STREAMING_ENABLED`, `BEX_AI_SDK_STREAMING_ROLLOUT_MODE` and the
 * `x-bex-streaming-cohort` header they read) are retired: this is the only Bex chat transport
 * (`/api/bex/chat` is a permanent 410), so a disabled/out-of-cohort 404 could only ever break the
 * app. `BEX_AI_SDK_GENERATION_ENABLED` is untouched — that one is a permanent runtime selector
 * between the Responses and AI SDK generation loops (B0-378), not a rollout gate.
 */
export async function POST(request: Request) {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.BEX_CHAT_USE,
    'POST /api/bex/chat/stream',
  );
  if (denied) return denied;

  const actor = await getBexActor(request);
  if (!actor) {
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

  // B0-449 — a supplied conversationId must belong to this actor (owner, view-all, or service)
  // before spending a model call on it. A conversationId that does not resolve to any row is not a
  // privacy question (nothing exists to leak) and is left to `runBexChatTurn`, which starts a fresh
  // conversation exactly as it does today when no conversationId is supplied.
  if (parsed.data.conversationId) {
    const existing = await getConversationById(parsed.data.conversationId);
    if (existing) {
      const allowed =
        actor.kind === 'service' ||
        actor.canViewAll ||
        (actor.kind === 'user' && existing.user_id === actor.userId);
      if (!allowed) {
        await writeAuditLog(
          'bex.conversation.access_denied',
          {
            conversationId: parsed.data.conversationId,
            requestedByUserId: actor.kind === 'user' ? actor.userId : null,
            route: 'POST /api/bex/chat/stream',
          },
          { traceId: newCorrelationId() },
        );
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
  }

  // B0-449 — ownership stamping for a brand-new conversation always uses the true authenticated
  // owner (ignoring act-as), never the scoping `actor` above; a service caller gets no owner.
  // Only relevant when no conversationId was supplied — continuing turns never re-stamp an existing
  // conversation (see `runBexChatTurn`'s `owner` param doc).
  const ownerUserId =
    !parsed.data.conversationId && actor.kind === 'user'
      ? await resolveConversationOwnerUserId()
      : null;

  const traceId = newCorrelationId();
  logInfo('request_received', {
    trace_id: traceId,
    route: 'POST /api/bex/chat/stream',
    hasConversationId: Boolean(parsed.data.conversationId),
    useValidator: parsed.data.useValidator ?? false,
    agentMode: parsed.data.agentMode ?? 'orchestrator',
  });

  const requestStartedAtMs = Date.now();
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: async ({ writer }) => {
        const textId = `assistant-${traceId}`;
        let firstTokenAtMs: number | null = null;
        /**
         * B0-66 — count of REAL model token deltas seen on this turn. Never incremented by the
         * single-delta emission below, so `deltaCount === 0` on a completed turn is an honest
         * "this answer was not model-generated text" signal (it replaces the removed
         * `usedFallbackChunking` metric, which said the same thing less precisely).
         */
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

        let result: BexChatTurnResult | null = null;
        try {
          result = await runBexChatTurn({
            conversationId: parsed.data.conversationId,
            message: parsed.data.message,
            source: 'bex_chat',
            modelTag: parsed.data.model,
            useValidator: parsed.data.useValidator ?? false,
            agentMode: parsed.data.agentMode ?? 'orchestrator',
            owner: ownerUserId ? { kind: 'user', userId: ownerUserId } : undefined,
            onWorkflowEvent: (event) => {
              writer.write({
                type: 'data-bex-event',
                data: event,
              });
            },
            onAssistantDelta: (delta) => {
              deltaCount += 1;
              if (firstTokenAtMs === null) {
                firstTokenAtMs = Date.now();
              }
              writer.write({ type: 'text-delta', id: textId, delta });
            },
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
          const streamMetrics = {
            totalMs: failedAtMs - requestStartedAtMs,
            timeToFirstTokenMs:
              firstTokenAtMs === null ? null : firstTokenAtMs - requestStartedAtMs,
            deltaCount,
          };
          writer.write({
            type: 'data-bex-meta',
            data: {
              traceId,
              conversationId: parsed.data.conversationId ?? '',
              streamMetrics,
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
          return;
        }

        const completedAtMs = Date.now();
        const streamMetrics = {
          totalMs: completedAtMs - requestStartedAtMs,
          timeToFirstTokenMs:
            firstTokenAtMs === null ? null : firstTokenAtMs - requestStartedAtMs,
          deltaCount,
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

        /**
         * B0-66 — the 120-char `chunkText` fake stream is gone. Some answer paths legitimately
         * produce final text that no model ever emitted a token for, so there is nothing to
         * stream: the pre-model early-decline gate, the regulated-claim guardrail, the
         * usage/safety-coverage fallback, the generic validator fallback, and the
         * cross-reference/recommendation decline copy all REPLACE the answer with canned text.
         * For those, emit the text once so the client still renders something rather than
         * simulating tokens that never existed. `deltaCount` stays 0 on those turns, which is
         * what makes it a truthful "no real token streaming" signal.
         */
        if (deltaCount === 0 && result.answerText) {
          writer.write({
            type: 'text-delta',
            id: textId,
            delta: result.answerText,
          });
        }
        writer.write({ type: 'text-end', id: textId });
        logInfo('stream_response_completed', {
          trace_id: traceId,
          route: 'POST /api/bex/chat/stream',
          conversationId: result.conversationId,
          ...streamMetrics,
        });
      },
    }),
  });
}
