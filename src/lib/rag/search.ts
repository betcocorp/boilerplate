import OpenAI from 'openai';

import { createEmbedding } from '~/lib/rag/embeddings';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_REWRITE_MODEL = 'gpt-4.1-mini';

type SearchProductChunksOptions = {
  query: string;
  limit?: number;
  productLineKey?: string;
  model?: string;
};

type SearchEmbeddingRow = {
  id: number;
  query_string: string;
  query_rewritten: string | null;
  embeddings: string | number[] | null;
  query_count: number;
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

function getEmbeddingModelName(model?: string) {
  return model?.trim() || process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
}

function normalizeRewrittenQuery(query: string) {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  return new OpenAI({ apiKey });
}

async function rewriteQueryWithOpenAI(query: string) {
  const normalizedInput = normalizeRewrittenQuery(query);

  if (!normalizedInput) {
    return normalizedInput;
  }

  const openai = getOpenAIClient();

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_QUERY_REWRITE_MODEL || DEFAULT_REWRITE_MODEL,
      temperature: 0,
      max_completion_tokens: 80,
      messages: [
        {
          role: 'system',
          content:
            'Rewrite user search queries into concise product-line retrieval queries. Keep original intent, preserve key nouns and modifiers, and output only a single plain-text query.',
        },
        {
          role: 'user',
          content: query,
        },
      ],
    });

    const rewritten = response.choices[0]?.message?.content?.trim();

    if (!rewritten) {
      return normalizedInput;
    }

    return normalizeRewrittenQuery(rewritten);
  } catch {
    return normalizedInput;
  }
}

function parseVectorEmbedding(value: string | number[] | null): number[] | null {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'number') ? value : null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return null;
  }

  const contents = trimmed.slice(1, -1).trim();
  if (!contents) {
    return [];
  }

  const parsed = contents.split(',').map((item) => Number(item.trim()));
  return parsed.every((item) => Number.isFinite(item)) ? parsed : null;
}

async function getCachedOrNewEmbedding(
  query: string,
  model?: string,
): Promise<{ embedding: number[]; model: string }> {
  const supabase = getSupabaseServiceRoleClient();
  const rewrittenQuery = await rewriteQueryWithOpenAI(query);
  const normalizedQueryString = query.trim().replace(/\s+/g, ' ');

  const { data: exactRows, error: exactLookupError } = await supabase
    .schema('rag')
    .from('search_embedding')
    .select('id, query_string, query_rewritten, embeddings, query_count')
    .eq('query_string', normalizedQueryString)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(1);

  if (exactLookupError) {
    throw new Error(
      `Failed to lookup cached query embedding by original query: ${exactLookupError.message}`,
    );
  }

  const exact = ((exactRows ?? [])[0] ?? null) as SearchEmbeddingRow | null;
  const exactEmbedding = parseVectorEmbedding(exact?.embeddings ?? null);
  const resolvedModel = getEmbeddingModelName(model);

  if (exact && exactEmbedding) {
    const { error: updateError } = await supabase
      .schema('rag')
      .from('search_embedding')
      .update({
        query_rewritten: rewrittenQuery,
        query_count: (exact.query_count ?? 0) + 1,
      })
      .eq('id', exact.id);

    if (updateError) {
      throw new Error(
        `Failed to update cached query embedding usage: ${updateError.message}`,
      );
    }

    return {
      embedding: exactEmbedding,
      model: resolvedModel,
    };
  }

  const { data: existingRow, error: existingError } = await supabase
    .schema('rag')
    .from('search_embedding')
    .select('id, query_string, query_rewritten, embeddings, query_count')
    .eq('query_rewritten', rewrittenQuery)
    .is('deleted_at', null)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Failed to lookup cached query embedding: ${existingError.message}`);
  }

  const existing = (existingRow ?? null) as SearchEmbeddingRow | null;
  const cachedEmbedding = parseVectorEmbedding(existing?.embeddings ?? null);

  if (existing && cachedEmbedding) {
    const { error: updateError } = await supabase
      .schema('rag')
      .from('search_embedding')
      .update({
        query_string: normalizedQueryString,
        query_count: (existing.query_count ?? 0) + 1,
      })
      .eq('id', existing.id);

    if (updateError) {
      throw new Error(
        `Failed to update cached query embedding usage: ${updateError.message}`,
      );
    }

    return {
      embedding: cachedEmbedding,
      model: resolvedModel,
    };
  }

  const { embedding, model: createdModel } = await createEmbedding(query, { model });

  if (existing) {
    const { error: updateError } = await supabase
      .schema('rag')
      .from('search_embedding')
      .update({
        query_string: normalizedQueryString,
        query_rewritten: rewrittenQuery,
        embeddings: embedding,
        query_count: (existing.query_count ?? 0) + 1,
      })
      .eq('id', existing.id);

    if (updateError) {
      throw new Error(
        `Failed to persist cached query embedding: ${updateError.message}`,
      );
    }
  } else {
    const { error: insertError } = await supabase
      .schema('rag')
      .from('search_embedding')
      .insert({
        query_string: normalizedQueryString,
        query_rewritten: rewrittenQuery,
        embeddings: embedding,
        query_count: 1,
      });

    if (insertError) {
      if ((insertError as { code?: string }).code === '23505') {
        return getCachedOrNewEmbedding(query, model);
      }
      throw new Error(`Failed to cache query embedding: ${insertError.message}`);
    }
  }

  return {
    embedding,
    model: createdModel,
  };
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
  const productLineKey = options.productLineKey?.trim() || null;

  const { embedding, model } = await getCachedOrNewEmbedding(
    query,
    options.model,
  );

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('rag')
    .rpc('match_product_chunks', {
      query_embedding: toVectorLiteral(embedding),
      match_count: limit,
      filter_product_key: null,
      filter_product_line_key: productLineKey,
    });

  if (error) {
    throw new Error(`Failed to run similarity search: ${error.message}`);
  }

  return {
    query,
    model,
    limit,
    productLineKey,
    matches: ((data ?? []) as RagSearchMatch[]).map((match) => ({
      ...match,
      similarity: Number(match.similarity),
    })),
  };
}
