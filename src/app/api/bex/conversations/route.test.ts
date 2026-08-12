import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, POST } from '~/app/api/bex/conversations/route';
import { getBexActor } from '~/lib/api/bex-actor';
import { hasBexSession } from '~/lib/api/bex-api-auth';
import { resolveConversationOwnerUserId } from '~/lib/conversations/conversation-owner';
import {
  createConversation,
  listAllConversations,
  listConversationsForUser,
} from '~/lib/conversations/conversation-repository';
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
  createConversation: vi.fn(),
  listAllConversations: vi.fn(),
  listConversationsForUser: vi.fn(),
}));

vi.mock('~/lib/permissions/route-gate', () => ({
  gateRoute: vi.fn(),
}));

function makeRequest(method: 'GET' | 'POST' = 'GET') {
  return new Request('http://localhost/api/bex/conversations', { method });
}

describe('/api/bex/conversations', () => {
  beforeEach(() => {
    vi.mocked(hasBexSession).mockReset();
    vi.mocked(getBexActor).mockReset();
    vi.mocked(resolveConversationOwnerUserId).mockReset();
    vi.mocked(createConversation).mockReset();
    vi.mocked(listAllConversations).mockReset();
    vi.mocked(listConversationsForUser).mockReset();
    vi.mocked(gateRoute).mockReset();

    vi.mocked(hasBexSession).mockResolvedValue(true);
    vi.mocked(gateRoute).mockResolvedValue(null);
    vi.mocked(listAllConversations).mockResolvedValue([]);
    vi.mocked(listConversationsForUser).mockResolvedValue([]);
  });

  describe('GET', () => {
    it('returns 401 when there is no session', async () => {
      vi.mocked(hasBexSession).mockResolvedValue(false);

      const response = await GET(makeRequest());

      expect(response.status).toBe(401);
      expect(listAllConversations).not.toHaveBeenCalled();
      expect(listConversationsForUser).not.toHaveBeenCalled();
    });

    it('returns 401 when the session cannot resolve an actor', async () => {
      vi.mocked(getBexActor).mockReset();
      vi.mocked(getBexActor).mockResolvedValue(null);

      const response = await GET(makeRequest());

      expect(response.status).toBe(401);
    });

    it('scopes the list to the caller for a non-view-all user', async () => {
      vi.mocked(getBexActor).mockResolvedValue({
        kind: 'user',
        userId: 'user-1',
        canViewAll: false,
      });
      vi.mocked(listConversationsForUser).mockResolvedValue([
        {
          id: 'conv-1',
          title: 'Mine',
          updated_at: '2026-08-11T00:00:00.000Z',
          status: 'active',
          latest_model: null,
        } as never,
      ]);

      const response = await GET(makeRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(listConversationsForUser).toHaveBeenCalledWith('user-1', 80);
      expect(listAllConversations).not.toHaveBeenCalled();
      expect(body.conversations).toHaveLength(1);
    });

    it('returns the full list for a view-all user', async () => {
      vi.mocked(getBexActor).mockResolvedValue({
        kind: 'user',
        userId: 'admin-1',
        canViewAll: true,
      });
      vi.mocked(listAllConversations).mockResolvedValue([
        { id: 'conv-1', title: 'A', updated_at: '2026-08-11T00:00:00.000Z', status: 'active', latest_model: null } as never,
        { id: 'conv-2', title: 'B', updated_at: '2026-08-11T00:00:00.000Z', status: 'active', latest_model: null } as never,
      ]);

      const response = await GET(makeRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(listAllConversations).toHaveBeenCalledWith({ limit: 80 });
      expect(listConversationsForUser).not.toHaveBeenCalled();
      expect(body.conversations).toHaveLength(2);
    });

    it('leaves the service-bearer path unaffected by ownership scoping', async () => {
      vi.mocked(getBexActor).mockResolvedValue({ kind: 'service' });

      const response = await GET(makeRequest());

      expect(response.status).toBe(200);
      expect(listAllConversations).toHaveBeenCalledWith({ limit: 80 });
      expect(listConversationsForUser).not.toHaveBeenCalled();
    });
  });

  describe('POST', () => {
    it('returns 401 when there is no session', async () => {
      vi.mocked(hasBexSession).mockResolvedValue(false);

      const response = await POST(makeRequest('POST'));

      expect(response.status).toBe(401);
      expect(createConversation).not.toHaveBeenCalled();
    });

    it('stamps the resolved owner for a signed-in user', async () => {
      vi.mocked(getBexActor).mockResolvedValue({
        kind: 'user',
        userId: 'user-1',
        canViewAll: false,
      });
      vi.mocked(resolveConversationOwnerUserId).mockResolvedValue('user-1');
      vi.mocked(createConversation).mockResolvedValue({
        id: 'conv-1',
        title: 'New conversation',
        updated_at: '2026-08-11T00:00:00.000Z',
      } as never);

      const response = await POST(makeRequest('POST'));

      expect(response.status).toBe(200);
      expect(createConversation).toHaveBeenCalledWith({ user_id: 'user-1' });
    });

    it('creates without an owner override when ownership cannot be resolved', async () => {
      vi.mocked(getBexActor).mockResolvedValue({
        kind: 'user',
        userId: 'user-1',
        canViewAll: false,
      });
      vi.mocked(resolveConversationOwnerUserId).mockResolvedValue(null);
      vi.mocked(createConversation).mockResolvedValue({
        id: 'conv-1',
        title: 'New conversation',
        updated_at: '2026-08-11T00:00:00.000Z',
      } as never);

      const response = await POST(makeRequest('POST'));

      expect(response.status).toBe(200);
      expect(createConversation).toHaveBeenCalledWith(undefined);
    });

    it('does not resolve an owner for a service bearer', async () => {
      vi.mocked(getBexActor).mockResolvedValue({ kind: 'service' });
      vi.mocked(createConversation).mockResolvedValue({
        id: 'conv-1',
        title: 'New conversation',
        updated_at: '2026-08-11T00:00:00.000Z',
      } as never);

      const response = await POST(makeRequest('POST'));

      expect(response.status).toBe(200);
      expect(resolveConversationOwnerUserId).not.toHaveBeenCalled();
      expect(createConversation).toHaveBeenCalledWith();
    });
  });
});
