import { getServerSession } from 'next-auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resolveConversationOwnerUserId,
  resolveConversationStamp,
} from '~/lib/conversations/conversation-owner';
import { getUser } from '~/lib/permissions/repository';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));

vi.mock('~/lib/auth', () => ({
  authOptions: {},
}));

vi.mock('~/lib/permissions/repository', () => ({
  getUser: vi.fn(),
}));

vi.mock('~/lib/observability/logger', () => ({
  logWarn: vi.fn(),
}));

describe('resolveConversationOwnerUserId', () => {
  beforeEach(() => {
    vi.mocked(getServerSession).mockReset();
    vi.mocked(getUser).mockReset();
  });

  it('returns the app_user id for a session email that matches a row', async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: 'admin@betco.com' },
    });
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: [{ USER_ID: 'user-1', NAME: 'Admin', EMAIL: 'admin@betco.com' } as never],
      rowcount: 1,
    });

    const result = await resolveConversationOwnerUserId();

    expect(result).toBe('user-1');
    expect(getUser).toHaveBeenCalledWith('admin@betco.com');
  });

  it('returns null when there is no session', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const result = await resolveConversationOwnerUserId();

    expect(result).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });

  it('returns null when the session has no matching app_user row', async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: 'ghost@betco.com' },
    });
    vi.mocked(getUser).mockResolvedValue({ success: true, data: [], rowcount: 0 });

    const result = await resolveConversationOwnerUserId();

    expect(result).toBeNull();
  });

  it('returns null when the repository lookup throws', async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { email: 'admin@betco.com' },
    });
    vi.mocked(getUser).mockRejectedValue(new Error('boom'));

    const result = await resolveConversationOwnerUserId();

    expect(result).toBeNull();
  });
});

describe('resolveConversationStamp (B0-1084)', () => {
  it('owns by the acted-as actor and records the true admin when acting-as', () => {
    expect(resolveConversationStamp('acted-as-1', 'admin-true-1')).toEqual({
      userId: 'acted-as-1',
      actedByUserId: 'admin-true-1',
    });
  });

  it('leaves actedByUserId null when not acting-as', () => {
    expect(resolveConversationStamp('user-1', 'user-1')).toEqual({
      userId: 'user-1',
      actedByUserId: null,
    });
  });

  it('leaves actedByUserId null when the true owner is unresolved', () => {
    expect(resolveConversationStamp('user-1', null)).toEqual({
      userId: 'user-1',
      actedByUserId: null,
    });
  });
});
