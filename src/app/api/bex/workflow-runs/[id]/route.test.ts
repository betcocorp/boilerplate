import { getServerSession } from 'next-auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '~/app/api/bex/workflow-runs/[id]/route';
import { authenticateApiToken } from '~/lib/api/client-auth';
import {
  getWorkflowRunWithSteps,
  listAuditLogsForRun,
} from '~/lib/conversations/workflow-repository';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));

vi.mock('~/lib/auth', () => ({
  authOptions: {},
}));

vi.mock('~/lib/api/client-auth', () => ({
  authenticateApiToken: vi.fn(),
}));

vi.mock('~/lib/conversations/workflow-repository', () => ({
  getWorkflowRunWithSteps: vi.fn(),
  listAuditLogsForRun: vi.fn(),
}));

const RUN_ID = 'f9dc4fb8-a4ce-4b81-8ce8-f4f7f9f16dea';

type RunBundle = Awaited<ReturnType<typeof getWorkflowRunWithSteps>>;
type AuditLogs = Awaited<ReturnType<typeof listAuditLogsForRun>>;

/** The route only forwards these through, so a minimal shape is enough. */
const RUN_BUNDLE = {
  run: { id: RUN_ID, status: 'succeeded' },
  steps: [{ id: 'step-1', workflow_run_id: RUN_ID }],
} as unknown as RunBundle;

function makeRequest(headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/bex/workflow-runs/${RUN_ID}`, {
    headers,
  });
}

function routeContext() {
  return { params: Promise.resolve({ id: RUN_ID }) };
}

function signedIn() {
  vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'admin@betco.com' } });
}

function signedOut() {
  vi.mocked(getServerSession).mockResolvedValue(null);
}

function tokenAccepted() {
  vi.mocked(authenticateApiToken).mockResolvedValue({
    ok: true,
    context: {
      keyId: 'key-1',
      appId: 'app-1',
      projectId: 'project-1',
      rateLimitPerMinute: null,
    },
  });
}

describe('GET /api/bex/workflow-runs/[id]', () => {
  beforeEach(() => {
    vi.mocked(getServerSession).mockReset();
    vi.mocked(authenticateApiToken).mockReset();
    vi.mocked(getWorkflowRunWithSteps).mockReset();
    vi.mocked(listAuditLogsForRun).mockReset();

    vi.mocked(getWorkflowRunWithSteps).mockResolvedValue(RUN_BUNDLE);
    vi.mocked(listAuditLogsForRun).mockResolvedValue([] as unknown as AuditLogs);
    // Default: no credential resolves.
    signedOut();
    vi.mocked(authenticateApiToken).mockResolvedValue({
      ok: false,
      reason: 'missing_token',
    });
  });

  it('returns 200 for an authenticated browser session with no bearer', async () => {
    signedIn();

    const response = await GET(makeRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, run: { id: RUN_ID } });
    // A session is enough; the token registry is never consulted.
    expect(authenticateApiToken).not.toHaveBeenCalled();
  });

  it('returns 200 for a valid service bearer with no session', async () => {
    tokenAccepted();

    const response = await GET(
      makeRequest({ authorization: 'Bearer bex_service_token_value_1234567890' }),
      routeContext(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, run: { id: RUN_ID } });
    expect(authenticateApiToken).toHaveBeenCalledTimes(1);
  });

  it('returns 401 with no session and no bearer', async () => {
    const response = await GET(makeRequest(), routeContext());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(getWorkflowRunWithSteps).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown_token'],
    ['revoked'],
    ['expired'],
    ['app_inactive'],
    ['project_inactive'],
  ] as const)('returns 401 when the bearer fails the chain check (%s)', async (reason) => {
    vi.mocked(authenticateApiToken).mockResolvedValue({ ok: false, reason });

    const response = await GET(
      makeRequest({ authorization: 'Bearer bex_service_token_value_1234567890' }),
      routeContext(),
    );

    expect(response.status).toBe(401);
    expect(getWorkflowRunWithSteps).not.toHaveBeenCalled();
  });

  // B0-387: there is no environment escape hatch — the 401 does not depend on NODE_ENV, and the
  // route consults nothing but the session and the token registry.
  it.each(['development', 'test', 'production'])(
    'still returns 401 with no credential when NODE_ENV is %s',
    async (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv as 'development' | 'test' | 'production');

      const response = await GET(makeRequest(), routeContext());

      expect(response.status).toBe(401);
      vi.unstubAllEnvs();
    },
  );

  it('returns 404 when the run does not exist', async () => {
    signedIn();
    vi.mocked(getWorkflowRunWithSteps).mockResolvedValue(null);

    const response = await GET(makeRequest(), routeContext());

    expect(response.status).toBe(404);
  });
});
