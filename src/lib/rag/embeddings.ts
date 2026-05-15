import { getOpenAIClient } from '~/lib/openai/client';
import { withRetry } from '~/lib/utils';
import { clampPositiveInteger } from '~/lib/utils/params';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
export const LARGE_EMBEDDING_MODEL = 'text-embedding-3-large';
const LARGE_EMBEDDING_DIMENSIONS = 3072;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_BATCHES = 4;

type PendingChunkRow = {
  id: string;
  chunk_key: string;
  heading: string | null;
  chunk_text: string;
};

type SyncDocumentChunkEmbeddingsOptions = {
  batchSize?: number;
  maxBatches?: number;
  model?: string;
  documentKind?: string;
};

type SyncDocumentChunkEmbeddingsResult = {
  model: string;
  batchSize: number;
  maxBatches: number;
  batchesProcessed: number;
  chunksEmbedded: number;
  remainingChunks: number;
};

type CreateEmbeddingOptions = {
  model?: string;
};

function getEmbeddingModel(model?: string) {
  return model?.trim() || process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
}

function buildEmbeddingInput(chunk: PendingChunkRow) {
  const heading = chunk.heading?.trim();
  const chunkText = chunk.chunk_text.trim();

  if (!heading) {
    return chunkText;
  }

  return `Heading: ${heading}\n\n${chunkText}`;
}

function toVectorLiteral(embedding: number[]) {
  return `[${embedding.join(',')}]`;
}

async function fetchPendingChunks(limit: number) {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('rag')
    .from('document_chunk')
    .select('id, chunk_key, heading, chunk_text')
    .is('embedding', null)
    .not('chunk_text', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load pending document chunks: ${error.message}`);
  }

  return (data ?? []) as PendingChunkRow[];
}

async function fetchPendingChunksByDocumentKind(
  limit: number,
  documentKind: string,
) {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('rag')
    .from('document_chunk')
    .select('id, chunk_key, heading, chunk_text, document!inner(document_kind)')
    .eq('document.document_kind', documentKind)
    .is('embedding', null)
    .not('chunk_text', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load pending ${documentKind} chunks: ${error.message}`);
  }

  return ((data ?? []) as Array<
    PendingChunkRow & {
      document: {
        document_kind: string;
      };
    }
  >).map(({ id, chunk_key, heading, chunk_text }) => ({
    id,
    chunk_key,
    heading,
    chunk_text,
  }));
}

async function countRemainingChunks() {
  const supabase = getSupabaseServiceRoleClient();
  const { count, error } = await supabase
    .schema('rag')
    .from('document_chunk')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null);

  if (error) {
    throw new Error(
      `Failed to count remaining document chunks: ${error.message}`,
    );
  }

  return count ?? 0;
}

async function countRemainingChunksByDocumentKind(documentKind: string) {
  const supabase = getSupabaseServiceRoleClient();
  const { count, error } = await supabase
    .schema('rag')
    .from('document_chunk')
    .select('id, document!inner(document_kind)', { count: 'exact', head: true })
    .eq('document.document_kind', documentKind)
    .is('embedding', null);

  if (error) {
    throw new Error(
      `Failed to count remaining ${documentKind} document chunks: ${error.message}`,
    );
  }

  return count ?? 0;
}

async function persistEmbeddings(
  chunks: PendingChunkRow[],
  embeddings: number[][],
  model: string,
) {
  for (const [index, chunk] of chunks.entries()) {
    const embedding = embeddings[index];
    if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding for chunk ${chunk.chunk_key} had ${embedding?.length ?? 0} dimensions; expected ${EMBEDDING_DIMENSIONS}.`,
      );
    }
  }

  const supabase = getSupabaseServiceRoleClient();

  for (const [index, chunk] of chunks.entries()) {
    const { error } = await supabase
      .schema('rag')
      .from('document_chunk')
      .update({ embedding: toVectorLiteral(embeddings[index]!), embedding_model: model })
      .eq('id', chunk.id);

    if (error) {
      throw new Error(`Failed to persist embedding for chunk ${chunk.chunk_key}: ${error.message}`);
    }
  }
}

export async function syncDocumentChunkEmbeddings(
  options: SyncDocumentChunkEmbeddingsOptions = {},
): Promise<SyncDocumentChunkEmbeddingsResult> {
  const model = getEmbeddingModel(options.model);
  const documentKind = options.documentKind?.trim();
  const batchSize = clampPositiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
  const maxBatches = clampPositiveInteger(options.maxBatches, DEFAULT_MAX_BATCHES);

  const openai = getOpenAIClient();

  let batchesProcessed = 0;
  let chunksEmbedded = 0;

  while (batchesProcessed < maxBatches) {
    const chunks = documentKind
      ? await fetchPendingChunksByDocumentKind(batchSize, documentKind)
      : await fetchPendingChunks(batchSize);

    if (chunks.length === 0) {
      break;
    }

    const response = await withRetry(() =>
      openai.embeddings.create({
        model,
        input: chunks.map(buildEmbeddingInput),
      }),
    );

    const embeddings = response.data.map((item) => item.embedding);

    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Expected ${chunks.length} embeddings from OpenAI but received ${embeddings.length}.`,
      );
    }

    await persistEmbeddings(chunks, embeddings, model);

    batchesProcessed += 1;
    chunksEmbedded += chunks.length;

    if (chunks.length < batchSize) {
      break;
    }
  }

  return {
    model,
    batchSize,
    maxBatches,
    batchesProcessed,
    chunksEmbedded,
    remainingChunks: documentKind
      ? await countRemainingChunksByDocumentKind(documentKind)
      : await countRemainingChunks(),
  };
}

// ── Large embedding functions (text-embedding-3-large / halfvec(3072)) ───────
// embedding_large and embedding_model_large columns exist after migration
// 20260512120000_add_halfvec_large_embeddings.sql. Run `pnpm run types:supabase:rag`
// to regenerate types and remove the `as unknown as` casts below.

async function fetchPendingLargeChunks(limit: number): Promise<PendingChunkRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await (
    supabase.schema('rag').from('document_chunk') as unknown as {
      select(cols: string): {
        is(col: string, val: null): {
          not(col: string, op: string, val: null): {
            order(col: string, opts: { ascending: boolean }): {
              limit(n: number): Promise<{ data: PendingChunkRow[] | null; error: { message: string } | null }>;
            };
          };
        };
      };
    }
  )
    .select('id, chunk_key, heading, chunk_text')
    .is('embedding_large', null)
    .not('chunk_text', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load pending document chunks for large embeddings: ${error.message}`);
  }

  return data ?? [];
}

async function fetchPendingLargeChunksByDocumentKind(
  limit: number,
  documentKind: string,
): Promise<PendingChunkRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await (
    supabase.schema('rag').from('document_chunk') as unknown as {
      select(cols: string): {
        eq(col: string, val: string): {
          is(col: string, val: null): {
            not(col: string, op: string, val: null): {
              order(col: string, opts: { ascending: boolean }): {
                limit(n: number): Promise<{
                  data: (PendingChunkRow & { document: { document_kind: string } })[] | null;
                  error: { message: string } | null;
                }>;
              };
            };
          };
        };
      };
    }
  )
    .select('id, chunk_key, heading, chunk_text, document!inner(document_kind)')
    .eq('document.document_kind', documentKind)
    .is('embedding_large', null)
    .not('chunk_text', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load pending ${documentKind} chunks for large embeddings: ${error.message}`);
  }

  return (
    (data ?? []) as Array<PendingChunkRow & { document: { document_kind: string } }>
  ).map(({ id, chunk_key, heading, chunk_text }) => ({ id, chunk_key, heading, chunk_text }));
}

async function countRemainingLargeChunks(): Promise<number> {
  const supabase = getSupabaseServiceRoleClient();
  const { count, error } = await (
    supabase.schema('rag').from('document_chunk') as unknown as {
      select(cols: string, opts: { count: 'exact'; head: true }): {
        is(col: string, val: null): Promise<{ count: number | null; error: { message: string } | null }>;
      };
    }
  )
    .select('id', { count: 'exact', head: true })
    .is('embedding_large', null);

  if (error) {
    throw new Error(`Failed to count remaining document chunks for large embeddings: ${error.message}`);
  }

  return count ?? 0;
}

async function countRemainingLargeChunksByDocumentKind(documentKind: string): Promise<number> {
  const supabase = getSupabaseServiceRoleClient();
  const { count, error } = await (
    supabase.schema('rag').from('document_chunk') as unknown as {
      select(cols: string, opts: { count: 'exact'; head: true }): {
        eq(col: string, val: string): {
          is(col: string, val: null): Promise<{ count: number | null; error: { message: string } | null }>;
        };
      };
    }
  )
    .select('id, document!inner(document_kind)', { count: 'exact', head: true })
    .eq('document.document_kind', documentKind)
    .is('embedding_large', null);

  if (error) {
    throw new Error(`Failed to count remaining ${documentKind} document chunks for large embeddings: ${error.message}`);
  }

  return count ?? 0;
}

async function persistLargeEmbeddings(
  chunks: PendingChunkRow[],
  embeddings: number[][],
  model: string,
): Promise<void> {
  for (const [index, chunk] of chunks.entries()) {
    const embedding = embeddings[index];
    if (!embedding || embedding.length !== LARGE_EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Large embedding for chunk ${chunk.chunk_key} had ${embedding?.length ?? 0} dimensions; expected ${LARGE_EMBEDDING_DIMENSIONS}.`,
      );
    }
  }

  const supabase = getSupabaseServiceRoleClient();

  for (const [index, chunk] of chunks.entries()) {
    const { error } = await (supabase.schema('rag').from('document_chunk') as unknown as {
      update(vals: { embedding_large: string; embedding_model_large: string }): {
        eq(col: string, val: string): Promise<{ error: { message: string } | null }>;
      };
    })
      .update({
        embedding_large: toVectorLiteral(embeddings[index]!),
        embedding_model_large: model,
      })
      .eq('id', chunk.id);

    if (error) {
      throw new Error(`Failed to persist large embedding for chunk ${chunk.chunk_key}: ${error.message}`);
    }
  }
}

export async function syncDocumentChunkEmbeddingsLarge(
  options: SyncDocumentChunkEmbeddingsOptions = {},
): Promise<SyncDocumentChunkEmbeddingsResult> {
  const model = options.model?.trim() || LARGE_EMBEDDING_MODEL;
  const documentKind = options.documentKind?.trim();
  const batchSize = clampPositiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
  const maxBatches = clampPositiveInteger(options.maxBatches, DEFAULT_MAX_BATCHES);

  const openai = getOpenAIClient();

  let batchesProcessed = 0;
  let chunksEmbedded = 0;

  while (batchesProcessed < maxBatches) {
    const chunks = documentKind
      ? await fetchPendingLargeChunksByDocumentKind(batchSize, documentKind)
      : await fetchPendingLargeChunks(batchSize);

    if (chunks.length === 0) {
      break;
    }

    const response = await withRetry(() =>
      openai.embeddings.create({
        model,
        input: chunks.map(buildEmbeddingInput),
      }),
    );

    const embeddings = response.data.map((item) => item.embedding);

    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Expected ${chunks.length} large embeddings from OpenAI but received ${embeddings.length}.`,
      );
    }

    await persistLargeEmbeddings(chunks, embeddings, model);

    batchesProcessed += 1;
    chunksEmbedded += chunks.length;

    if (chunks.length < batchSize) {
      break;
    }
  }

  return {
    model,
    batchSize,
    maxBatches,
    batchesProcessed,
    chunksEmbedded,
    remainingChunks: documentKind
      ? await countRemainingLargeChunksByDocumentKind(documentKind)
      : await countRemainingLargeChunks(),
  };
}

export async function createEmbedding(
  input: string,
  options: CreateEmbeddingOptions = {},
) {
  const model = getEmbeddingModel(options.model);
  const openai = getOpenAIClient();
  const response = await openai.embeddings.create({
    model,
    input: input.trim(),
  });
  const embedding = response.data[0]?.embedding;

  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Query embedding had ${embedding?.length ?? 0} dimensions; expected ${EMBEDDING_DIMENSIONS}.`,
    );
  }

  return {
    model,
    embedding,
  };
}
