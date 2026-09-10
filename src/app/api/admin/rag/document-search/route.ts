import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { hasBexSession } from '~/lib/api/bex-api-auth';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'GET /api/admin/rag/document-search';

/** Rows handed back to the picker. `rag.document` is ~5.9k rows — the table never ships to the client. */
const RESULT_LIMIT = 20;
/** Candidate pool per underlying query, before merge + rank. */
const CANDIDATE_LIMIT = 60;
/**
 * A product term can match many SKU-tier entities that carry no documents at all, so the entity
 * fan-out gets a generous cap — but a bounded one: these ids go back out as an `in.(…)` filter on
 * the follow-up query, and that whole list travels in the request URL.
 */
const ENTITY_LIMIT = 120;
/** Hydration cap for `?ids=` — well above any realistic `expected_sources` list. */
const MAX_IDS = 50;

const documentSearchParamsSchema = z
  .object({
    q: z.string().min(2).max(120).optional(),
    ids: z.array(z.string().uuid()).min(1).max(MAX_IDS).optional(),
  })
  .refine((value) => (value.q === undefined) !== (value.ids === undefined), {
    message: 'Provide exactly one of `q` (search) or `ids` (hydrate).',
  });

type DocumentRow = {
  id: string;
  title: string;
  document_kind: string;
  language_code: string;
  is_current: boolean;
  lifecycle_status: string;
};

const DOCUMENT_COLUMNS =
  'id,title,document_kind,language_code,is_current,lifecycle_status';

/**
 * PostgREST parses `or=(…)` as a comma-separated list of parenthesised filters, so a comma,
 * parenthesis, quote or backslash in the typed text would change the filter rather than be
 * searched for. They are stripped instead of escaped — this is a search box, not stored data.
 */
function likePattern(raw: string): string {
  const cleaned = raw.replace(/[,()"\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? `%${cleaned}%` : '';
}

/** Lower is better. Superseded / inactive documents are pushed behind every live one. */
function rankScore(row: DocumentRow, needle: string): number {
  let score = 0;
  if (!row.is_current) {
    score += 100;
  }
  if (row.lifecycle_status !== 'active') {
    score += 100;
  }
  const title = row.title.toLowerCase();
  if (title.startsWith(needle)) {
    score -= 10;
  } else if (title.includes(needle)) {
    score -= 5;
  }
  return score;
}

function toResponseRow(row: DocumentRow) {
  return {
    id: row.id,
    title: row.title,
    document_kind: row.document_kind,
    language_code: row.language_code,
    is_current: row.is_current,
  };
}

/**
 * GET /api/admin/rag/document-search
 *
 * Type-ahead behind the admin test-item "Expected sources" picker (B0-934). `expected_sources`
 * stores `rag.document.id` uuids, so the picker needs both a search (`?q=`) and a way to resolve
 * stored uuids back to titles when an existing row is opened for editing (`?ids=`).
 *
 * Search matches `rag.document.title`, `rag.document.document_key` and the joined
 * `rag.entity` product identifiers (title / sku / product_key / product_line_key), and is bounded
 * at every hop: each underlying query carries a LIMIT and the merged result is capped at
 * `RESULT_LIMIT`. Live documents always rank ahead of superseded or non-active ones.
 *
 * Auth is the Bex UI pattern — the NextAuth session (`hasBexSession`) plus the same sidebar-tests
 * permission gate the rest of `/admin/tests` uses. This is a browser surface only; machine callers
 * use `/api/v1/*` with a client token.
 */
export async function GET(request: NextRequest) {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(PERMISSIONS.NAVIGATION_SIDEBAR_TESTS, ROUTE);
  if (denied) return denied;

  const rawIds = request.nextUrl.searchParams.get('ids');
  const rawQuery = request.nextUrl.searchParams.get('q');

  const parsed = documentSearchParamsSchema.safeParse({
    q: rawQuery === null || rawQuery.trim() === '' ? undefined : rawQuery.trim(),
    ids:
      rawIds === null || rawIds.trim() === ''
        ? undefined
        : rawIds
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id !== ''),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid search parameters', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const rag = getSupabaseServiceRoleClient().schema('rag');

  try {
    if (parsed.data.ids) {
      const ids = parsed.data.ids;
      const { data, error } = await rag
        .from('document')
        .select(DOCUMENT_COLUMNS)
        .in('id', ids)
        .limit(MAX_IDS);

      if (error) {
        throw new Error(error.message);
      }

      const rows = (data ?? []) as DocumentRow[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      // Preserve the caller's order so badges render in the order they were stored.
      const documents = ids
        .map((id) => byId.get(id))
        .filter((row): row is DocumentRow => row !== undefined)
        .map(toResponseRow);

      return NextResponse.json({ documents });
    }

    const term = parsed.data.q ?? '';
    const pattern = likePattern(term);
    if (!pattern) {
      return NextResponse.json({ documents: [] });
    }

    const [documentMatches, entityMatches] = await Promise.all([
      rag
        .from('document')
        .select(DOCUMENT_COLUMNS)
        .or(`title.ilike.${pattern},document_key.ilike.${pattern}`)
        .limit(CANDIDATE_LIMIT),
      rag
        .from('entity')
        .select('id')
        .or(
          [
            `title.ilike.${pattern}`,
            `sku.ilike.${pattern}`,
            `product_key.ilike.${pattern}`,
            `product_line_key.ilike.${pattern}`,
          ].join(','),
        )
        .limit(ENTITY_LIMIT),
    ]);

    if (documentMatches.error) {
      throw new Error(documentMatches.error.message);
    }
    if (entityMatches.error) {
      throw new Error(entityMatches.error.message);
    }

    const candidates = new Map<string, DocumentRow>();
    for (const row of (documentMatches.data ?? []) as DocumentRow[]) {
      candidates.set(row.id, row);
    }

    const entityIds = ((entityMatches.data ?? []) as { id: string }[]).map(
      (row) => row.id,
    );

    if (entityIds.length > 0) {
      const { data, error } = await rag
        .from('document')
        .select(DOCUMENT_COLUMNS)
        .in('entity_id', entityIds)
        .limit(CANDIDATE_LIMIT);

      if (error) {
        throw new Error(error.message);
      }

      for (const row of (data ?? []) as DocumentRow[]) {
        if (!candidates.has(row.id)) {
          candidates.set(row.id, row);
        }
      }
    }

    const needle = term.toLowerCase();
    const documents = [...candidates.values()]
      .sort((a, b) => {
        const delta = rankScore(a, needle) - rankScore(b, needle);
        return delta !== 0 ? delta : a.title.localeCompare(b.title);
      })
      .slice(0, RESULT_LIMIT)
      .map(toResponseRow);

    return NextResponse.json({ documents });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Document search failed', details: message },
      { status: 500 },
    );
  }
}
