import { NextResponse } from "next/server";

import { isRagSyncAuthorized } from "~/lib/api/rag-api-auth";
import { syncDocumentChunkEmbeddings } from "~/lib/rag/embeddings";
import { toPositiveInteger } from "~/lib/utils/params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RequestBody = {
  batchSize?: unknown;
  maxBatches?: unknown;
  model?: unknown;
};

export async function POST(request: Request) {
  if (!isRagSyncAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: RequestBody = {};

  try {
    body = (await request.json()) as RequestBody;
  } catch {
    body = {};
  }

  try {
    const result = await syncDocumentChunkEmbeddings({
      batchSize: toPositiveInteger(body.batchSize),
      maxBatches: toPositiveInteger(body.maxBatches),
      model: typeof body.model === "string" ? body.model : undefined,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Embedding sync failed.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
