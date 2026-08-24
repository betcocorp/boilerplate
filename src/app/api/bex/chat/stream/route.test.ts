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

vi.mock('~/lib/conversations/conversation-owner', () => ({
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

vi.mock('~/lib/settings/settings-service', () => ({
  getBooleanSetting: vi.fn().mockResolvedValue(true),
  getStringSetting: vi.fn().mockResolvedValue('all'),
}));

import { getBooleanSetting } from '~/lib/settings/settings-service';

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

describe('POST /api/bex/chat/stream', () => {
  beforeEach(() => {
    vi.mocked(getBooleanSetting).mockReset().mockResolvedValue(true);
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

  it('returns 404 when streaming is disabled', async () => {
    vi.mocked(getBooleanSetting).mockResolvedValue(false);
    vi.mocked(hasBexSession).mockResolvedValue(true);

    const response = await POST(makeRequest({ message: 'Hi there' }));

    expect(response.status).toBe(404);
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
});
