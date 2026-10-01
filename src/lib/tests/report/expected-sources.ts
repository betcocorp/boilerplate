/**
 * B0-933 — `test_items.expected_sources` is a `uuid[]` of `rag.document.id`, not prose any more.
 *
 * A bare uuid tells a report reader nothing, so every surface that shows "expected sources" shows
 * the document's own `title` (and its `document_kind` where that disambiguates two documents with
 * the same name — a US and a Canadian label routinely share one). The lookup is **batched once per
 * report**: `loadExpectedSourceIndex` takes every id the run's items reference and issues one read
 * per 200 ids, and `resolveExpectedSourceRefs` is a pure map lookup from there. Nothing in the
 * report path queries per case.
 *
 * This module is **pure** so client components can import its formatting; the batched read lives
 * in `./expected-sources-repository` (server only).
 *
 * A uuid that no longer resolves — the document was purged (corpus scoping, B0-283) or the item
 * points at a row that never existed — is **kept and marked**, never dropped: an expectation that
 * silently disappears reads as "this case expected no source", which is a different and wrong
 * statement about the golden dataset.
 *
 * Regulated-data rule: `title` is copied by reference and re-emitted verbatim. Document titles
 * carry EPA registration numbers and product names; nothing here parses, cases or truncates one.
 */

/** One entry of `test_items.expected_sources`, resolved (or explicitly not) against `rag.document`. */
export type ExpectedSourceRef = {
  /** The `rag.document.id` exactly as stored on the item. */
  id: string;
  /** `rag.document.title`, verbatim. Null when the row resolved but carries no title. */
  title: string | null;
  /** `rag.document.document_kind` (`label` | `sds` | `efficacy` | …). Null when unresolved. */
  documentKind: string | null;
  /** False when no live `rag.document` row has this id. The uuid is still shown, marked. */
  resolved: boolean;
};

/** `rag.document.id` → the row's display fields. Built once per report. */
export type ExpectedSourceIndex = ReadonlyMap<string, { title: string | null; documentKind: string | null }>;

/** What an unresolvable uuid is labelled with, so the marker is spelled one way everywhere. */
export const UNRESOLVED_EXPECTED_SOURCE_LABEL = 'unresolved document';

/**
 * The one-line label for one expected source. Title first (it is what a reader recognises), kind in
 * parentheses when present. An unresolved id shows the uuid with the marker appended, never alone.
 */
export function formatExpectedSourceRef(ref: ExpectedSourceRef): string {
  if (!ref.resolved) return `${ref.id} — ${UNRESOLVED_EXPECTED_SOURCE_LABEL}`;
  const title = ref.title?.trim() || ref.id;
  return ref.documentKind ? `${title} (${ref.documentKind})` : title;
}

/** Every expected source on one case, joined for a single-line renderer. Empty string when none. */
export function formatExpectedSourceRefs(refs: readonly ExpectedSourceRef[]): string {
  return refs.map(formatExpectedSourceRef).join('; ');
}

/**
 * Projects an item's `expected_sources` uuids onto display records, in the order the item stores
 * them. A missing (or absent) index resolves nothing — every id comes back marked unresolved rather
 * than silently dropped, which is the same contract as a purged document.
 */
export function resolveExpectedSourceRefs(
  ids: readonly string[] | null | undefined,
  index?: ExpectedSourceIndex | null,
): ExpectedSourceRef[] {
  if (!ids || ids.length === 0) return [];
  return ids.map((id) => {
    const hit = index?.get(id);
    return hit
      ? { id, title: hit.title, documentKind: hit.documentKind, resolved: true }
      : { id, title: null, documentKind: null, resolved: false };
  });
}

/** Every distinct id across a set of items' `expected_sources`, in first-seen order. */
export function collectExpectedSourceIds(
  items: readonly { expected_sources?: string[] | null }[],
): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    for (const id of item.expected_sources ?? []) {
      const trimmed = id?.trim();
      if (trimmed) seen.add(trimmed);
    }
  }
  return [...seen];
}
