import { beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '~/app/api/bex/chat/stream/route';
import { getBexActor } from '~/lib/api/bex-actor';
import { hasBexSession } from '~/lib/api/bex-api-auth';
import { writeAuditLog } from '~/lib/audit/audit-log';
import { runBexChatTurn } from '~/lib/bex/run-chat-turn';
import { resolveConversationOwnerUserId } from '~/lib/conversations/conversation-owner';
import { getConversationById } from '~/lib/conversations/conversation-repository';

vi.mock('~/lib/api/bex-api-auth', () => ({
  hasBexSession: vi.fn(),
}));

vi.mock('~/lib/api/bex-actor', () => ({
  getBexActor: vi.fn(),
}));

vi.mock('~/lib/conversations/conversation-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/conversations/conversation-owner')>()),
  resolveConversationOwnerUserId: vi.fn(),
}));

vi.mock('~/lib/conversations/conversation-repository', () => ({
  getConversationById: vi.fn(),
}));

vi.mock('~/lib/audit/audit-log', () => ({
  writeAuditLog: vi.fn(),
}));

vi.mock('~/lib/bex/run-chat-turn', () => ({
  runBexChatTurn: vi.fn(),
}));

vi.mock('~/lib/observability/logger', () => ({
  logInfo: vi.fn(),
}));

// The route's permission gate (B0-408) is covered by `src/lib/permissions/require-permission.test.ts`;
// here it stands in as a pass-through so these tests stay about the streaming handler itself. It
// cannot run for real outside a request scope (it reads the session from `headers()`).
vi.mock('~/lib/permissions/route-gate', () => ({
  gateRoute: vi.fn().mockResolvedValue(null),
}));

vi.mock('~/lib/observability/correlation-id', () => ({
  newCorrelationId: () => 'trace-test-1',
}));

// B0-68 — the route reads no settings at all now (the streaming enable/rollout-mode gates are
// retired), so there is deliberately no settings-service mock here.

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/bex/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readResponseBody(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}

/** Every `text-delta` frame in the SSE body, in order, as it was written by the route. */
function collectTextDeltas(body: string): string[] {
  const deltas: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as { type?: unknown; delta?: unknown };
      if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') {
        deltas.push(chunk.delta);
      }
    } catch {
      /* ignore non-JSON frames */
    }
  }
  return deltas;
}

/** The `streamMetrics` object off the `data-bex-meta` frame, or null if none was written. */
function readStreamMetrics(body: string): Record<string, unknown> | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as { type?: unknown; data?: unknown };
      if (chunk.type === 'data-bex-meta') {
        const data = chunk.data as { streamMetrics?: Record<string, unknown> };
        return data?.streamMetrics ?? null;
      }
    } catch {
      /* ignore non-JSON frames */
    }
  }
  return null;
}

describe('POST /api/bex/chat/stream', () => {
  beforeEach(() => {
    vi.mocked(hasBexSession).mockReset();
    vi.mocked(runBexChatTurn).mockReset();
    vi.mocked(getBexActor).mockReset();
    vi.mocked(getConversationById).mockReset();
    vi.mocked(resolveConversationOwnerUserId).mockReset();
    vi.mocked(writeAuditLog).mockReset();

    // Default: a plain non-view-all user, no conversation on file.
    vi.mocked(getBexActor).mockResolvedValue({ kind: 'user', userId: 'user-1', canViewAll: false });
    vi.mocked(getConversationById).mockResolvedValue(null);
    vi.mocked(resolveConversationOwnerUserId).mockResolvedValue('user-1');
    vi.mocked(writeAuditLog).mockResolvedValue(undefined);
  });

  // B0-68 — streaming is unconditional: there is no enable flag and no rollout cohort left, so an
  // authenticated request is never turned away with a 404. The retired `x-bex-streaming-cohort`
  // header is now just an unread request header.
  it('serves a request that sends no streaming cohort header', async () => {
    vi.mocked(hasBexSession).mockResolvedValue(true);
    vi.mocked(runBexChatTurn).mockResolvedValue({
      traceId: 'trace-test-1',
      conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
      answerText: 'Hello from stream output.',
      routingDecision: 'orchestrator',
      confidence: 0.92,
      sources: [],
    } as never);

    const response = await POST(makeRequest({ message: 'Hi there' }));

    expect(response.status).toBe(200);
    expect(runBexChatTurn).toHaveBeenCalled();
  });

  it('returns 401 when auth fails', async () => {
    vi.mocked(hasBexSession).mockResolvedValue(false);

    const response = await POST(makeRequest({ message: 'Hi there' }));

    expect(response.status).toBe(401);
  });

  it('returns 401 when there is a session but no resolvable actor', async () => {
    vi.mocked(hasBexSession).mockResolvedValue(true);
    vi.mocked(getBexActor).mockResolvedValue(null);

    const response = await POST(makeRequest({ message: 'Hi there' }));

    expect(response.status).toBe(401);
    expect(runBexChatTurn).not.toHaveBeenCalled();
  });

  it('returns 400 when request body is invalid', async () => {
    vi.mocked(hasBexSession).mockResolvedValue(true);

    const response = await POST(makeRequest({}));

    expect(response.status).toBe(400);
  });

  it('returns 403 and audits the denial when the conversation belongs to a different user', async () => {
    vi.mocked(hasBexSession).mockResolvedValue(true);
    vi.mocked(getBexActor).mockResolvedValue({ kind: 'user', userId: 'user-1', canViewAll: false });
    vi.mocked(getConversationById).mockResolvedValue({
      id: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
      user_id: 'someone-else',
    } as never);

    const response = await POST(
      makeRequest({
        message: 'Hello',
        conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
      }),
    );

    expect(response.status).toBe(403);
    expect(runBexChatTurn).not.toHaveBeenCalled();
    expect(writeAuditLog).toHaveBeenCalledWith(
      'bex.conversation.access_denied',
      expect.objectContaining({
        conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
        requestedByUserId: 'user-1',
      }),
      expect.anything(),
    );
  });

  it('allows an it-admin to continue an act-as-created conversation via the true-owner fallback (B0-841)', async () => {
    // The admin is acting-as user-2 (actor.userId is the acted-as user), but the conversation was
    // stamped with the true admin id per resolveConversationOwnerUserId's act-as-blind stamping.
    vi.mocked(hasBexSession).mockResolvedValue(true);
    vi.mocked(getBexActor).mockResolvedValue({ kind: 'user', userId: 'user-2', canViewAll: false });
    vi.mocked(getConversationById).mockResolvedValue({
      id: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
      user_id: 'admin-true-1',
    } as never);
    vi.mocked(resolveConversationOwnerUserId).mockResolvedValue('admin-true-1');
    vi.mocked(runBexChatTurn).mockResolvedValue({
      traceId: 'trace-test-1',
      conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
      answerText: 'Hello from stream output.',
      routingDecision: 'orchestrator',
      confidence: 0.92,
      sources: [],
    } as never);

    const response = await POST(
      makeRequest({
        message: 'Hello',
        conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
      }),
    );

    expect(response.status).toBe(200);
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(runBexChatTurn).toHaveBeenCalled();
    // Only resolved once for the whole request, reused for both the access check and (were this a
    // fresh conversation) the stamping branch — not called twice.
    expect(resolveConversationOwnerUserId).toHaveBeenCalledTimes(1);
  });

  it('allows a service actor to continue any conversation without an ownership check', async () => {
    // This route's own auth check (above `getBexActor`) is session-only today — the bex UI never
    // sends a service bearer here (that path is `/api/v1/orchestrator`) — so this exercises the
    // downstream service-bypass logic in isolation via a mocked actor, per the AC that the
    // ownership check must not apply to a service actor wherever one is resolved.
    vi.mocked(hasBexSession).mockResolvedValue(true);
    vi.mocked(getBexActor).mockResolvedValue({ kind: 'service' });
    vi.mocked(getConversationById).mockResolvedValue({
      id: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
      user_id: 'someone-else',
    } as never);
    vi.mocked(runBexChatTurn).mockResolvedValue({
      traceId: 'trace-test-1',
      conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
      answerText: 'Hello from stream output.',
      workflowRunId: 'f9dc4fb8-a4ce-4b81-8ce8-f4f7f9f16dea',
      latestOpenaiResponseId: 'resp_123',
      routingDecision: 'orchestrator',
      timingBreakdown: { toolRounds: 1, cacheSource: null, searchMs: null },
      confidence: 0.92,
      sources: [],
    } as never);

    const response = await POST(
      makeRequest({
        message: 'Hello',
        conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
      }),
    );

    expect(response.status).toBe(200);
    // Service actors never resolve an owner — no session to look up.
    expect(resolveConversationOwnerUserId).not.toHaveBeenCalled();
    expect(runBexChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ owner: undefined }),
    );
  });

  it('B0-1084 — stamps a fresh act-as conversation to the acted-as user, recording the true admin', async () => {
    vi.mocked(hasBexSession).mockResolvedValue(true);
    vi.mocked(getBexActor).mockResolvedValue({
      kind: 'user',
      userId: 'acted-as-1',
      canViewAll: false,
    });
    vi.mocked(resolveConversationOwnerUserId).mockResolvedValue('admin-true-1');
    vi.mocked(runBexChatTurn).mockResolvedValue({
      traceId: 'trace-test-1',
      conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
      answerText: 'ok',
      workflowRunId: 'f9dc4fb8-a4ce-4b81-8ce8-f4f7f9f16dea',
      latestOpenaiResponseId: 'resp_123',
      routingDecision: 'orchestrator',
      timingBreakdown: { toolRounds: 1, cacheSource: null, searchMs: null },
      confidence: 0.92,
      sources: [],
    } as never);

    const response = await POST(makeRequest({ message: 'Hello' }));
    await response.text();

    expect(response.status).toBe(200);
    expect(runBexChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { kind: 'user', userId: 'acted-as-1', actedByUserId: 'admin-true-1' },
      }),
    );
  });

  it('returns a UI message stream response when valid', async () => {
    vi.mocked(hasBexSession).mockResolvedValue(true);
    vi.mocked(runBexChatTurn).mockResolvedValue({
      traceId: 'trace-test-1',
      conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
      answerText: 'Hello from stream output.',
      workflowRunId: 'f9dc4fb8-a4ce-4b81-8ce8-f4f7f9f16dea',
      latestOpenaiResponseId: 'resp_123',
      validation: {
        approved: true,
        confidence: 0.92,
        issues: [],
        requires_human_review: false,
      },
      routingDecision: 'orchestrator',
      timingBreakdown: {
        toolRounds: 1,
        cacheSource: null,
        searchMs: null,
      },
      confidence: 0.92,
      sources: [],
    });

    const response = await POST(
      makeRequest({
        message: 'Hello',
        conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
      }),
    );

    const body = await readResponseBody(response);

    expect(response.status).toBe(200);
    expect(body).toContain('"type":"data-bex-meta"');
    expect(body).toContain('"type":"text-delta"');
    expect(body).toContain('Hello from stream output.');
  });

  /**
   * B0-66 — the 120-char `chunkText` fake stream is gone. These assert the two real shapes:
   * a model-generated answer streams the model's OWN deltas verbatim, and an answer with no
   * model tokens at all (early-decline gate, regulated-claim guardrail, usage/safety fallback,
   * validator fallback, cross-reference decline) is emitted as exactly one delta — never
   * re-sliced into fixed-width pieces.
   */
  describe('token streaming (B0-66)', () => {
    // Longer than the retired 120-char chunk size, so a reintroduced slicer would show up as
    // extra delta frames instead of the single frame asserted below.
    const LONG_CANNED_ANSWER =
      'I can’t verify the dilution ratio in this answer against an exact quote from a retrieved label or SDS, so I won’t state it. Please consult the product label or SDS directly.';

    it('forwards real model token deltas verbatim, one frame per delta', async () => {
      vi.mocked(hasBexSession).mockResolvedValue(true);
      const modelDeltas = ['Dilute ', 'pH7Q Dual ', 'at 1:64.'];
      vi.mocked(runBexChatTurn).mockImplementation(async (input) => {
        for (const delta of modelDeltas) {
          input.onAssistantDelta?.(delta);
        }
        return {
          traceId: 'trace-test-1',
          conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
          answerText: modelDeltas.join(''),
          workflowRunId: 'f9dc4fb8-a4ce-4b81-8ce8-f4f7f9f16dea',
          latestOpenaiResponseId: 'resp_123',
          routingDecision: 'orchestrator',
          timingBreakdown: { toolRounds: 1, cacheSource: null, searchMs: null },
          confidence: 0.92,
          sources: [],
        } as never;
      });

      const response = await POST(makeRequest({ message: 'Hello' }));
      const body = await readResponseBody(response);

      expect(response.status).toBe(200);
      // Exactly the model's deltas — no trailing re-emission of the final answer on top.
      expect(collectTextDeltas(body)).toEqual(modelDeltas);
      expect(readStreamMetrics(body)).toMatchObject({ deltaCount: 3 });
    });

    it('emits a non-model answer as a single delta and reports deltaCount 0', async () => {
      vi.mocked(hasBexSession).mockResolvedValue(true);
      vi.mocked(runBexChatTurn).mockResolvedValue({
        traceId: 'trace-test-1',
        conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
        answerText: LONG_CANNED_ANSWER,
        workflowRunId: 'f9dc4fb8-a4ce-4b81-8ce8-f4f7f9f16dea',
        latestOpenaiResponseId: null,
        routingDecision: 'orchestrator',
        timingBreakdown: { toolRounds: 0, cacheSource: null, searchMs: null },
        confidence: 0.92,
        sources: [],
      } as never);

      const response = await POST(makeRequest({ message: 'Hello' }));
      const body = await readResponseBody(response);
      const deltas = collectTextDeltas(body);

      expect(response.status).toBe(200);
      expect(deltas).toEqual([LONG_CANNED_ANSWER]);
      // `deltaCount` counts REAL model deltas only, so it stays 0 here — that is the honest
      // successor to the removed `usedFallbackChunking` flag.
      expect(readStreamMetrics(body)).toMatchObject({ deltaCount: 0 });
    });

    it('no longer reports the removed usedFallbackChunking metric', async () => {
      vi.mocked(hasBexSession).mockResolvedValue(true);
      vi.mocked(runBexChatTurn).mockResolvedValue({
        traceId: 'trace-test-1',
        conversationId: '7ad779f1-2af3-4a82-ae68-bf1372f6cd99',
        answerText: LONG_CANNED_ANSWER,
        routingDecision: 'orchestrator',
        confidence: 0.92,
        sources: [],
      } as never);

      const body = await readResponseBody(await POST(makeRequest({ message: 'Hello' })));

      expect(body).not.toContain('usedFallbackChunking');
      expect(readStreamMetrics(body)).not.toHaveProperty('usedFallbackChunking');
    });

    it('emits no text delta when a failing turn produced no answer', async () => {
      vi.mocked(hasBexSession).mockResolvedValue(true);
      vi.mocked(runBexChatTurn).mockRejectedValue(new Error('workflow exploded'));

      const response = await POST(makeRequest({ message: 'Hello' }));
      const body = await readResponseBody(response);

      expect(response.status).toBe(200);
      expect(collectTextDeltas(body)).toEqual([]);
      expect(body).toContain('"stage":"request_failed"');
      expect(readStreamMetrics(body)).toMatchObject({ deltaCount: 0 });
    });
  });
});
