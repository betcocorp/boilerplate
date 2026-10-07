import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { hasBexSession } from '~/lib/api/bex-api-auth';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = 'GET /api/admin/rag/document-bodies';

/** Same hydration cap as `document-search?ids=` — well above any realistic `expected_sources` list. */
const MAX_IDS = 50;

const documentBodiesParamsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(MAX_IDS),
});

/** The columns the expected-sources dialog renders. Bodies are re-emitted verbatim. */
export type DocumentBodyRow = {
  id: string;
  title: string;
  document_kind: string;
  language_code: string;
  is_current: boolean;
  lifecycle_status: string;
  body_markdown: string | null;
  body_text: string;
};

const DOCUMENT_BODY_COLUMNS =
  'id,title,document_kind,language_code,is_current,lifecycle_status,body_markdown,body_text';

/**
 * GET /api/admin/rag/document-bodies?ids=<uuid>,<uuid>
 *
 * B0-994 — full bodies for the "Sources" dialog on the admin test-prompts table. The table itself
 * only ships titles (`loadDocumentTitlesByIds`); bodies run to 170 KB for a long label, so they are
 * fetched lazily, per row, when a reviewer opens the dialog.
 *
 * Regulated-data rule: `body_markdown` / `body_text` are returned exactly as stored. Nothing here
 * trims, truncates or reformats a dilution ratio, contact time or EPA registration number.
 *
 * Auth mirrors `document-search`: the NextAuth session plus the sidebar-tests permission gate.
 * Browser surface only — machine callers use `/api/v1/*` with a client token.
 */
export async function GET(request: NextRequest) {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(PERMISSIONS.NAVIGATION_SIDEBAR_TESTS, ROUTE);
  if (denied) return denied;

  const rawIds = request.nextUrl.searchParams.get('ids');
  const parsed = documentBodiesParamsSchema.safeParse({
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
      { error: 'Invalid document ids', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const ids = parsed.data.ids;

  try {
    const { data, error } = await getSupabaseServiceRoleClient()
      .schema('rag')
      .from('document')
      .select(DOCUMENT_BODY_COLUMNS)
      .in('id', ids)
      .limit(MAX_IDS);

    if (error) {
      throw new Error(error.message);
    }

    const rows = (data ?? []) as DocumentBodyRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    // Preserve the caller's order so cards render in the order the row stores its sources. An id
    // with no live document is simply absent — the dialog marks it unresolved rather than dropping it.
    const documents = ids
      .map((id) => byId.get(id))
      .filter((row): row is DocumentBodyRow => row !== undefined);

    return NextResponse.json({ documents });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Document lookup failed', details: message },
      { status: 500 },
    );
  }
}
