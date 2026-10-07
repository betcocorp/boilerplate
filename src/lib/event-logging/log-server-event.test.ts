import { beforeEach, describe, expect, it, vi } from 'vitest';

const insert = vi.fn();

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => ({ from: () => ({ insert }) }),
}));

const { logServerEvent } = await import('~/lib/event-logging/log-server-event');

describe('logServerEvent', () => {
  beforeEach(() => {
    insert.mockReset();
    insert.mockResolvedValue({ error: null });
  });

  it('normalizes the event name before writing', async () => {
    await logServerEvent('user.login.success', {});
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'analytics.user.login.success' }),
    );
  });

  it('denormalizes user_id and session_id out of meta', async () => {
    await logServerEvent('analytics.user.login.success', {
      userId: '  U1  ',
      sessionId: 's-1',
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'U1', session_id: 's-1' }),
    );
  });

  it('writes null actor columns when meta carries no identity', async () => {
    await logServerEvent('analytics.user.login.failure', { reason: 'user-not-found' });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: null, session_id: null }),
    );
  });

  it('skips the write entirely for a blank event name', async () => {
    await logServerEvent('   ', {});
    expect(insert).not.toHaveBeenCalled();
  });

  // Analytics must never break a sign-in: both a returned error and a thrown one are swallowed.
  it('swallows a returned insert error', async () => {
    insert.mockResolvedValue({ error: { message: 'boom' } });
    await expect(logServerEvent('analytics.x', {})).resolves.toBeUndefined();
  });

  it('swallows a thrown insert error', async () => {
    insert.mockRejectedValue(new Error('network down'));
    await expect(logServerEvent('analytics.x', {})).resolves.toBeUndefined();
  });
});
