import { getServerSession } from 'next-auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '~/app/api/admin/tests/runs/route';
import { authenticateApiToken } from '~/lib/api/client-auth';
import { gateRoute } from '~/lib/permissions/route-gate';
import {
  createTestResult,
  getTestById,
  getTestItemsByTestId,
  updateTestRecord,
} from '~/lib/tests/repository';

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));

vi.mock('~/lib/auth', () => ({
  authOptions: {},
}));

vi.mock('~/lib/api/client-auth', () => ({
  authenticateApiToken: vi.fn(),
}));

vi.mock('~/lib/tests/repository', () => ({
  createTestResult: vi.fn(),
  getTestById: vi.fn(),
  getTestItemsByTestId: vi.fn(),
  updateTestRecord: vi.fn(),
}));

// Mocked so the permission outcome is explicit here rather than a function of
// BEX_PERMISSIONS_ENFORCED and a live Supabase/Redis lookup.
vi.mock('~/lib/permissions/route-gate', () => ({
  gateRoute: vi.fn(),
}));

const TEST_ID = '0a4f1a4a-6b1e-4a4c-9c0f-9b2f5b6d7e81';
const RUN_ID = 'f9dc4fb8-a4ce-4b81-8ce8-f4f7f9f16dea';

type Test = Awaited<ReturnType<typeof getTestById>>;
type Items = Awaited<ReturnType<typeof getTestItemsByTestId>>;
type Result = Awaited<ReturnType<typeof createTestResult>>;

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/tests/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
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

describe('POST /api/admin/tests/runs (B0-465)', () => {
  beforeEach(() => {
    vi.mocked(getServerSession).mockReset();
    vi.mocked(authenticateApiToken).mockReset();
    vi.mocked(gateRoute).mockReset();
    vi.mocked(createTestResult).mockReset();
    vi.mocked(getTestById).mockReset();
    vi.mocked(getTestItemsByTestId).mockReset();
    vi.mocked(updateTestRecord).mockReset();

    vi.mocked(gateRoute).mockResolvedValue(null);
    vi.mocked(getTestById).mockResolvedValue({
      id: TEST_ID,
      suite_version: 'v7',
    } as unknown as Test);
    vi.mocked(getTestItemsByTestId).mockResolvedValue([{ id: 'i1' }, { id: 'i2' }] as unknown as Items);
    vi.mocked(createTestResult).mockResolvedValue({ id: RUN_ID } as unknown as Result);
    vi.mocked(updateTestRecord).mockResolvedValue(undefined as never);

    // Default: no credential resolves.
    signedOut();
    vi.mocked(authenticateApiToken).mockResolvedValue({
      ok: false,
      reason: 'missing_token',
    });
  });

  it('creates a queued run for a signed-in admin session', async () => {
    signedIn();

    const response = await POST(makeRequest({ testId: TEST_ID }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      runId: RUN_ID,
      testId: TEST_ID,
      runMode: 'full',
      totalItems: 2,
      suiteVersion: 'v7',
    });
    // A session is enough; the token registry is never consulted.
    expect(authenticateApiToken).not.toHaveBeenCalled();
  });

  it('creates a run for a CI service token with no session — the whole point of the ticket', async () => {
    tokenAccepted();

    const response = await POST(
      makeRequest({ testId: TEST_ID }, { Authorization: 'Bearer bex_dev_token' }),
    );

    expect(response.status).toBe(200);
    // The per-user navigation gate must NOT run for a machine caller: it carries no NextAuth
    // user, so applying it would lock CI out permanently.
    expect(gateRoute).not.toHaveBeenCalled();
  });

  it('rejects a request with neither a session nor a valid token', async () => {
    const response = await POST(makeRequest({ testId: TEST_ID }));

    expect(response.status).toBe(401);
    expect(createTestResult).not.toHaveBeenCalled();
  });

  it('honors the permission gate for a session that lacks the tests permission', async () => {
    signedIn();
    vi.mocked(gateRoute).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }) as never,
    );

    const response = await POST(makeRequest({ testId: TEST_ID }));

    expect(response.status).toBe(403);
    expect(createTestResult).not.toHaveBeenCalled();
  });

  it('seeds the run exactly as the admin form action does', async () => {
    signedIn();

    await POST(makeRequest({ testId: TEST_ID, modelTag: 'gpt-4.1' }));

    expect(createTestResult).toHaveBeenCalledWith(
      expect.objectContaining({
        test_id: TEST_ID,
        status: 'queued',
        run_mode: 'full',
        total_items: 2,
        passed_items: 0,
        failed_items: 0,
        run_options: { modelTag: 'gpt-4.1' },
        summary: {
          completed_items: 0,
          total_items: 2,
          progress_percent: 0,
          runner_state: 'queued',
        },
      }),
    );
    // Chat runs flip the parent record to running, matching runTestAction.
    expect(updateTestRecord).toHaveBeenCalledWith(TEST_ID, { status: 'running' });
  });

  it('carries the search flags and leaves the parent record alone in search mode', async () => {
    signedIn();

    await POST(
      makeRequest({
        testId: TEST_ID,
        runMode: 'search',
        useHybrid: true,
        useReranker: true,
      }),
    );

    expect(createTestResult).toHaveBeenCalledWith(
      expect.objectContaining({
        run_mode: 'search',
        run_options: { useHybrid: true, useReranker: true, useMultiIntent: false },
      }),
    );
    // Only runTestAction sets the parent to running; runSearchEvalAction does not.
    expect(updateTestRecord).not.toHaveBeenCalled();
  });

  it('accepts the newer models from ~/lib/constants/models', async () => {
    signedIn();

    // Proves the `z.enum(['preview', ...supportedModelNames])` spread validates at runtime, not
    // just that it type-checks — a model added to the shared list is accepted here with no edit.
    for (const modelTag of ['gpt-5.5', 'gpt-5.6', 'gpt-4.1-mini']) {
      vi.mocked(createTestResult).mockClear();
      const response = await POST(makeRequest({ testId: TEST_ID, modelTag }));

      expect(response.status).toBe(200);
      expect(createTestResult).toHaveBeenCalledWith(
        expect.objectContaining({ run_options: { modelTag } }),
      );
    }
  });

  it('still rejects a model that is not on the supported list', async () => {
    signedIn();

    // The enum must remain a real allow-list — otherwise a typo silently bills a wrong model.
    const response = await POST(
      makeRequest({ testId: TEST_ID, modelTag: 'gpt-9.9-turbo-imaginary' }),
    );

    expect(response.status).toBe(400);
    expect(createTestResult).not.toHaveBeenCalled();
  });

  it('rejects a malformed body with 400 and Zod issues', async () => {
    signedIn();

    const response = await POST(makeRequest({ testId: '', runMode: 'nope' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid request body');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(createTestResult).not.toHaveBeenCalled();
  });

  it('404s an unknown test rather than creating an orphan run', async () => {
    signedIn();
    vi.mocked(getTestById).mockRejectedValue(new Error('not found'));

    const response = await POST(makeRequest({ testId: TEST_ID }));

    expect(response.status).toBe(404);
    expect(createTestResult).not.toHaveBeenCalled();
  });

  it('409s a suite with no items, so CI never grades an empty run as a pass', async () => {
    signedIn();
    vi.mocked(getTestItemsByTestId).mockResolvedValue([] as unknown as Items);

    const response = await POST(makeRequest({ testId: TEST_ID }));

    expect(response.status).toBe(409);
    expect(createTestResult).not.toHaveBeenCalled();
  });
});
