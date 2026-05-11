import { getOpenAIClient } from '~/lib/openai/client';
import { clampPositiveInteger } from '~/lib/utils/params';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
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
  const supabase = getSupabaseServiceRoleClient();

  for (const [index, chunk] of chunks.entries()) {
    const embedding = embeddings[index];

    if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding for chunk ${chunk.chunk_key} had ${embedding?.length ?? 0} dimensions; expected ${EMBEDDING_DIMENSIONS}.`,
      );
    }

    const { error } = await supabase
      .schema('rag')
      .from('document_chunk')
      .update({
        embedding: toVectorLiteral(embedding),
        embedding_model: model,
      })
      .eq('id', chunk.id);

    if (error) {
      throw new Error(
        `Failed to persist embedding for chunk ${chunk.chunk_key}: ${error.message}`,
      );
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

    const response = await openai.embeddings.create({
      model,
      input: chunks.map(buildEmbeddingInput),
    });

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
