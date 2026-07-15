import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticateApiToken } from '~/lib/api/client-auth';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

type QueryResult = { data: unknown; error: unknown };

/** Minimal service-role client whose `.from(table)` chain resolves per-table. */
function mockSupabase(responses: Record<string, QueryResult>) {
  return {
    from(table: string) {
      const result = responses[table] ?? { data: null, error: null };
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve(result),
      };
      return builder;
    },
  };
}

function useResponses(responses: Record<string, QueryResult>) {
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(
    mockSupabase(responses) as unknown as ReturnType<
      typeof getSupabaseServiceRoleClient
    >,
  );
}

const VALID_TOKEN = `bex_dev_${'a'.repeat(32)}`;

function request(token?: string): Request {
  return new Request('http://localhost/api/v1/agents', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const ACTIVE_KEY = { id: 'key-1', app_id: 'app-1', revoked_at: null, expires_at: null };
const ACTIVE_APP = {
  id: 'app-1',
  project_id: 'proj-1',
  environment: 'development',
  is_active: true,
  rate_limit_per_minute: null,
};
const ACTIVE_PROJECT = { id: 'proj-1', is_active: true };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authenticateApiToken — rejects before touching the database', () => {
  it('fails on a missing Authorization header', async () => {
    useResponses({});
    const result = await authenticateApiToken(request());
    expect(result).toEqual({ ok: false, reason: 'missing_token' });
  });

  it('fails on a malformed token', async () => {
    useResponses({});
    const result = await authenticateApiToken(request('not-a-real-token'));
    expect(result).toEqual({ ok: false, reason: 'malformed_token' });
  });
});

describe('authenticateApiToken — chain enforcement', () => {
  it('fails when the token is unknown', async () => {
    useResponses({ api_key: { data: null, error: null } });
    const result = await authenticateApiToken(request(VALID_TOKEN));
    expect(result).toEqual({ ok: false, reason: 'unknown_token' });
  });

  it('fails when the key is revoked', async () => {
    useResponses({
      api_key: { data: { ...ACTIVE_KEY, revoked_at: '2026-01-01T00:00:00Z' }, error: null },
    });
    const result = await authenticateApiToken(request(VALID_TOKEN));
    expect(result).toEqual({
      ok: false,
      reason: 'revoked',
      attribution: { keyId: 'key-1', appId: 'app-1', projectId: null },
    });
  });

  it('fails when the key is expired', async () => {
    useResponses({
      api_key: { data: { ...ACTIVE_KEY, expires_at: '2000-01-01T00:00:00Z' }, error: null },
    });
    const result = await authenticateApiToken(request(VALID_TOKEN));
    expect(result).toEqual({
      ok: false,
      reason: 'expired',
      attribution: { keyId: 'key-1', appId: 'app-1', projectId: null },
    });
  });

  it('fails when the app is deactivated', async () => {
    useResponses({
      api_key: { data: ACTIVE_KEY, error: null },
      api_app: { data: { ...ACTIVE_APP, is_active: false }, error: null },
    });
    const result = await authenticateApiToken(request(VALID_TOKEN));
    expect(result).toEqual({
      ok: false,
      reason: 'app_inactive',
      attribution: { keyId: 'key-1', appId: 'app-1', projectId: 'proj-1' },
    });
  });

  it('fails when the project is deactivated', async () => {
    useResponses({
      api_key: { data: ACTIVE_KEY, error: null },
      api_app: { data: ACTIVE_APP, error: null },
      api_project: { data: { ...ACTIVE_PROJECT, is_active: false }, error: null },
    });
    const result = await authenticateApiToken(request(VALID_TOKEN));
    expect(result).toEqual({
      ok: false,
      reason: 'project_inactive',
      attribution: { keyId: 'key-1', appId: 'app-1', projectId: 'proj-1' },
    });
  });

  it('fails closed when a lookup errors', async () => {
    useResponses({
      api_key: { data: null, error: { message: 'boom' } },
    });
    const result = await authenticateApiToken(request(VALID_TOKEN));
    expect(result).toEqual({ ok: false, reason: 'lookup_error' });
  });

  it('succeeds and returns full attribution when the whole chain is active', async () => {
    useResponses({
      api_key: { data: ACTIVE_KEY, error: null },
      api_app: { data: ACTIVE_APP, error: null },
      api_project: { data: ACTIVE_PROJECT, error: null },
    });
    const result = await authenticateApiToken(request(VALID_TOKEN));
    expect(result).toEqual({
      ok: true,
      context: {
        keyId: 'key-1',
        appId: 'app-1',
        projectId: 'proj-1',
        environment: 'development',
        rateLimitPerMinute: null,
      },
    });
  });
});
