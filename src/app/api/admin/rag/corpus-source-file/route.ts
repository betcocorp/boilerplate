import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';
import {
  createCorpusFileViewUrl,
  SOURCE_CORPORA,
  SourceFileSigningError,
} from '~/lib/rag/source-file-signing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestSchema = z.object({
  corpus: z.enum(SOURCE_CORPORA),
  key: z.string().min(1).max(1024),
});

/**
 * GET /api/admin/rag/corpus-source-file?corpus=<corpus>&key=<s3 key>
 *
 * Redirects to a short-lived signed URL for a file listed by an ingestion panel.
 *
 * The ingestion panels (SDS, labels, knowledge, efficacy) list keys discovered in S3 before
 * any `rag.document` exists, so unlike `document-source-file` there is no document id to key
 * off. The `corpus` selects the bucket server-side and constrains the key to that corpus's
 * configured prefix — the request never names a bucket, and cannot escape the prefix.
 */
export async function GET(request: NextRequest) {
  const denied = await gateRoute(
    PERMISSIONS.NAVIGATION_SIDEBAR_INGESTION_PRODUCTS,
    'GET /api/admin/rag/corpus-source-file',
  );
  if (denied) return denied;

  const parsed = requestSchema.safeParse({
    corpus: request.nextUrl.searchParams.get('corpus') ?? undefined,
    key: request.nextUrl.searchParams.get('key') ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'A valid corpus and key are required.', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const signedUrl = await createCorpusFileViewUrl(parsed.data.corpus, parsed.data.key);
    const response = NextResponse.redirect(signedUrl, 302);
    response.headers.set('Cache-Control', 'no-store, max-age=0');
    return response;
  } catch (signingError) {
    if (signingError instanceof SourceFileSigningError) {
      return NextResponse.json({ error: signingError.message }, { status: 400 });
    }

    throw signingError;
  }
}
