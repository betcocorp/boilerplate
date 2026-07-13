import { getErrorMessage } from '~/lib/utils';
import type { ProviderSearchResult, WebSearchProvider } from '~/lib/websearch/types';
import { WebSearchError } from '~/lib/websearch/types';
import type { WebSearchRequest, WebSearchResult } from '~/lib/websearch/websearch-schemas';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';

type TavilyResultRow = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  raw_content?: unknown;
  score?: unknown;
  published_date?: unknown;
};

function normalizeRow(row: TavilyResultRow): WebSearchResult {
  return {
    title: typeof row.title === 'string' ? row.title : '',
    url: typeof row.url === 'string' ? row.url : '',
    snippet: typeof row.content === 'string' ? row.content : '',
    rawContent: typeof row.raw_content === 'string' ? row.raw_content : undefined,
    score: typeof row.score === 'number' ? row.score : 0,
    publishedAt:
      typeof row.published_date === 'string' ? row.published_date : undefined,
  };
}

/** Tavily adapter. Maps Bex request opts → Tavily params and normalizes results back. */
export class TavilyProvider implements WebSearchProvider {
  readonly name = 'tavily';
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    const key = (apiKey ?? process.env.TAVILY_API_KEY)?.trim();
    if (!key) {
      throw new WebSearchError(
        'provider_unconfigured',
        'TAVILY_API_KEY is not configured.',
        500,
      );
    }
    this.apiKey = key;
  }

  private async post(url: string, body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: this.apiKey, ...body }),
      });
    } catch (err) {
      throw new WebSearchError(
        'provider_unreachable',
        getErrorMessage(err, 'Tavily request failed'),
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new WebSearchError(
        'provider_error',
        `Tavily returned ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
      );
    }
    return response.json().catch(() => {
      throw new WebSearchError('provider_error', 'Tavily returned invalid JSON.');
    });
  }

  async search(request: WebSearchRequest): Promise<ProviderSearchResult> {
    const depth = request.depth ?? 'basic';
    const data = (await this.post(TAVILY_SEARCH_URL, {
      query: request.query,
      search_depth: depth,
      include_answer: true,
      include_raw_content: depth === 'advanced',
      max_results: request.maxResults ?? 5,
      ...(request.domains?.length ? { include_domains: request.domains } : {}),
    })) as { answer?: unknown; results?: unknown };

    const rows = Array.isArray(data.results) ? (data.results as TavilyResultRow[]) : [];
    return {
      answer: typeof data.answer === 'string' ? data.answer : null,
      results: rows.map(normalizeRow),
    };
  }

  async extract(urls: string[]): Promise<WebSearchResult[]> {
    if (urls.length === 0) {
      return [];
    }
    const data = (await this.post(TAVILY_EXTRACT_URL, { urls })) as {
      results?: unknown;
    };
    const rows = Array.isArray(data.results) ? (data.results as TavilyResultRow[]) : [];
    return rows.map(normalizeRow);
  }
}
