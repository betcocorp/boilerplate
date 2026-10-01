import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  apiFetchConversation,
  apiListConversations,
  apiPostBexChatStream,
} from '~/lib/bex/bex-api-client';

const CONVERSATION_ID = '7ad779f1-2af3-4a82-ae68-bf1372f6cd99';

function mockFetchJson(body: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  });
  global.fetch = fetchMock as unknown as typeof global.fetch;
  return fetchMock;
}

describe('apiListConversations', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('requests the bare endpoint with no query string when no filters are given', async () => {
    const fetchMock = mockFetchJson({ ok: true, conversations: [] });

    await apiListConversations();

    expect(fetchMock).toHaveBeenCalledWith('/api/bex/conversations', {
      method: 'GET',
    });
  });

  it('appends ?source= when a source filter is given', async () => {
    const fetchMock = mockFetchJson({ ok: true, conversations: [] });

    await apiListConversations({ source: 'chat' });

    expect(fetchMock).toHaveBeenCalledWith('/api/bex/conversations?source=chat', {
      method: 'GET',
    });
  });

  it('appends both source and userFilter when both are given', async () => {
    const fetchMock = mockFetchJson({ ok: true, conversations: [] });

    await apiListConversations({ source: 'test_run', userFilter: 'user-9' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/bex/conversations?source=test_run&userFilter=user-9',
      { method: 'GET' },
    );
  });

  it('omits an empty userFilter rather than sending a blank param', async () => {
    const fetchMock = mockFetchJson({ ok: true, conversations: [] });

    await apiListConversations({ userFilter: '' });

    expect(fetchMock).toHaveBeenCalledWith('/api/bex/conversations', {
      method: 'GET',
    });
  });

  it('parses owner/source/isOwner on each row', async () => {
    mockFetchJson({
      ok: true,
      conversations: [
        {
          id: CONVERSATION_ID,
          title: 'A',
          updatedAt: '2026-08-11T00:00:00.000Z',
          status: 'active',
          owner: { name: 'User One', email: 'user1@betco.com', userId: 'user-1' },
          source: 'chat',
          isOwner: false,
        },
        {
          id: CONVERSATION_ID,
          title: 'B',
          updatedAt: '2026-08-11T00:00:00.000Z',
          status: 'active',
          owner: 'admin',
          source: 'test_run',
          isOwner: false,
        },
        {
          id: CONVERSATION_ID,
          title: 'C',
          updatedAt: '2026-08-11T00:00:00.000Z',
          status: 'active',
          owner: { kind: 'test', title: 'Golden Set Regression' },
          source: 'test_run',
          isOwner: false,
        },
      ],
    });

    const rows = await apiListConversations();

    expect(rows[0]?.owner).toEqual({
      name: 'User One',
      email: 'user1@betco.com',
      userId: 'user-1',
    });
    expect(rows[1]?.owner).toBe('admin');
    expect(rows[1]?.source).toBe('test_run');
    expect(rows[2]?.owner).toEqual({ kind: 'test', title: 'Golden Set Regression' });
    expect(rows[2]?.source).toBe('test_run');
  });

  it('throws when the response is missing the new required fields', async () => {
    mockFetchJson({
      ok: true,
      conversations: [
        {
          id: CONVERSATION_ID,
          title: 'A',
          updatedAt: '2026-08-11T00:00:00.000Z',
          status: 'active',
        },
      ],
    });

    await expect(apiListConversations()).rejects.toThrow(
      'Unexpected conversation list response',
    );
  });
});

describe('apiFetchConversation', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('parses owner/source/isOwner on the conversation object', async () => {
    mockFetchJson({
      ok: true,
      conversation: {
        id: CONVERSATION_ID,
        title: 'A',
        updatedAt: '2026-08-11T00:00:00.000Z',
        status: 'active',
        owner: null,
        source: 'chat',
        isOwner: true,
      },
      messages: [],
    });

    const detail = await apiFetchConversation(CONVERSATION_ID);

    expect(detail.conversation.owner).toBeNull();
    expect(detail.conversation.isOwner).toBe(true);
  });
});

/**
 * B0-693 (part 2) — regression coverage for the client half of "a failed run hangs silently in
 * chat". `route.test.ts:372` already confirms the SERVER emits a `data-bex-event` with
 * `stage: 'request_failed'` on a thrown workflow (still a clean 200, still followed by a closing
 * `data-bex-meta`/`text-end`). Nothing previously tested that the CLIENT forwards that event to a
 * caller — `apiPostBexChatStream` does the forwarding correctly today, but until `BexChatApp.tsx`
 * was fixed to pass an `onEvent` handler, the event had nowhere to go and the turn read as an
 * empty success. This locks in the forwarding contract `BexChatApp.tsx` now depends on.
 */
describe('apiPostBexChatStream', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function sseChunk(data: Record<string, unknown>): string {
    return `data: ${JSON.stringify({ type: 'data-bex-event', data })}\n\n`;
  }

  function metaChunk(data: Record<string, unknown>): string {
    return `data: ${JSON.stringify({ type: 'data-bex-meta', data })}\n\n`;
  }

  function streamResponseFrom(chunks: string[]) {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return { ok: true, body } as unknown as Response;
  }

  it('forwards a mid-stream request_failed event to onEvent and still resolves (does not throw)', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      streamResponseFrom([
        sseChunk({ type: 'status', stage: 'request_started', traceId: 'trace-1' }),
        sseChunk({
          type: 'status',
          stage: 'request_failed',
          error: 'internal detail that must never reach the client UI',
        }),
        metaChunk({
          traceId: 'trace-1',
          conversationId: 'convo-1',
          streamMetrics: { totalMs: 42, timeToFirstTokenMs: null, deltaCount: 0 },
        }),
      ]),
    ) as unknown as typeof global.fetch;

    const events: unknown[] = [];
    const result = await apiPostBexChatStream({
      message: 'What is the dilution ratio for DAILY DISINFECT?',
      model: 'preview',
      onEvent: (event) => events.push(event),
    });

    expect(result.conversationId).toBe('convo-1');
    expect(result.assistantText).toBe('');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'status', stage: 'request_failed' }),
    );
  });

  it('forwards text deltas via onTextDelta, and a completed run never fires a request_failed event', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      streamResponseFrom([
        sseChunk({ type: 'status', stage: 'agent_started' }),
        `data: ${JSON.stringify({ type: 'text-delta', id: 'a', delta: 'Hello' })}\n\n`,
        sseChunk({ type: 'status', stage: 'workflow_completed' }),
        metaChunk({ traceId: 'trace-2', conversationId: 'convo-2' }),
      ]),
    ) as unknown as typeof global.fetch;

    const events: unknown[] = [];
    let deltaText = '';
    const result = await apiPostBexChatStream({
      message: 'Hi',
      model: 'preview',
      onTextDelta: (delta) => {
        deltaText += delta;
      },
      onEvent: (event) => events.push(event),
    });

    expect(deltaText).toBe('Hello');
    expect(result.assistantText).toBe('Hello');
    expect(events.some((e) => (e as { stage?: unknown }).stage === 'request_failed')).toBe(false);
  });

  it('throws when the response is not ok, independent of onEvent', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
    }) as unknown as typeof global.fetch;

    await expect(
      apiPostBexChatStream({ message: 'Hi', model: 'preview' }),
    ).rejects.toThrow('Unauthorized');
  });
});
