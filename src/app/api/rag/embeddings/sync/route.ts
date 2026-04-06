import { NextResponse } from "next/server";

import { syncDocumentChunkEmbeddings } from "~/lib/rag/embeddings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RequestBody = {
  batchSize?: unknown;
  maxBatches?: unknown;
  model?: unknown;
};

function toPositiveInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return undefined;
  }

  return Math.floor(value);
}

function isAuthorized(request: Request) {
  const configuredKey = process.env.RAG_SYNC_API_KEY;

  if (!configuredKey) {
    return process.env.NODE_ENV !== "production";
  }

  const authorizationHeader = request.headers.get("authorization");
  const bearerToken = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length)
    : null;

  return bearerToken === configuredKey;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
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
