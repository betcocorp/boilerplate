import { logWarn } from '~/lib/observability/logger';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import { collectExpectedSourceIds, type ExpectedSourceIndex } from './expected-sources';

/**
 * B0-933 — the server-only half of expected-source resolution: one batched `rag.document` read per
 * report. Kept out of `./expected-sources` so the pure formatting helpers stay importable from a
 * client component without dragging the service-role client into the browser bundle.
 */

/** PostgREST caps a URL-encoded `in.(…)` list; 200 uuids per read stays comfortably inside it. */
const LOOKUP_CHUNK_SIZE = 200;

/**
 * Resolves every id in one batched read (chunked). Never throws: a failed lookup logs and returns
 * what it has, so a report still renders with its expected sources marked unresolved rather than
 * failing to generate at all.
 */
export async function loadExpectedSourceIndex(
  ids: readonly string[],
): Promise<ExpectedSourceIndex> {
  const index = new Map<string, { title: string | null; documentKind: string | null }>();
  const unique = [...new Set(ids.filter((id) => id && id.trim()))];
  if (unique.length === 0) return index;

  const supabase = getSupabaseServiceRoleClient();
  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + LOOKUP_CHUNK_SIZE);
    try {
      const { data, error } = await supabase
        .schema('rag')
        .from('document')
        .select('id, title, document_kind')
        .in('id', chunk);
      if (error) {
        logWarn('report_expected_sources_lookup_failed', {
          count: chunk.length,
          message: error.message,
        });
        continue;
      }
      for (const row of data ?? []) {
        index.set(row.id, {
          title: typeof row.title === 'string' ? row.title : null,
          documentKind: typeof row.document_kind === 'string' ? row.document_kind : null,
        });
      }
    } catch (error) {
      logWarn('report_expected_sources_lookup_threw', {
        count: chunk.length,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return index;
}

/** Loads the index straight from a set of items — the shape both report entry points hold. */
export async function loadExpectedSourceIndexForItems(
  items: readonly { expected_sources?: string[] | null }[],
): Promise<ExpectedSourceIndex> {
  return loadExpectedSourceIndex(collectExpectedSourceIds(items));
}

/**
 * Title-only view of the index, for the admin pages that render expected sources in a table cell
 * and only need a display name. Ids with no live document are deliberately absent from the record
 * rather than mapped to a placeholder — the caller marks those unresolved, so an expectation is
 * never silently dropped.
 */
export async function loadDocumentTitlesByIds(
  ids: readonly string[],
): Promise<Record<string, string>> {
  const index = await loadExpectedSourceIndex(ids);
  const titles: Record<string, string> = {};
  for (const [id, ref] of index) {
    if (ref.title) titles[id] = ref.title;
  }
  return titles;
}
