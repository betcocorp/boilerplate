import OpenAI from 'openai';

import { createEmbedding } from '~/lib/rag/embeddings';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_REWRITE_MODEL = 'gpt-4.1-mini';

type SearchProductChunksOptions = {
  query: string;
  limit?: number;
  productLineKey?: string;
  minSimilarity?: number;
  model?: string;
  scope?: 'all' | 'products' | 'sds';
  languageCode?: string | null;
};

type SearchEmbeddingRow = {
  id: number;
  query_string: string;
  query_rewritten: string | null;
  embeddings: string | number[] | null;
  query_count: number;
  timing_sample_count: number;
  avg_total_search_ms?: number | null;
  avg_query_embedding_ms?: number | null;
  avg_query_rewrite_ms?: number | null;
  avg_cache_lookup_ms?: number | null;
  avg_embedding_create_ms?: number | null;
  avg_cache_persist_ms?: number | null;
  avg_similarity_search_ms?: number | null;
};

type ApproximateSearchEmbeddingRow = SearchEmbeddingRow & {
  match_source: 'query_string' | 'query_rewritten';
  matched_similarity: number;
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
  document_kind: string;
  similarity: number;
};

export type RagSearchResult = {
  query: string;
  model: string;
  limit: number;
  productLineKey: string | null;
  scope: 'all' | 'products' | 'sds';
  languageCode: string | null;
  minSimilarity: number | null;
  embeddingSource:
    | 'exact-cache-hit'
    | 'rewritten-cache-hit'
    | 'approximate-query-hit'
    | 'approximate-rewritten-hit'
    | 'new-embedding';
  timings: {
    totalMs: number;
    queryEmbeddingMs: number;
    queryRewriteMs: number;
    cacheLookupMs: number;
    embeddingCreateMs: number;
    cachePersistMs: number;
    similaritySearchMs: number;
  };
  matches: RagSearchMatch[];
};


type RagCorpusSearchMatch = Omit<RagSearchMatch, 'document_kind'> & {
  document_kind: string | null;
};

type DocumentLanguageRow = {
  id: string;
  language_code: string | null;
};

function clampLimit(limit?: number) {
  if (!Number.isFinite(limit) || !limit || limit < 1) {
    return 8;
  }

  return Math.min(Math.floor(limit), 20);
}

function normalizeMinSimilarity(minSimilarity?: number) {
  if (!Number.isFinite(minSimilarity)) {
    return null;
  }

  const normalized = minSimilarity! > 1 ? minSimilarity! / 100 : minSimilarity!;

  if (!Number.isFinite(normalized) || normalized < 0) {
    return null;
  }

  return Math.min(normalized, 1);
}

function normalizeScope(scope?: string) {
  if (scope === 'products' || scope === 'sds') {
    return scope;
  }

  if (scope === 'all') {
    return 'all' as const;
  }

  return 'products' as const;
}

function normalizeLanguageCode(languageCode?: string | null) {
  const normalized = languageCode?.trim().toUpperCase();
  return normalized || 'EN';
}

function normalizeForDedupe(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function nowMs() {
  return performance.now();
}

function elapsedMs(startedAt: number) {
  return Number((nowMs() - startedAt).toFixed(1));
}

function nextAverage(
  currentAverage: number | null | undefined,
  sampleCount: number,
  nextValue: number,
) {
  if (!Number.isFinite(currentAverage) || sampleCount <= 0) {
    return nextValue;
  }

  return Number(
    (((currentAverage as number) * sampleCount + nextValue) / (sampleCount + 1)).toFixed(
      3,
    ),
  );
}

async function persistSearchTimingAverages(
  row: Pick<
    SearchEmbeddingRow,
    | 'id'
    | 'timing_sample_count'
    | 'avg_total_search_ms'
    | 'avg_query_embedding_ms'
    | 'avg_query_rewrite_ms'
    | 'avg_cache_lookup_ms'
    | 'avg_embedding_create_ms'
    | 'avg_cache_persist_ms'
    | 'avg_similarity_search_ms'
  >,
  timings: RagSearchResult['timings'],
) {
  const supabase = getSupabaseServiceRoleClient();
  const sampleCount = row.timing_sample_count ?? 0;
  const { error } = await supabase
    .schema('rag')
    .from('search_embedding')
    .update({
      timing_sample_count: sampleCount + 1,
      avg_total_search_ms: nextAverage(
        row.avg_total_search_ms,
        sampleCount,
        timings.totalMs,
      ),
      avg_query_embedding_ms: nextAverage(
        row.avg_query_embedding_ms,
        sampleCount,
        timings.queryEmbeddingMs,
      ),
      avg_query_rewrite_ms: nextAverage(
        row.avg_query_rewrite_ms,
        sampleCount,
        timings.queryRewriteMs,
      ),
      avg_cache_lookup_ms: nextAverage(
        row.avg_cache_lookup_ms,
        sampleCount,
        timings.cacheLookupMs,
      ),
      avg_embedding_create_ms: nextAverage(
        row.avg_embedding_create_ms,
        sampleCount,
        timings.embeddingCreateMs,
      ),
      avg_cache_persist_ms: nextAverage(
        row.avg_cache_persist_ms,
        sampleCount,
        timings.cachePersistMs,
      ),
      avg_similarity_search_ms: nextAverage(
        row.avg_similarity_search_ms,
        sampleCount,
        timings.similaritySearchMs,
      ),
    })
    .eq('id', row.id);

  if (error) {
    throw new Error(`Failed to persist search timing averages: ${error.message}`);
  }
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

function getApproximateQueryThreshold(query: string) {
  return query.length < 12 ? 0.95 : 0.9;
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
): Promise<{
  row: Pick<
    SearchEmbeddingRow,
    | 'id'
    | 'timing_sample_count'
    | 'avg_total_search_ms'
    | 'avg_query_embedding_ms'
    | 'avg_query_rewrite_ms'
    | 'avg_cache_lookup_ms'
    | 'avg_embedding_create_ms'
    | 'avg_cache_persist_ms'
    | 'avg_similarity_search_ms'
  >;
  embedding: number[];
  model: string;
  source:
    | 'exact-cache-hit'
    | 'rewritten-cache-hit'
    | 'approximate-query-hit'
    | 'approximate-rewritten-hit'
    | 'new-embedding';
  timings: {
    queryEmbeddingMs: number;
    queryRewriteMs: number;
    cacheLookupMs: number;
    embeddingCreateMs: number;
    cachePersistMs: number;
  };
}> {
  const startedAt = nowMs();
  const supabase = getSupabaseServiceRoleClient();
  const normalizedQueryString = query.trim().replace(/\s+/g, ' ');
  const normalizedApproximateQuery = normalizeRewrittenQuery(query);
  let cacheLookupMs = 0;
  let embeddingCreateMs = 0;
  let cachePersistMs = 0;
  let queryRewriteMs = 0;

  const exactLookupStartedAt = nowMs();
  const { data: exactRows, error: exactLookupError } = await supabase
    .schema('rag')
    .from('search_embedding')
    .select(
      'id, query_string, query_rewritten, embeddings, query_count, timing_sample_count, avg_total_search_ms, avg_query_embedding_ms, avg_query_rewrite_ms, avg_cache_lookup_ms, avg_embedding_create_ms, avg_cache_persist_ms, avg_similarity_search_ms',
    )
    .eq('query_string', normalizedQueryString)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(1);
  cacheLookupMs += elapsedMs(exactLookupStartedAt);

  if (exactLookupError) {
    throw new Error(
      `Failed to lookup cached query embedding by original query: ${exactLookupError.message}`,
    );
  }

  const exact = ((exactRows ?? [])[0] ?? null) as SearchEmbeddingRow | null;
  const exactEmbedding = parseVectorEmbedding(exact?.embeddings ?? null);
  const resolvedModel = getEmbeddingModelName(model);

  if (exact && exactEmbedding) {
    const persistStartedAt = nowMs();
    const { error: updateError } = await supabase
      .schema('rag')
      .from('search_embedding')
      .update({
        query_count: (exact.query_count ?? 0) + 1,
      })
      .eq('id', exact.id);
    cachePersistMs += elapsedMs(persistStartedAt);

    if (updateError) {
      throw new Error(
        `Failed to update cached query embedding usage: ${updateError.message}`,
      );
    }

    return {
      row: exact,
      embedding: exactEmbedding,
      model: resolvedModel,
      source: 'exact-cache-hit',
      timings: {
        queryEmbeddingMs: elapsedMs(startedAt),
        queryRewriteMs,
        cacheLookupMs,
        embeddingCreateMs,
        cachePersistMs,
      },
    };
  }

  const approximateLookupStartedAt = nowMs();
  const { data: approximateRow, error: approximateError } = await supabase
    .schema('rag')
    .rpc('find_similar_search_embedding', {
      p_query: normalizedApproximateQuery,
      p_query_similarity_threshold: getApproximateQueryThreshold(
        normalizedApproximateQuery,
      ),
      p_rewritten_similarity_threshold: 0.88,
    });
  cacheLookupMs += elapsedMs(approximateLookupStartedAt);

  if (approximateError) {
    throw new Error(
      `Failed to lookup approximate cached query embedding: ${approximateError.message}`,
    );
  }

  const approximate = (
    Array.isArray(approximateRow)
      ? (approximateRow[0] ?? null)
      : (approximateRow ?? null)
  ) as ApproximateSearchEmbeddingRow | null;
  const approximateEmbedding = parseVectorEmbedding(approximate?.embeddings ?? null);

  if (approximate && approximateEmbedding) {
    const persistStartedAt = nowMs();
    const { error: updateError } = await supabase
      .schema('rag')
      .from('search_embedding')
      .update({
        query_count: (approximate.query_count ?? 0) + 1,
      })
      .eq('id', approximate.id);
    cachePersistMs += elapsedMs(persistStartedAt);

    if (updateError) {
      throw new Error(
        `Failed to update approximate cached query embedding usage: ${updateError.message}`,
      );
    }

    return {
      row: approximate,
      embedding: approximateEmbedding,
      model: resolvedModel,
      source:
        approximate.match_source === 'query_string'
          ? 'approximate-query-hit'
          : 'approximate-rewritten-hit',
      timings: {
        queryEmbeddingMs: elapsedMs(startedAt),
        queryRewriteMs,
        cacheLookupMs,
        embeddingCreateMs,
        cachePersistMs,
      },
    };
  }

  let rewrittenQuery = exact?.query_rewritten
    ? normalizeRewrittenQuery(exact.query_rewritten)
    : null;
  let existing = exact;

  if (!existing) {
    const rewriteStartedAt = nowMs();
    rewrittenQuery = await rewriteQueryWithOpenAI(query);
    queryRewriteMs = elapsedMs(rewriteStartedAt);

    const rewrittenLookupStartedAt = nowMs();
    const { data: existingRow, error: existingError } = await supabase
      .schema('rag')
      .from('search_embedding')
      .select(
        'id, query_string, query_rewritten, embeddings, query_count, timing_sample_count, avg_total_search_ms, avg_query_embedding_ms, avg_query_rewrite_ms, avg_cache_lookup_ms, avg_embedding_create_ms, avg_cache_persist_ms, avg_similarity_search_ms',
      )
      .eq('query_rewritten', rewrittenQuery)
      .is('deleted_at', null)
      .maybeSingle();
    cacheLookupMs += elapsedMs(rewrittenLookupStartedAt);

    if (existingError) {
      throw new Error(
        `Failed to lookup cached query embedding: ${existingError.message}`,
      );
    }

    existing = (existingRow ?? null) as SearchEmbeddingRow | null;
  }

  const cachedEmbedding = parseVectorEmbedding(existing?.embeddings ?? null);

  if (existing && cachedEmbedding) {
    const persistStartedAt = nowMs();
    const { error: updateError } = await supabase
      .schema('rag')
      .from('search_embedding')
      .update({
        query_string: normalizedQueryString,
        query_count: (existing.query_count ?? 0) + 1,
      })
      .eq('id', existing.id);
    cachePersistMs += elapsedMs(persistStartedAt);

    if (updateError) {
      throw new Error(
        `Failed to update cached query embedding usage: ${updateError.message}`,
      );
    }

    return {
      row: existing,
      embedding: cachedEmbedding,
      model: resolvedModel,
      source: existing.id === exact?.id ? 'exact-cache-hit' : 'rewritten-cache-hit',
      timings: {
        queryEmbeddingMs: elapsedMs(startedAt),
        queryRewriteMs,
        cacheLookupMs,
        embeddingCreateMs,
        cachePersistMs,
      },
    };
  }

  const embeddingStartedAt = nowMs();
  const { embedding, model: createdModel } = await createEmbedding(query, { model });
  const embeddingLiteral = toVectorLiteral(embedding);
  embeddingCreateMs = elapsedMs(embeddingStartedAt);

  if (existing) {
    const persistStartedAt = nowMs();
    const { error: updateError } = await supabase
      .schema('rag')
      .from('search_embedding')
      .update({
        query_string: normalizedQueryString,
        query_rewritten: rewrittenQuery,
        embeddings: embeddingLiteral,
        query_count: (existing.query_count ?? 0) + 1,
      })
      .eq('id', existing.id);
    cachePersistMs += elapsedMs(persistStartedAt);

    if (updateError) {
      throw new Error(
        `Failed to persist cached query embedding: ${updateError.message}`,
      );
    }
  } else {
    const persistStartedAt = nowMs();
    const { data: insertedRow, error: insertError } = await supabase
      .schema('rag')
      .from('search_embedding')
      .insert({
        query_string: normalizedQueryString,
        query_rewritten: rewrittenQuery,
        embeddings: embeddingLiteral,
        query_count: 1,
      })
      .select(
        'id, timing_sample_count, avg_total_search_ms, avg_query_embedding_ms, avg_query_rewrite_ms, avg_cache_lookup_ms, avg_embedding_create_ms, avg_cache_persist_ms, avg_similarity_search_ms',
      )
      .single();
    cachePersistMs += elapsedMs(persistStartedAt);

    if (insertError) {
      if ((insertError as { code?: string }).code === '23505') {
        return getCachedOrNewEmbedding(query, model);
      }
      throw new Error(`Failed to cache query embedding: ${insertError.message}`);
    }

    return {
      row: insertedRow as SearchEmbeddingRow,
      embedding,
      model: createdModel,
      source: 'new-embedding',
      timings: {
        queryEmbeddingMs: elapsedMs(startedAt),
        queryRewriteMs,
        cacheLookupMs,
        embeddingCreateMs,
        cachePersistMs,
      },
    };
  }

  return {
    row: existing,
    embedding,
    model: createdModel,
    source: 'new-embedding',
    timings: {
      queryEmbeddingMs: elapsedMs(startedAt),
      queryRewriteMs,
      cacheLookupMs,
      embeddingCreateMs,
      cachePersistMs,
    },
  };
}

/** Semantic search over `product_line_profile` chunks (one RAG document per legacy product line). */
export async function searchProductChunks(
  options: SearchProductChunksOptions,
): Promise<RagSearchResult> {
  const startedAt = nowMs();
  const query = options.query.trim();

  if (!query) {
    throw new Error('A search query is required.');
  }

  const limit = clampLimit(options.limit);
  const productLineKey = options.productLineKey?.trim() || null;
  const scope = normalizeScope(options.scope);
  const minSimilarity = normalizeMinSimilarity(options.minSimilarity);
  const languageCode = normalizeLanguageCode(options.languageCode);

  const {
    row,
    embedding,
    model,
    source,
    timings: embeddingTimings,
  } = await getCachedOrNewEmbedding(query, options.model);

  const supabase = getSupabaseServiceRoleClient();
  const rag = supabase.schema('rag');
  const similaritySearchStartedAt = nowMs();
  const { data, error } =
    scope === 'products'
      ? await rag.rpc('match_product_chunks', {
          query_embedding: toVectorLiteral(embedding),
          match_count: limit,
          filter_product_key: undefined,
          filter_product_line_key: productLineKey || undefined,
        })
      : await (rag as any).rpc('match_corpus_chunks', {
          query_embedding: toVectorLiteral(embedding),
          match_count: limit,
          filter_product_line_key: productLineKey || undefined,
          filter_scope: scope,
        });
  const similaritySearchMs = elapsedMs(similaritySearchStartedAt);

  if (error) {
    throw new Error(`Failed to run similarity search: ${error.message}`);
  }

  const timings = {
    totalMs: elapsedMs(startedAt),
    queryEmbeddingMs: embeddingTimings.queryEmbeddingMs,
    queryRewriteMs: embeddingTimings.queryRewriteMs,
    cacheLookupMs: embeddingTimings.cacheLookupMs,
    embeddingCreateMs: embeddingTimings.embeddingCreateMs,
    cachePersistMs: embeddingTimings.cachePersistMs,
    similaritySearchMs,
  };

  try {
    await persistSearchTimingAverages(row, timings);
  } catch {
    // Timing persistence is best-effort and should not block search results.
  }

  const mappedMatches = (
    scope === 'products'
      ? ((data ?? []) as RagSearchMatch[]).map((match) => ({
          ...match,
          document_kind: 'product_line_profile',
        }))
      : ((data ?? []) as RagCorpusSearchMatch[]).map((match) => ({
          ...match,
          document_kind: match.document_kind ?? 'unknown',
        }))
  )
    .map((match) => ({
      ...match,
      similarity: Number(match.similarity),
    }))
    .filter((match) => minSimilarity === null || match.similarity >= minSimilarity);

  let languageFilteredMatches = mappedMatches;
  if (languageCode) {
    const documentIds = Array.from(
      new Set(
        mappedMatches
          .map((match) => match.document_id)
          .filter((value): value is string => Boolean(value)),
      ),
    );

    if (documentIds.length > 0) {
      const { data: documentRows, error: documentError } = await supabase
        .schema('rag')
        .from('document')
        .select('id, language_code')
        .in('id', documentIds);

      if (documentError) {
        throw new Error(
          `Failed to enforce language filter for similarity search: ${documentError.message}`,
        );
      }

      const languageByDocumentId = new Map<string, string | null>(
        ((documentRows ?? []) as DocumentLanguageRow[]).map((row) => [
          row.id,
          row.language_code,
        ]),
      );

      languageFilteredMatches = mappedMatches.filter((match) => {
        const value = languageByDocumentId.get(match.document_id);
        return typeof value === 'string' && value.toUpperCase() === languageCode;
      });
    }
  }

  const dedupedMatches: RagSearchMatch[] = [];
  const seenSdsChunkKeys = new Set<string>();

  for (const match of languageFilteredMatches) {
    if (match.document_kind !== 'sds') {
      dedupedMatches.push(match);
      continue;
    }

    const sdsDuplicateKey = [
      normalizeForDedupe(match.document_title),
      String(match.chunk_index),
      normalizeForDedupe(match.chunk_text).slice(0, 280),
    ].join('|');

    if (seenSdsChunkKeys.has(sdsDuplicateKey)) {
      continue;
    }

    seenSdsChunkKeys.add(sdsDuplicateKey);
    dedupedMatches.push(match);
  }

  return {
    query,
    model,
    limit,
    productLineKey,
    scope,
    languageCode,
    minSimilarity,
    embeddingSource: source,
    timings,
    matches: dedupedMatches,
  };
}

