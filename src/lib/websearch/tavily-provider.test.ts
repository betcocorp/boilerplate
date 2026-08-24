import { afterEach, describe, expect, it, vi } from 'vitest';

import { TavilyProvider } from '~/lib/websearch/tavily-provider';

function mockFetchJson(body: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
    text: async () => '',
  });
  global.fetch = fetchMock as unknown as typeof global.fetch;
  return fetchMock;
}

describe('TavilyProvider.search', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // B0-640: include_raw_content was previously gated on `depth === 'advanced'`, so most
  // recommendation searches (which run at 'basic' depth) never got full page text — only short
  // snippets — starving the downstream enrich step of evidence. Raw content is now always requested,
  // and is cost-neutral (estimateCost() prices purely off depth, never include_raw_content).
  it('requests include_raw_content: true for a basic-depth search', async () => {
    const fetchMock = mockFetchJson({ answer: 'a', results: [] });
    const provider = new TavilyProvider('test-key');

    await provider.search({ query: 'Spartan CDC-10', depth: 'basic' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.search_depth).toBe('basic');
    expect(body.include_raw_content).toBe(true);
  });

  it('also requests include_raw_content: true for an advanced-depth search', async () => {
    const fetchMock = mockFetchJson({ answer: 'a', results: [] });
    const provider = new TavilyProvider('test-key');

    await provider.search({ query: 'Spartan CDC-10', depth: 'advanced' });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.include_raw_content).toBe(true);
  });
});
