import { describe, expect, it } from 'vitest';

import {
  resolveConversationOwnerAttribution,
  resolveIsOwner,
} from '~/lib/conversations/conversation-owner-view';

describe('resolveIsOwner', () => {
  it('is true only when the actor is the row user', () => {
    expect(
      resolveIsOwner({ kind: 'user', userId: 'user-1', canViewAll: false }, 'user-1'),
    ).toBe(true);
  });

  it('is false when the row belongs to someone else, regardless of view-all', () => {
    expect(
      resolveIsOwner({ kind: 'user', userId: 'admin-1', canViewAll: true }, 'user-1'),
    ).toBe(false);
  });

  it('is false when the row has no owner', () => {
    expect(
      resolveIsOwner({ kind: 'user', userId: 'user-1', canViewAll: false }, null),
    ).toBe(false);
  });

  it('is always false for a service actor', () => {
    expect(resolveIsOwner({ kind: 'service' }, 'user-1')).toBe(false);
  });
});

describe('resolveConversationOwnerAttribution', () => {
  const admin = { kind: 'user', userId: 'admin-1', canViewAll: true } as const;

  it('reports owner "admin" for a test_run row, ignoring user_id', () => {
    const result = resolveConversationOwnerAttribution(
      { source: 'test_run', user_id: null },
      admin,
    );
    expect(result).toEqual({ owner: 'admin', source: 'test_run', isOwner: false });
  });

  it('reports owner null for a legacy chat row with no user_id', () => {
    const result = resolveConversationOwnerAttribution(
      { source: 'chat', user_id: null },
      admin,
    );
    expect(result).toEqual({ owner: null, source: 'chat', isOwner: false });
  });

  it('reports the resolved name/email for an attributed chat row', () => {
    const result = resolveConversationOwnerAttribution(
      {
        source: 'chat',
        user_id: 'user-1',
        ownerName: 'User One',
        ownerEmail: 'user1@betco.com',
      },
      admin,
    );
    expect(result).toEqual({
      owner: { name: 'User One', email: 'user1@betco.com', userId: 'user-1' },
      source: 'chat',
      isOwner: false,
    });
  });

  it('falls back the name to email, then a literal label, when ownerName is unresolved', () => {
    const withEmailOnly = resolveConversationOwnerAttribution(
      { source: 'chat', user_id: 'user-1', ownerName: null, ownerEmail: 'user1@betco.com' },
      admin,
    );
    expect(withEmailOnly.owner).toEqual({
      name: 'user1@betco.com',
      email: 'user1@betco.com',
      userId: 'user-1',
    });

    const withNeither = resolveConversationOwnerAttribution(
      { source: 'chat', user_id: 'user-1', ownerName: null, ownerEmail: null },
      admin,
    );
    expect(withNeither.owner).toEqual({ name: 'Unknown user', email: null, userId: 'user-1' });
  });

  it('marks isOwner true when the actor is the row owner', () => {
    const result = resolveConversationOwnerAttribution(
      { source: 'chat', user_id: 'admin-1', ownerName: 'Admin', ownerEmail: null },
      admin,
    );
    expect(result.isOwner).toBe(true);
  });

  it('treats any non-test_run source string as chat', () => {
    const result = resolveConversationOwnerAttribution(
      { source: 'legacy', user_id: null },
      admin,
    );
    expect(result.source).toBe('chat');
  });
});
