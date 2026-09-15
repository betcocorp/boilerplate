/**
 * B0-1019 — canonical URLs for the RAG corpus detail pages, and the safety rules for the
 * `from` param that carries a search URL forward so a detail page can link back to it.
 *
 * URL structure (both grains are deep-linkable):
 *   /admin/products/rag/documents/<documentId>                      — document
 *   /admin/products/rag/documents/<documentId>/chunks/<chunkId>     — chunk (canonical)
 *   /admin/products/rag/chunks/<chunkId>                            — bare chunk id, redirects
 */

/** Root of the RAG admin tool. Every detail route and every honoured `from` value lives under it. */
export const RAG_SEARCH_ROUTE = '/admin/products/rag';

/** Query param carrying the originating search URL through to a detail page. */
export const RAG_RETURN_PARAM = 'from';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** rag.document / rag.document_chunk ids are uuids; anything else must 404 before it reaches Postgres. */
export function isRagUuid(value: string | null | undefined): value is string {
  return !!value && UUID_RE.test(value);
}

function withReturnParam(path: string, returnHref?: string | null) {
  const safe = sanitizeRagReturnHref(returnHref);
  return safe
    ? `${path}?${RAG_RETURN_PARAM}=${encodeURIComponent(safe)}`
    : path;
}

/** Full-page view of a `rag.document`. */
export function ragDocumentHref(
  documentId: string,
  returnHref?: string | null,
) {
  return withReturnParam(
    `${RAG_SEARCH_ROUTE}/documents/${encodeURIComponent(documentId)}`,
    returnHref,
  );
}

/** Full-page view of a `rag.document_chunk`, nested under the document that owns it. */
export function ragChunkHref(
  documentId: string,
  chunkId: string,
  returnHref?: string | null,
) {
  return withReturnParam(
    `${RAG_SEARCH_ROUTE}/documents/${encodeURIComponent(documentId)}/chunks/${encodeURIComponent(chunkId)}`,
    returnHref,
  );
}

/**
 * Accept a `from` value only when it is a relative path inside this tool. A `from` param is
 * attacker-supplied by construction (it arrives in the URL), so anything absolute, protocol-
 * relative, or outside `/admin/products/rag` is dropped rather than rendered as a link.
 */
export function sanitizeRagReturnHref(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  // `//evil.com` is protocol-relative; a backslash is normalised to `/` by some browsers.
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return null;
  }

  // Only the search page itself is a legitimate return target for these detail pages.
  const path = trimmed.split(/[?#]/)[0];

  return path === RAG_SEARCH_ROUTE ? trimmed : null;
}

/** Rebuild the search URL a set of `searchParams` came from, for the `from` round-trip. */
export function buildRagSearchReturnHref(
  searchParams: Record<string, string | string[] | undefined>,
): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === 'string' && value) {
      params.set(key, value);
    } else if (Array.isArray(value) && value[0]) {
      params.set(key, value[0]);
    }
  }

  const queryString = params.toString();
  return queryString ? `${RAG_SEARCH_ROUTE}?${queryString}` : RAG_SEARCH_ROUTE;
}
