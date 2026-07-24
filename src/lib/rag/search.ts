import { createEmbedding, EMBEDDING_MODEL } from '~/lib/rag/embeddings';
import { rerankChunks } from '~/lib/rag/rerank';
import { getOpenAIClient } from '~/lib/openai/client';
import { normalizeForDedupe } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
const DEFAULT_REWRITE_MODEL = 'gpt-4.1-mini';
const APPROX_QUERY_THRESHOLD_SHORT = 0.95;
const APPROX_QUERY_THRESHOLD_LONG = 0.9;
const APPROX_REWRITTEN_SIMILARITY_THRESHOLD = 0.88;

/**
 * Search scope. `all | products | sds | efficacy` map to the RPC's native `filter_scope`
 * (B0-230 added `efficacy`, mirroring `sds`). `knowledge` and `label` are additional
 * `document_kind`s that the corpus RPC does not yet filter on natively (see the
 * reconciliation-required migration note), so they are resolved as `filter_scope: 'all'`
 * plus an application-layer `document_kind` filter over the returned rows.
 */
export type SearchScope = 'all' | 'products' | 'sds' | 'efficacy' | 'knowledge' | 'label';

/** Scopes handled natively by the RPC's `filter_scope` argument. */
type RpcScope = 'all' | 'products' | 'sds' | 'efficacy';

/** Scopes resolved by an application-layer document_kind filter over `filter_scope: 'all'`. */
const APP_KIND_SCOPES: Record<'knowledge' | 'label', string> = {
  knowledge: 'knowledge',
  label: 'label',
};

type SearchProductChunksOptions = {
  query: string;
  limit?: number;
  productLineKey?: string;
  productKey?: string;
  sectionType?: string;
  minSimilarity?: number;
  model?: string;
  scope?: SearchScope;
  useHybrid?: boolean;
  useReranker?: boolean;
  useMultiIntent?: boolean;
};

type SearchEmbeddingRow = {
  id: number;
  query_string: string;
  query_rewritten: string | null;
  embeddings_large: string | number[] | null;
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
  section_type: string | null;
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
  productKey: string | null;
  sectionType: string | null;
  scope: SearchScope;
  minSimilarity: number | null;
  retrieval_strategy: 'vector' | 'hybrid' | 'vector+reranked' | 'hybrid+reranked';
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
    rerankMs: number;
  };
  matches: RagSearchMatch[];
};


type RagCorpusSearchMatch = Omit<RagSearchMatch, 'document_kind'> & {
  document_kind: string | null;
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

function normalizeScope(scope?: string): RpcScope {
  if (scope === 'products' || scope === 'sds' || scope === 'efficacy') {
    return scope;
  }

  if (scope === 'all') {
    return 'all' as const;
  }

  return 'products' as const;
}

/**
 * Resolves a requested scope into: the value echoed back on the result, the RPC-native
 * `filter_scope` to send, and an optional application-layer `document_kind` filter.
 *
 * `knowledge`/`label` are not yet supported by the corpus RPC's `filter_scope` (the live function
 * body clamps unknown scopes to `all`), so they are served as `filter_scope: 'all'` + a
 * post-retrieval `document_kind` filter. Once the reconciliation-required migration pushes these
 * kinds into the RPC, `rpcScope` can pass them through directly and the app-layer filter dropped.
 */
function resolveSearchScope(scope?: string): {
  requested: SearchScope;
  rpcScope: RpcScope;
  documentKindFilter: string | null;
} {
  const raw = (scope ?? '').trim().toLowerCase();
  if (raw === 'knowledge' || raw === 'label') {
    return { requested: raw, rpcScope: 'all', documentKindFilter: APP_KIND_SCOPES[raw] };
  }
  const rpcScope = normalizeScope(raw);
  return { requested: rpcScope, rpcScope, documentKindFilter: null };
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
  return model?.trim() || EMBEDDING_MODEL;
}

function normalizeRewrittenQuery(query: string) {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function getApproximateQueryThreshold(query: string) {
  return query.length < 12 ? APPROX_QUERY_THRESHOLD_SHORT : APPROX_QUERY_THRESHOLD_LONG;
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
            'You rewrite search queries for Betco, a commercial cleaning products company. ' +
            'Rules: preserve all product names, SKUs, and chemical names exactly. ' +
            'Expand abbreviations: RTU → ready to use, VCT → vinyl composition tile, LVT → luxury vinyl tile, ' +
            'SDS → safety data sheet, GHS → globally harmonized system, EPA → EPA registered, ' +
            'RTU → ready to use, HCS → hazard communication standard. ' +
            'Add domain synonyms where they clarify intent: "use on" → application surface, ' +
            '"safe for" → compatible surfaces, "mix ratio" / "dilution" → dilution ratio concentrate. ' +
            'Strip conversational filler: "how do I", "can you tell me", "what is the". ' +
            'Output exactly one plain-text retrieval query under 20 words — no explanation, no trailing punctuation.',
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

async function expandQueryIntents(query: string): Promise<string[]> {
  const normalized = query.trim();
  if (!normalized) return [normalized];

  const openai = getOpenAIClient();
  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_QUERY_REWRITE_MODEL || DEFAULT_REWRITE_MODEL,
      temperature: 0,
      max_completion_tokens: 200,
      messages: [
        {
          role: 'system',
          content:
            'You decompose user questions about Betco commercial cleaning products into focused retrieval sub-queries. ' +
            'If the input contains 2–3 distinct questions or intents, split it into that many self-contained sub-queries. ' +
            'If it is a single intent, return it as a one-element array unchanged. ' +
            'Respond with a JSON array of strings only — no markdown, no explanation. ' +
            'Preserve product names, SKUs, and technical terms exactly. ' +
            'Example input: "what is the dilution for Green Earth and is it safe on VCT floors?" ' +
            'Example output: ["Green Earth dilution ratio concentrate", "Green Earth VCT vinyl tile floor application safety"]',
        },
        { role: 'user', content: normalized },
      ],
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return [normalized];

    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return [normalized];

    const queries = (parsed as unknown[])
      .map((q) => (typeof q === 'string' ? q.trim() : ''))
      .filter((q) => q.length > 0);

    return queries.length > 0 ? queries : [normalized];
  } catch {
    return [normalized];
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
    | 'query_rewritten'
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
      'id, query_string, query_rewritten, embeddings_large, query_count, timing_sample_count, avg_total_search_ms, avg_query_embedding_ms, avg_query_rewrite_ms, avg_cache_lookup_ms, avg_embedding_create_ms, avg_cache_persist_ms, avg_similarity_search_ms',
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

  const exact = ((exactRows ?? [])[0] ?? null) as unknown as SearchEmbeddingRow | null;
  const exactEmbedding = parseVectorEmbedding(exact?.embeddings_large ?? null);
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
      p_rewritten_similarity_threshold: APPROX_REWRITTEN_SIMILARITY_THRESHOLD,
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
  ) as unknown as ApproximateSearchEmbeddingRow | null;
  const approximateEmbedding = parseVectorEmbedding(approximate?.embeddings_large ?? null);

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
        'id, query_string, query_rewritten, embeddings_large, query_count, timing_sample_count, avg_total_search_ms, avg_query_embedding_ms, avg_query_rewrite_ms, avg_cache_lookup_ms, avg_embedding_create_ms, avg_cache_persist_ms, avg_similarity_search_ms',
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

  const cachedEmbedding = parseVectorEmbedding(existing?.embeddings_large ?? null);

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
        embeddings_large: embeddingLiteral,
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
        embeddings_large: embeddingLiteral,
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

type HybridRpcClient = {
  rpc: (
    fn: 'match_product_chunks_hybrid' | 'match_corpus_chunks_hybrid' | 'match_product_chunks',
    args: Record<string, unknown>,
  ) => Promise<{ data: RagCorpusSearchMatch[] | null; error: { message: string } | null }>;
};

type MatchRpcOpts = {
  scope: 'all' | 'products' | 'sds' | 'efficacy';
  useHybrid: boolean;
  rpcLimit: number;
  productLineKey: string | null;
  productKey: string | null;
  sectionType: string | null;
};

async function callMatchRpc(
  embedding: number[],
  hybridQueryText: string,
  opts: MatchRpcOpts,
): Promise<RagCorpusSearchMatch[]> {
  const supabase = getSupabaseServiceRoleClient();
  const rag = supabase.schema('rag');

  type CorpusRpcClient = {
    rpc: (
      fn: 'match_corpus_chunks' | 'match_corpus_chunks_hybrid',
      args: {
        query_embedding: string;
        query_text?: string;
        match_count: number;
        filter_product_line_key?: string;
        filter_scope: 'all' | 'products' | 'sds' | 'efficacy';
        filter_section_type?: string;
      },
    ) => Promise<{ data: RagCorpusSearchMatch[] | null; error: { message: string } | null }>;
  };

  const { data, error } =
    opts.scope === 'products'
      ? opts.useHybrid
        ? // Send every filter key explicitly (null, not undefined) so PostgREST resolves to the
          // section-aware overload. supabase-js strips undefined keys, which left the arg set
          // matching BOTH `match_product_chunks_hybrid` overloads (42725 "function is not unique").
          await (rag as unknown as HybridRpcClient).rpc('match_product_chunks_hybrid', {
            query_embedding: toVectorLiteral(embedding),
            query_text: hybridQueryText,
            match_count: opts.rpcLimit,
            filter_product_key: opts.productKey || null,
            filter_product_line_key: opts.productLineKey || null,
            filter_section_type: opts.sectionType || null,
          })
        : // Same null-not-undefined trick as the hybrid branch above: match_product_chunks also
          // has two live overloads (with/without filter_section_type), and supabase-js strips
          // undefined keys, which left the arg set ambiguous between them (42725).
          await (rag as unknown as HybridRpcClient).rpc('match_product_chunks', {
            query_embedding: toVectorLiteral(embedding),
            match_count: opts.rpcLimit,
            filter_product_key: opts.productKey || null,
            filter_product_line_key: opts.productLineKey || null,
            filter_section_type: opts.sectionType || null,
          })
      : await (rag as unknown as CorpusRpcClient).rpc(
          opts.useHybrid ? 'match_corpus_chunks_hybrid' : 'match_corpus_chunks',
          {
            query_embedding: toVectorLiteral(embedding),
            ...(opts.useHybrid ? { query_text: hybridQueryText } : {}),
            match_count: opts.rpcLimit,
            filter_product_line_key: opts.productLineKey || undefined,
            filter_scope: opts.scope,
            filter_section_type: opts.sectionType || undefined,
          },
        );

  if (error) throw new Error(`Failed to run similarity search: ${error.message}`);
  return (data ?? []) as RagCorpusSearchMatch[];
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
  const productKey = options.productKey?.trim() || null;
  const sectionType = options.sectionType?.trim() || null;
  const {
    requested: requestedScope,
    rpcScope: scope,
    documentKindFilter,
  } = resolveSearchScope(options.scope);
  const minSimilarity = normalizeMinSimilarity(options.minSimilarity);
  const useHybrid = options.useHybrid ?? false;
  const useReranker = options.useReranker ?? process.env.ENABLE_RERANKER === 'true';
  const useMultiIntent = options.useMultiIntent ?? false;
  // Fetch extra candidates when reranking so the reranker has a larger pool to
  // reorder before we slice down to the requested limit. When an app-layer document_kind
  // filter is active (knowledge/label), over-fetch so enough matching-kind rows survive.
  const rpcLimit = documentKindFilter
    ? Math.min(Math.max(limit * 10, 100), 200)
    : useReranker
      ? Math.min(limit * 5, 50)
      : limit;

  const {
    row,
    embedding,
    model,
    source,
    timings: embeddingTimings,
  } = await getCachedOrNewEmbedding(query, options.model);

  // For hybrid search, prefer the rewritten query as BM25 text — it has
  // cleaner lexemes than the raw user input.
  const hybridQueryText = row?.query_rewritten ?? query;

  const rpcOpts: MatchRpcOpts = {
    scope,
    useHybrid,
    rpcLimit,
    productLineKey,
    productKey,
    sectionType,
  };
  const similaritySearchStartedAt = nowMs();

  let rawMatches: RagCorpusSearchMatch[];

  if (useMultiIntent) {
    const intents = await expandQueryIntents(query);
    if (intents.length > 1) {
      const subResults = await Promise.all(
        intents.map(async (subQuery) => {
          const subEmb = await getCachedOrNewEmbedding(subQuery, options.model);
          const subHybridText = subEmb.row?.query_rewritten ?? subQuery;
          return callMatchRpc(subEmb.embedding, subHybridText, rpcOpts);
        }),
      );
      // Merge: dedup by chunk_id keeping the highest similarity score across sub-queries
      const byChunkId = new Map<string, RagCorpusSearchMatch>();
      for (const results of subResults) {
        for (const match of results) {
          const existing = byChunkId.get(match.chunk_id);
          if (!existing || (match.similarity as number) > (existing.similarity as number)) {
            byChunkId.set(match.chunk_id, match);
          }
        }
      }
      rawMatches = Array.from(byChunkId.values())
        .sort((a, b) => (b.similarity as number) - (a.similarity as number))
        .slice(0, rpcLimit);
    } else {
      rawMatches = await callMatchRpc(embedding, hybridQueryText, rpcOpts);
    }
  } else {
    rawMatches = await callMatchRpc(embedding, hybridQueryText, rpcOpts);
  }

  const similaritySearchMs = elapsedMs(similaritySearchStartedAt);

  // Map RPC results to typed matches (no minSimilarity filter yet — applied after
  // optional reranking so the reranker always sees the full candidate set).
  const mappedMatches = (
    scope === 'products'
      ? (rawMatches as RagSearchMatch[]).map((match) => ({
          ...match,
          document_kind: 'product_line_profile',
        }))
      : rawMatches.map((match) => ({
          ...match,
          document_kind: match.document_kind ?? 'unknown',
        }))
  ).map((match) => ({
    ...match,
    similarity: Number(match.similarity),
  }));

  // App-layer scope: keep only the requested document_kind (knowledge/label) before ranking.
  const kindFilteredMatches = documentKindFilter
    ? mappedMatches.filter((match) => match.document_kind === documentKindFilter)
    : mappedMatches;

  // Rerank phase — reorders the candidate pool by cross-encoder relevance then
  // slices to `limit`. Falls back to cosine order if the API is unavailable.
  let rerankMs = 0;
  let rankedMatches = kindFilteredMatches;

  if (useReranker && kindFilteredMatches.length > 0) {
    const rerankStartedAt = nowMs();
    const reranked = await rerankChunks(query, kindFilteredMatches).catch(() => null);
    rerankMs = elapsedMs(rerankStartedAt);

    if (reranked && reranked.length > 0) {
      const scoreMap = new Map(reranked.map((r) => [r.chunk_id, r.relevance_score]));
      rankedMatches = [...kindFilteredMatches]
        .sort((a, b) => (scoreMap.get(b.chunk_id) ?? 0) - (scoreMap.get(a.chunk_id) ?? 0))
        .slice(0, limit);
    } else {
      rankedMatches = kindFilteredMatches.slice(0, limit);
    }
  }

  const filteredMatches = rankedMatches
    .filter((match) => minSimilarity === null || match.similarity >= minSimilarity)
    // Over-fetch for the app-layer kind filter means the non-rerank path can still hold more
    // than `limit` rows here; trim to the requested count (no-op for the native scopes).
    .slice(0, limit);

  const timings = {
    totalMs: elapsedMs(startedAt) + rerankMs,
    queryEmbeddingMs: embeddingTimings.queryEmbeddingMs,
    queryRewriteMs: embeddingTimings.queryRewriteMs,
    cacheLookupMs: embeddingTimings.cacheLookupMs,
    embeddingCreateMs: embeddingTimings.embeddingCreateMs,
    cachePersistMs: embeddingTimings.cachePersistMs,
    similaritySearchMs,
    rerankMs,
  };

  try {
    await persistSearchTimingAverages(row, timings);
  } catch {
    // Timing persistence is best-effort and should not block search results.
  }

  const dedupedMatches: RagSearchMatch[] = [];
  const seenSdsChunkKeys = new Set<string>();

  for (const match of filteredMatches) {
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
    productKey,
    sectionType,
    scope: requestedScope,
    minSimilarity,
    retrieval_strategy: (
      useHybrid && useReranker ? 'hybrid+reranked'
      : useHybrid             ? 'hybrid'
      : useReranker           ? 'vector+reranked'
      :                         'vector'
    ) as 'vector' | 'hybrid' | 'vector+reranked' | 'hybrid+reranked',
    embeddingSource: source,
    timings,
    matches: dedupedMatches,
  };
}

