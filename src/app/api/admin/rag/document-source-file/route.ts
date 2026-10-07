import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';
import {
  createSourceFileViewUrl,
  SourceFileSigningError,
} from '~/lib/rag/source-file-signing';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestSchema = z.object({ documentId: z.string().uuid() });

/**
 * GET /api/admin/rag/document-source-file?documentId=<uuid>
 *
 * Redirects to a short-lived signed URL for the S3 object a RAG document was ingested from.
 *
 * The bucket and key are read from `rag.source_record.source_uri` for the requested document —
 * never from request input. That keeps the endpoint from becoming a signing oracle for any
 * object our AWS credentials can reach; the only files addressable here are ones an ingested
 * document actually points at. Signing happens per request so a link on a long-open page
 * cannot serve an expired URL.
 */
export async function GET(request: NextRequest) {
  const denied = await gateRoute(
    PERMISSIONS.NAVIGATION_SIDEBAR_PRODUCTS,
    'GET /api/admin/rag/document-source-file',
  );
  if (denied) return denied;

  const parsed = requestSchema.safeParse({
    documentId: request.nextUrl.searchParams.get('documentId') ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'A valid documentId query parameter is required.', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const supabase = getSupabaseServiceRoleClient();

  const { data, error } = await (
    supabase.schema('rag').from('document') as unknown as {
      select(cols: string): {
        eq(
          col: string,
          val: string,
        ): {
          maybeSingle(): Promise<{
            data: { source_record: { source_uri: string | null } | null } | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .select('source_record:source_record_id (source_uri)')
    .eq('id', parsed.data.documentId)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: 'Failed to load document source.', details: error.message },
      { status: 500 },
    );
  }

  const sourceUri = data?.source_record?.source_uri;
  if (!sourceUri) {
    return NextResponse.json(
      { error: 'This document has no ingested source file.' },
      { status: 404 },
    );
  }

  try {
    const signedUrl = await createSourceFileViewUrl(sourceUri);
    // 302: the signed target is single-use-ish and time-boxed, so it must never be cached.
    const response = NextResponse.redirect(signedUrl, 302);
    response.headers.set('Cache-Control', 'no-store, max-age=0');
    return response;
  } catch (signingError) {
    if (signingError instanceof SourceFileSigningError) {
      return NextResponse.json({ error: signingError.message }, { status: 502 });
    }

    throw signingError;
  }
}
