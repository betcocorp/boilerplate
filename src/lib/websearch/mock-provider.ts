import type { ProviderSearchResult, WebSearchProvider } from '~/lib/websearch/types';
import type { WebSearchRequest, WebSearchResult } from '~/lib/websearch/websearch-schemas';

/**
 * Deterministic provider for local dev + tests — no network. Returns canned fixtures;
 * a custom fixture can be injected (including a deliberately malformed one for tests).
 */
export class MockWebSearchProvider implements WebSearchProvider {
  readonly name = 'mock';

  constructor(private readonly fixture?: ProviderSearchResult) {}

  async search(request: WebSearchRequest): Promise<ProviderSearchResult> {
    if (this.fixture) {
      return this.fixture;
    }
    const results: WebSearchResult[] = [
      {
        title: `Result for "${request.query}"`,
        url: 'https://example.com/a',
        snippet: `A mock result about ${request.query}.`,
        score: 0.92,
      },
      {
        title: `Secondary result for "${request.query}"`,
        url: 'https://example.com/b',
        snippet: `Another mock result about ${request.query}.`,
        score: 0.71,
      },
    ];
    return { answer: `Mock answer for "${request.query}".`, results };
  }

  async extract(urls: string[]): Promise<WebSearchResult[]> {
    return urls.map((url) => ({ title: url, url, snippet: '', score: 0 }));
  }
}
