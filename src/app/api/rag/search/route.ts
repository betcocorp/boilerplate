import { NextResponse } from 'next/server';

import { isRagSyncAuthorized } from '~/lib/api/rag-api-auth';
import { searchProductChunks } from '~/lib/rag/search';
import { toPositiveInteger } from '~/lib/utils/params';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type RequestBody = {
  query?: unknown;
  limit?: unknown;
  productLineKey?: unknown;
  productKey?: unknown;
  minSimilarity?: unknown;
  model?: unknown;
};

function toSimilarityNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export async function POST(request: Request) {
  if (!isRagSyncAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: RequestBody = {};

  try {
    body = (await request.json()) as RequestBody;
  } catch {
    body = {};
  }

  try {
    const result = await searchProductChunks({
      query: typeof body.query === 'string' ? body.query : '',
      limit: toPositiveInteger(body.limit),
      productLineKey:
        typeof body.productLineKey === 'string'
          ? body.productLineKey
          : undefined,
      productKey:
        typeof body.productKey === 'string' ? body.productKey : undefined,
      minSimilarity: toSimilarityNumber(body.minSimilarity),
      model: typeof body.model === 'string' ? body.model : undefined,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Similarity search failed.';

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
