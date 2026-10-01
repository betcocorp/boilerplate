import type { WebSearchRequest, WebSearchResult } from '~/lib/websearch/websearch-schemas';

/** Raw normalized output from a provider before the service validates/trims it. */
export type ProviderSearchResult = {
  answer: string | null;
  results: WebSearchResult[];
};

/**
 * Pluggable provider interface. Genericity lives here; intent-specific consumers
 * (competitor lookup, sales research, …) build on top of the service, not the provider.
 */
export interface WebSearchProvider {
  readonly name: string;
  search(request: WebSearchRequest): Promise<ProviderSearchResult>;
  extract(urls: string[]): Promise<WebSearchResult[]>;
}

/** Structured error so failures surface as typed values, never bare thrown strings. */
export class WebSearchError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 502) {
    super(message);
    this.name = 'WebSearchError';
    this.code = code;
    this.status = status;
  }
}
