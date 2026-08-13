import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiFetchConversation, apiListConversations } from '~/lib/bex/bex-api-client';

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
