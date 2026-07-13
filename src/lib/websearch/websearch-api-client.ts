import {
  webSearchResponseSchema,
  type WebSearchRequest,
  type WebSearchResponse,
} from '~/lib/websearch/websearch-schemas';

function extractError(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'error' in data) {
    const message = (data as { error?: unknown }).error;
    if (typeof message === 'string') {
      return message;
    }
  }
  return fallback;
}

/** Typed client for the admin web-search test page. */
export async function apiWebSearch(input: WebSearchRequest): Promise<WebSearchResponse> {
  const res = await fetch('/api/admin/web-search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(extractError(data, `Request failed (${res.status})`));
  }
  const parsed = webSearchResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error('Unexpected web search response');
  }
  return parsed.data;
}
