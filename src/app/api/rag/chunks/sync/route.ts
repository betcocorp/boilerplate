import { NextResponse } from 'next/server';

import { isRagSyncAuthorized } from '~/lib/api/rag-api-auth';
import { runRagPipeline } from '~/lib/rag/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!isRagSyncAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runRagPipeline('sync-chunks', { languageCode: 'EN' });
    return NextResponse.json(result.chunkSyncResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Chunk sync failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
