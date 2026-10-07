import { logEvent } from '~/lib/event-logging/log-event';

/**
 * Payload builders for the search funnel events (B0-761).
 *
 * - `analytics.search.submit` — a search executed on a search surface.
 * - `analytics.search.result.click` — the user opened a result from that surface.
 *
 * Privacy: the raw query string is deliberately NEVER logged — only its length.
 * Queries are user-entered free text that can contain customer names, contact
 * details, and personal data, and `event_logging` is not treated as a sensitive
 * store. A future "top zero-result queries" feature would need raw queries; that
 * is a separate, explicit decision (retention + access) recorded on B0-761 —
 * do not add the query string here without it.
 */

export const SEARCH_SUBMIT_EVENT = 'analytics.search.submit';
export const SEARCH_RESULT_CLICK_EVENT = 'analytics.search.result.click';

/** Domains a this app search surface can target. */
export type SearchEntityType =
  | 'product'
  | 'document'
  | 'chunk'
  | 'cross_reference'
  | 'web';

/** JSON-safe extra context (e.g. corpusScope). Never put the raw query here. */
type SearchEventExtra = Record<string, string | number | boolean>;

export type SearchSubmitArgs = {
  entityType: SearchEntityType;
  /** Total rows matching the executed search — required, including 0. */
  resultCount: number;
  /** Length of the trimmed query string. The raw query is never logged. */
  queryLength: number;
  /** Page/component the search ran on, e.g. 'products-rag-list'. */
  surface: string;
  extra?: SearchEventExtra;
};

export type SearchResultClickArgs = {
  entityType: SearchEntityType;
  /** 1-based absolute position of the clicked result (offset + index + 1). */
  rank: number;
  /** Identifier of the opened record (product key, document id, chunk id, …). */
  resultId: string;
  /** Total rows of the search the result was clicked from. */
  resultCount: number;
  /** Page/component the result was clicked on, e.g. 'products-rag-list'. */
  surface: string;
  extra?: SearchEventExtra;
};

/** Coerces to a non-negative integer; invalid input becomes `min`. */
function toCount(value: number, min = 0): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= min ? n : min;
}

export function buildSearchSubmitEvent(args: SearchSubmitArgs): {
  event: string;
  meta: Record<string, unknown>;
} {
  const { entityType, resultCount, queryLength, surface, extra } = args;
  return {
    event: SEARCH_SUBMIT_EVENT,
    meta: {
      ...extra,
      entityType,
      resultCount: toCount(resultCount),
      queryLength: toCount(queryLength),
      surface,
    },
  };
}

export function buildSearchResultClickEvent(args: SearchResultClickArgs): {
  event: string;
  meta: Record<string, unknown>;
} {
  const { entityType, rank, resultId, resultCount, surface, extra } = args;
  return {
    event: SEARCH_RESULT_CLICK_EVENT,
    meta: {
      ...extra,
      entityType,
      rank: toCount(rank, 1),
      resultId,
      resultCount: toCount(resultCount),
      surface,
    },
  };
}

/** Fire-and-forget `analytics.search.submit` (failures swallowed by logEvent). */
export function logSearchSubmit(args: SearchSubmitArgs): void {
  const { event, meta } = buildSearchSubmitEvent(args);
  void logEvent(event, meta);
}

/** Fire-and-forget `analytics.search.result.click` (failures swallowed by logEvent). */
export function logSearchResultClick(args: SearchResultClickArgs): void {
  const { event, meta } = buildSearchResultClickEvent(args);
  void logEvent(event, meta);
}
