import { notFound, redirect } from 'next/navigation';

import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import {
  isRagUuid,
  ragChunkHref,
  sanitizeRagReturnHref,
} from '~/lib/rag/document-detail-links';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const metadata = {
  title: 'Chunk Viewer | Betco BEX',
};

type PageProps = {
  params: Promise<{ chunkId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** See `documents/[id]/chunks/[chunkId]/page.tsx` — the `rag` schema has no generated types. */
type MaybeSingleSelect<T> = {
  select(cols: string): {
    eq(
      col: string,
      val: string,
    ): {
      maybeSingle(): Promise<{ data: T | null; error: { message: string } | null }>;
    };
  };
};

/**
 * B0-1019 — resolver for a bare `rag.document_chunk.id` (the grain that shows up in log lines and
 * tool traces). Looks up the owning document and redirects to the canonical nested chunk URL.
 */
export default async function ChunkRedirectPage({ params, searchParams }: PageProps) {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_TOOLS,
    'GET /admin/products/rag/chunks/[chunkId]',
  );

  const { chunkId } = await params;

  if (!isRagUuid(chunkId)) {
    notFound();
  }

  const resolvedSearchParams = await searchParams;
  const rawFrom = resolvedSearchParams.from;
  const returnHref = sanitizeRagReturnHref(
    Array.isArray(rawFrom) ? rawFrom[0] : rawFrom,
  );

  const supabase = getSupabaseServiceRoleClient();

  const { data: chunk, error } = await (
    supabase.schema('rag').from('document_chunk') as unknown as MaybeSingleSelect<{
      document_id: string;
    }>
  )
    .select('document_id')
    .eq('id', chunkId)
    .maybeSingle();

  if (error || !chunk) {
    notFound();
  }

  // `redirect()` throws NEXT_REDIRECT internally — it must stay outside any try/catch.
  redirect(ragChunkHref(chunk.document_id, chunkId, returnHref));
}
