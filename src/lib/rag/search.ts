import { createEmbedding } from '~/lib/rag/embeddings';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

type SearchProductChunksOptions = {
  query: string;
  limit?: number;
  /** If set, only lines whose `variant_product_keys` metadata includes this `ProductsKey`. */
  productKey?: string;
  productLineKey?: string;
  model?: string;
};

export type RagSearchMatch = {
  chunk_id: string;
  chunk_key: string;
  chunk_index: number;
  heading: string | null;
  chunk_text: string;
  section_path: string[] | null;
  token_count: number | null;
  document_id: string;
  document_key: string;
  document_title: string;
  entity_id: string | null;
  product_key: string | null;
  sku: string | null;
  product_line_key: string | null;
  source_pk: string;
  similarity: number;
};

export type RagSearchResult = {
  query: string;
  model: string;
  limit: number;
  productKey: string | null;
  productLineKey: string | null;
  matches: RagSearchMatch[];
};

function clampLimit(limit?: number) {
  if (!Number.isFinite(limit) || !limit || limit < 1) {
    return 8;
  }

  return Math.min(Math.floor(limit), 20);
}

function toVectorLiteral(embedding: number[]) {
  return `[${embedding.join(',')}]`;
}

/** Semantic search over `product_line_profile` chunks (one RAG document per legacy product line). */
export async function searchProductChunks(
  options: SearchProductChunksOptions,
): Promise<RagSearchResult> {
  const query = options.query.trim();

  if (!query) {
    throw new Error('A search query is required.');
  }

  const limit = clampLimit(options.limit);
  const productKey = options.productKey?.trim() || null;
  const productLineKey = options.productLineKey?.trim() || null;

  const { embedding, model } = await createEmbedding(query, {
    model: options.model,
  });

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('rag')
    .rpc('match_product_chunks', {
      query_embedding: toVectorLiteral(embedding),
      match_count: limit,
      filter_product_key: productKey,
      filter_product_line_key: productLineKey,
    });

  if (error) {
    throw new Error(`Failed to run similarity search: ${error.message}`);
  }

  return {
    query,
    model,
    limit,
    productKey,
    productLineKey,
    matches: ((data ?? []) as RagSearchMatch[]).map((match) => ({
      ...match,
      similarity: Number(match.similarity),
    })),
  };
}
