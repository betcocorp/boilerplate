import type { SourceRef } from '~/lib/conversations/conversation-schemas';
import type { WebSearchResult } from '~/lib/websearch/websearch-schemas';

/**
 * WEB-6 — Map external web results / citation URLs into `SourceRef`s so they render in the Bex
 * "Sources" panel alongside internal RAG sources (kind='external' + a clickable URL). The
 * documentId is the URL itself (stable + unique) since external sources have no rag document id.
 */

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function webResultsToSourceRefs(
  results: WebSearchResult[],
  limit = 4,
): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const result of results) {
    const url = result.url?.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      documentId: url,
      title: result.title?.trim() || result.sourceDomain || hostname(url),
      snippet: (result.snippet ?? '').slice(0, 2000),
      similarity: typeof result.score === 'number' ? result.score : undefined,
      kind: 'external',
      url,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function citationUrlsToSourceRefs(urls: string[], limit = 4): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const raw of urls) {
    const url = raw?.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      documentId: url,
      title: hostname(url),
      snippet: '',
      kind: 'external',
      url,
    });
    if (out.length >= limit) break;
  }
  return out;
}
