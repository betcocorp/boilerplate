import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DELETE, GET } from '~/app/api/bex/conversations/[id]/route';
import { getBexActor } from '~/lib/api/bex-actor';
import { hasBexSession } from '~/lib/api/bex-api-auth';
import { writeAuditLog } from '~/lib/audit/audit-log';
import { resolveConversationOwnerUserId } from '~/lib/conversations/conversation-owner';
import {
  deleteConversation,
  getConversationById,
  getConversationOwnerInfo,
} from '~/lib/conversations/conversation-repository';
import { listMessageFeedbackForConversation } from '~/lib/conversations/message-feedback-repository';
import { listMessagesForConversation } from '~/lib/conversations/message-repository';
import { gateRoute } from '~/lib/permissions/route-gate';

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
  deleteConversation: vi.fn(),
  getConversationById: vi.fn(),
  getConversationOwnerInfo: vi.fn(),
}));

vi.mock('~/lib/conversations/message-feedback-repository', () => ({
  listMessageFeedbackForConversation: vi.fn(),
}));

vi.mock('~/lib/conversations/message-repository', () => ({
  listMessagesForConversation: vi.fn(),
}));

vi.mock('~/lib/audit/audit-log', () => ({
  writeAuditLog: vi.fn(),
}));

vi.mock('~/lib/permissions/route-gate', () => ({
  gateRoute: vi.fn(),
}));

const CONVERSATION_ID = '7ad779f1-2af3-4a82-ae68-bf1372f6cd99';

function makeRequest(method: 'GET' | 'DELETE' = 'GET') {
  return new Request(`http://localhost/api/bex/conversations/${CONVERSATION_ID}`, { method });
}

function routeContext() {
  return { params: Promise.resolve({ id: CONVERSATION_ID }) };
}

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION_ID,
    title: 'Some conversation',
    updated_at: '2026-08-11T00:00:00.000Z',
    latest_openai_response_id: null,
    latest_model: null,
    status: 'active',
    user_id: 'user-1',
    source: 'chat',
    ...overrides,
  } as never;
}

describe('/api/bex/conversations/[id]', () => {
  beforeEach(() => {
    vi.mocked(hasBexSession).mockReset();
    vi.mocked(getBexActor).mockReset();
    vi.mocked(getConversationById).mockReset();
    vi.mocked(getConversationOwnerInfo).mockReset();
    vi.mocked(deleteConversation).mockReset();
    vi.mocked(listMessagesForConversation).mockReset();
    vi.mocked(listMessageFeedbackForConversation).mockReset();
    vi.mocked(writeAuditLog).mockReset();
    vi.mocked(gateRoute).mockReset();
    vi.mocked(resolveConversationOwnerUserId).mockReset();

    vi.mocked(hasBexSession).mockResolvedValue(true);
    vi.mocked(gateRoute).mockResolvedValue(null);
    vi.mocked(listMessagesForConversation).mockResolvedValue([]);
    vi.mocked(listMessageFeedbackForConversation).mockResolvedValue([]);
    vi.mocked(writeAuditLog).mockResolvedValue(undefined);
    vi.mocked(deleteConversation).mockResolvedValue(undefined);
    vi.mocked(getConversationOwnerInfo).mockResolvedValue({
      ownerName: 'Owner One',
      ownerEmail: 'owner1@betco.com',
    });
    // Default: no true-owner fallback available (matches most existing scenarios below, where the
    // actor's own userId is what's under test).
    vi.mocked(resolveConversationOwnerUserId).mockResolvedValue(null);
  });

  describe('GET', () => {
    it('returns 401 with no session', async () => {
      vi.mocked(hasBexSession).mockResolvedValue(false);

      const response = await GET(makeRequest(), routeContext());

      expect(response.status).toBe(401);
    });

    it('returns 401 when no actor resolves', async () => {
      vi.mocked(getBexActor).mockResolvedValue(null);

      const response = await GET(makeRequest(), routeContext());

      expect(response.status).toBe(401);
    });

    it('returns 404 when the conversation does not exist', async () => {
      vi.mocked(getBexActor).mockResolvedValue({ kind: 'user', userId: 'user-1', canViewAll: false });
      vi.mocked(getConversationById).mockResolvedValue(null);

      const response = await GET(makeRequest(), routeContext());

      expect(response.status).toBe(404);
    });

    it('returns 403 and audits a cross-user read for a non-view-all owner mismatch', async () => {
      vi.mocked(getBexActor).mockResolvedValue({ kind: 'user', userId: 'user-2', canViewAll: false });
      vi.mocked(getConversationById).mockResolvedValue(conversation({ user_id: 'user-1' }));

      const response = await GET(makeRequest(), routeContext());

      expect(response.status).toBe(403);
      expect(writeAuditLog).toHaveBeenCalledWith(
        'bex.conversation.access_denied',
        expect.objectContaining({ conversationId: CONVERSATION_ID, requestedByUserId: 'user-2' }),
        expect.anything(),
      );
    });

    it('allows an it-admin to read an act-as-created conversation via the true-owner fallback (B0-841)', async () => {
      // The admin is acting-as user-2 (so actor.userId is the acted-as user), but the
      // conversation was stamped with the true admin id per resolveConversationOwnerUserId's
      // act-as-blind stamping rule.
      vi.mocked(getBexActor).mockResolvedValue({ kind: 'user', userId: 'user-2', canViewAll: false });
      vi.mocked(getConversationById).mockResolvedValue(conversation({ user_id: 'admin-true-1' }));
      vi.mocked(resolveConversationOwnerUserId).mockResolvedValue('admin-true-1');

      const response = await GET(makeRequest(), routeContext());

      expect(response.status).toBe(200);
      expect(writeAuditLog).not.toHaveBeenCalled();
    });

    it('allows the owner to read their own conversation', async () => {
      vi.mocked(getBexActor).mockResolvedValue({ kind: 'user', userId: 'user-1', canViewAll: false });
      vi.mocked(getConversationById).mockResolvedValue(conversation({ user_id: 'user-1' }));

      const response = await GET(makeRequest(), routeContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(writeAuditLog).not.toHaveBeenCalled();
      expect(body.conversation.isOwner).toBe(true);
      expect(body.conversation.owner).toEqual({
        name: 'Owner One',
        email: 'owner1@betco.com',
        userId: 'user-1',
      });
    });

    it('allows a view-all admin to read any conversation and marks isOwner false', async () => {
      vi.mocked(getBexActor).mockResolvedValue({ kind: 'user', userId: 'admin-1', canViewAll: true });
      vi.mocked(getConversationById).mockResolvedValue(conversation({ user_id: 'user-1' }));

      const response = await GET(makeRequest(), routeContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.conversation.isOwner).toBe(false);
      expect(body.conversation.source).toBe('chat');
    });

    it('reports owner "admin" for a test_run conversation and skips the owner-join lookup', async () => {
      vi.mocked(getBexActor).mockResolvedValue({ kind: 'user', userId: 'admin-1', canViewAll: true });
      vi.mocked(getConversationById).mockResolvedValue(
        conversation({ user_id: null, source: 'test_run' }),
      );

      const response = await GET(makeRequest(), routeContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.conversation.owner).toBe('admin');
      expect(body.conversation.source).toBe('test_run');
      expect(getConversationOwnerInfo).not.toHaveBeenCalled();
    });

    it('reports owner null for a legacy unattributed chat conversation', async () => {
      vi.mocked(getBexActor).mockResolvedValue({ kind: 'user', userId: 'admin-1', canViewAll: true });
      vi.mocked(getConversationById).mockResolvedValue(
        conversation({ user_id: null, source: 'chat' }),
      );

      const response = await GET(makeRequest(), routeContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.conversation.owner).toBeNull();
      expect(getConversationOwnerInfo).not.toHaveBeenCalled();
    });

    it('allows a service bearer to read any conversation', async () => {
      vi.mocked(getBexActor).mockResolvedValue({ kind: 'service' });
      vi.mocked(getConversationById).mockResolvedValue(conversation({ user_id: 'user-1' }));

      const response = await GET(makeRequest(), routeContext());

      expect(response.status).toBe(200);
    });
  });

  describe('DELETE', () => {
    it('returns 401 with no session', async () => {
      vi.mocked(hasBexSession).mockResolvedValue(false);

      const response = await DELETE(makeRequest('DELETE'), routeContext());

      expect(response.status).toBe(401);
      expect(deleteConversation).not.toHaveBeenCalled();
    });

    it('returns 403 and audits a cross-user delete for a non-view-all owner mismatch', async () => {
      vi.mocked(getBexActor).mockResolvedValue({ kind: 'user', userId: 'user-2', canViewAll: false });
      vi.mocked(getConversationById).mockResolvedValue(conversation({ user_id: 'user-1' }));

      const response = await DELETE(makeRequest('DELETE'), routeContext());

      expect(response.status).toBe(403);
      expect(deleteConversation).not.toHaveBeenCalled();
      expect(writeAuditLog).toHaveBeenCalledWith(
        'bex.conversation.access_denied',
        expect.objectContaining({ conversationId: CONVERSATION_ID, requestedByUserId: 'user-2' }),
        expect.anything(),
      );
    });

    it('allows an it-admin to delete an act-as-created conversation via the true-owner fallback (B0-841)', async () => {
      vi.mocked(getBexActor).mockResolvedValue({ kind: 'user', userId: 'user-2', canViewAll: false });
      vi.mocked(getConversationById).mockResolvedValue(conversation({ user_id: 'admin-true-1' }));
      vi.mocked(resolveConversationOwnerUserId).mockResolvedValue('admin-true-1');

      const response = await DELETE(makeRequest('DELETE'), routeContext());

      expect(response.status).toBe(200);
      expect(deleteConversation).toHaveBeenCalledWith(CONVERSATION_ID);
    });

    it('allows the owner to delete without an admin_delete audit entry', async () => {
      vi.mocked(getBexActor).mockResolvedValue({ kind: 'user', userId: 'user-1', canViewAll: false });
      vi.mocked(getConversationById).mockResolvedValue(conversation({ user_id: 'user-1' }));

      const response = await DELETE(makeRequest('DELETE'), routeContext());

      expect(response.status).toBe(200);
      expect(deleteConversation).toHaveBeenCalledWith(CONVERSATION_ID);
      expect(writeAuditLog).not.toHaveBeenCalled();
    });

    it('lets a view-all admin delete someone else’s conversation and audits it', async () => {
      vi.mocked(getBexActor).mockResolvedValue({ kind: 'user', userId: 'admin-1', canViewAll: true });
      vi.mocked(getConversationById).mockResolvedValue(conversation({ user_id: 'user-1' }));

      const response = await DELETE(makeRequest('DELETE'), routeContext());

      expect(response.status).toBe(200);
      expect(deleteConversation).toHaveBeenCalledWith(CONVERSATION_ID);
      expect(writeAuditLog).toHaveBeenCalledWith(
        'bex.conversation.admin_delete',
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          deletedByUserId: 'admin-1',
          ownerUserId: 'user-1',
        }),
        expect.anything(),
      );
    });
  });
});
