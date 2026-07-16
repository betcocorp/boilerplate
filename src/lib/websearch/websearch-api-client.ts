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

/**
 * Typed client for the token-authenticated v1 tool endpoint
 * (`/api/v1/tools/web-search`). Unlike {@link apiWebSearch}, this hits the
 * server-to-server surface exposed to API clients, so it requires a per-client
 * bearer token (`bex_<env>_…`). Used by the admin "API test" section to exercise
 * the real client-facing endpoint end-to-end.
 */
export async function apiWebSearchV1Tool(
  input: WebSearchRequest,
  token: string,
): Promise<WebSearchResponse> {
  const res = await fetch('/api/v1/tools/web-search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
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
