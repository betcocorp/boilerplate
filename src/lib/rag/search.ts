import { createEmbedding, EMBEDDING_MODEL } from '~/lib/rag/embeddings';
import { isRerankerConfigured, rerankChunks } from '~/lib/rag/rerank';
import { getOpenAIClient } from '~/lib/openai/client';
import { getBooleanSetting } from '~/lib/settings/settings-service';
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
  /**
   * B0-686 — exact-match surface type for the metadata boost (`filter_surface_type`). Nothing
   * infers one from a user query yet, so this is `null` in practice; the RPC only reorders on it
   * and never changes the returned `similarity`.
   */
  surfaceType?: string;
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
  surfaceType: string | null;
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

/**
 * B0-440: single resolved rerank decision, shared by the three things that used to disagree —
 * the candidate over-fetch, whether the rerank phase runs, and the reported
 * `retrieval_strategy`.
 *
 * A caller can *request* reranking (`useReranker`), but the request only takes effect when
 * Cohere is provisioned. `rerankChunks` returns null immediately when `COHERE_API_KEY` is
 * absent, so a requested-but-unprovisioned reranker used to buy a 5x over-fetch (50 full
 * chunk rows instead of 20, each carrying `chunk_text`) and a `hybrid+reranked` label for
 * work that never happened. When the reranker is inactive this path now behaves exactly as
 * if `useReranker: false` had been passed.
 *
 * The `documentKindFilter` over-fetch is unrelated to reranking — it exists so enough rows of
 * the requested app-layer `document_kind` (knowledge/label) survive the post-RPC filter — so
 * it takes precedence regardless of the rerank decision.
 */
export function resolveRerankPlan(input: {
  requestedReranker: boolean;
  limit: number;
  documentKindFilter: string | null;
}): { rerankerActive: boolean; rpcLimit: number } {
  const rerankerActive = input.requestedReranker && isRerankerConfigured();
  const rpcLimit = input.documentKindFilter
    ? Math.min(Math.max(input.limit * 10, 100), 200)
    : rerankerActive
      ? Math.min(input.limit * 5, 50)
      : input.limit;

  return { rerankerActive, rpcLimit };
}

/**
 * B0-16 — region/language suffixes Betco's SDS corpus appends to an otherwise identical product
 * code. The S3 corpus stores the US, Canadian, French and Spanish sheets for one product as
 * separate files (`092.pdf`, `092_CAN.pdf`, `092CAN.pdf`, `092_FR.pdf`), which ingest as separate
 * `rag.document` rows with separate titles, so a single glass-cleaner question returns the same
 * product three times.
 *
 * Longest-first so `CANADA` is stripped before `CAN` and `USA` before `US`.
 */
const SDS_REGION_SUFFIXES = [
  'CANADA',
  'CAN',
  'USA',
  'US',
  'FR',
  'SP',
  'ES',
  'EN',
  'MX',
] as const;

/**
 * B0-16 — reduces an SDS document title to the product code shared by its regional siblings.
 *
 * Only two transforms are applied, both deliberately narrow:
 *  1. drop a trailing re-upload marker (`092 (2)` -> `092`), which the S3 loader adds when the
 *     same sheet exists in more than one folder;
 *  2. strip at most ONE trailing region/language suffix, and only when what remains still ends in
 *     a digit.
 *
 * The "still ends in a digit" guard is what stops the strip from eating real product codes:
 * `0925` keeps its `5` (there is no suffix to strip and it is never confused with `092`), and a
 * concentrate/RTU sibling such as `192 DIL` keeps `DIL` because `DIL` is not a region suffix.
 * Verified against the live corpus: 0 of the 286 `rag.entity` rows that carry SDS documents hold
 * more than one distinct product code once these suffixes are stripped, so the strip cannot merge
 * two genuinely different products in the corpus as it stands.
 */
export function normalizeSdsTitleToProductCode(title: string): string {
  const collapsed = title.trim().replace(/\s+/g, ' ').toUpperCase();
  const withoutReuploadMarker = collapsed.replace(/\s*\(\d+\)$/, '').trim();

  for (const suffix of SDS_REGION_SUFFIXES) {
    const match = withoutReuploadMarker.match(
      new RegExp(`^(.*\\d)[\\s_-]*${suffix}$`),
    );

    if (match) {
      return match[1].trim();
    }
  }

  return withoutReuploadMarker;
}

/**
 * B0-16 — the identity two SDS rows must share to count as the same product.
 *
 * The RPCs already return the real product identity: `match_corpus_chunks*` left-joins
 * `rag.entity` on `rag.document.entity_id` and projects `entity_id`, `product_key`, `sku` and
 * `product_line_key`. `product_line_key` is the stable legacy business key, so it is preferred;
 * `product_key` and `entity_id` are fallbacks for the product-tier entity rows.
 *
 * The title-derived product code is carried alongside the identity rather than instead of it,
 * for two reasons. 1,110 of the 3,159 SDS documents in the corpus have no `entity_id` at all, so
 * an identity-only key would silently stop deduplicating for a third of the corpus. And an
 * identity-only key would over-collapse: `rag.entity` is at product_line grain here
 * (`product_key` is null on these rows), so two different SKUs in one product line — a
 * concentrate and its RTU, for example — would otherwise share a key and one would disappear.
 */
export function sdsProductDedupeKey(
  match: Pick<
    RagSearchMatch,
    'document_title' | 'entity_id' | 'product_key' | 'product_line_key'
  >,
): string {
  const identity = match.product_line_key || match.product_key || match.entity_id || '';
  return `${identity}|${normalizeSdsTitleToProductCode(match.document_title)}`;
}

/**
 * B0-16 — collapses regional SDS siblings down to one row per product, keeping the highest
 * `similarity` in each group at that group's best rank position.
 *
 * Scoped to `document_kind === 'sds'` on purpose. A US and a Canadian SDS are the same GHS
 * hazard content for the same formulation, so showing both is pure noise. Labels and efficacy
 * documents are NOT collapsed: a US label and a Canadian label carry different regulatory
 * identifiers (EPA registration number vs DIN), so hiding one would suppress regulated data the
 * user needs to see. Revisit only with a per-kind rule, never by widening this one.
 *
 * Similarity values are never recomputed or mutated — a surviving row is returned exactly as the
 * RPC produced it. Only which rows survive, and which member of a group represents it, changes.
 */
export function dedupeSdsMatchesByProduct(matches: RagSearchMatch[]): RagSearchMatch[] {
  const deduped: RagSearchMatch[] = [];
  const positionByKey = new Map<string, number>();

  for (const match of matches) {
    if (match.document_kind !== 'sds') {
      deduped.push(match);
      continue;
    }

    const key = sdsProductDedupeKey(match);
    const existingPosition = positionByKey.get(key);

    if (existingPosition === undefined) {
      positionByKey.set(key, deduped.length);
      deduped.push(match);
      continue;
    }

    // Same product: keep the highest-similarity sheet, but hold the group's original (best) rank
    // position so deduplication never demotes the product in the result order.
    if (match.similarity > deduped[existingPosition].similarity) {
      deduped[existingPosition] = match;
    }
  }

  return deduped;
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
  surfaceType: string | null;
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
        filter_product_key?: string;
        filter_surface_type?: string;
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
            filter_surface_type: opts.surfaceType || null,
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
            filter_surface_type: opts.surfaceType || null,
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
            filter_product_key: opts.productKey || undefined,
            // Corpus branch has a single overload each, so an omitted key falls through to the
            // SQL default — matching how the other filters are sent here.
            filter_surface_type: opts.surfaceType || undefined,
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
  const surfaceType = options.surfaceType?.trim() || null;
  const {
    requested: requestedScope,
    rpcScope: scope,
    documentKindFilter,
  } = resolveSearchScope(options.scope);
  const minSimilarity = normalizeMinSimilarity(options.minSimilarity);
  const useHybrid = options.useHybrid ?? false;
  const useReranker = options.useReranker ?? (await getBooleanSetting('ENABLE_RERANKER', false));
  const useMultiIntent = options.useMultiIntent ?? false;
  // Fetch extra candidates when reranking so the reranker has a larger pool to
  // reorder before we slice down to the requested limit. When an app-layer document_kind
  // filter is active (knowledge/label), over-fetch so enough matching-kind rows survive.
  // `rerankerActive` (not the requested `useReranker`) gates the over-fetch, the rerank
  // phase, and the strategy label — see resolveRerankPlan (B0-440).
  const { rerankerActive, rpcLimit } = resolveRerankPlan({
    requestedReranker: useReranker,
    limit,
    documentKindFilter,
  });

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
    surfaceType,
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

  // Rerank phase — reorders the candidate pool by cross-encoder relevance.
  // Falls back to cosine order if the API is unavailable.
  //
  // B0-16: this phase no longer slices to `limit`. It used to, which put the trim *before* the
  // SDS dedupe at the end of this function, so every duplicate the dedupe removed shrank the
  // result set below `limit` instead of being backfilled from the candidate pool. The single
  // trim to `limit` now happens after dedupe, which is the only place it can preserve the
  // caller's limit semantics.
  let rerankMs = 0;
  let rankedMatches = kindFilteredMatches;

  if (rerankerActive && kindFilteredMatches.length > 0) {
    const rerankStartedAt = nowMs();
    const reranked = await rerankChunks(query, kindFilteredMatches).catch(() => null);
    rerankMs = elapsedMs(rerankStartedAt);

    if (reranked && reranked.length > 0) {
      const scoreMap = new Map(reranked.map((r) => [r.chunk_id, r.relevance_score]));
      rankedMatches = [...kindFilteredMatches].sort(
        (a, b) => (scoreMap.get(b.chunk_id) ?? 0) - (scoreMap.get(a.chunk_id) ?? 0),
      );
    }
  }

  const filteredMatches = rankedMatches.filter(
    (match) => minSimilarity === null || match.similarity >= minSimilarity,
  );

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

  // B0-16: dedupe on product identity, then take the requested count. The previous key was
  // built from (title, chunk_index, first 280 chars of chunk_text), which could only catch
  // byte-identical sheets — the US and Canadian SDS bodies genuinely differ (supplier address
  // block, "Hazard identification" vs "Hazards identification"), so `092`, `092 CAN` and
  // `092CAN` all survived it as three separate "sources" for one product.
  const dedupedMatches = dedupeSdsMatchesByProduct(filteredMatches).slice(0, limit);

  return {
    query,
    model,
    limit,
    productLineKey,
    productKey,
    sectionType,
    surfaceType,
    scope: requestedScope,
    minSimilarity,
    // B0-440: reports what actually ran. Reranking that was requested but not provisioned
    // is no longer labelled `+reranked` in the observability data.
    retrieval_strategy: (
      useHybrid && rerankerActive ? 'hybrid+reranked'
      : useHybrid                 ? 'hybrid'
      : rerankerActive            ? 'vector+reranked'
      :                             'vector'
    ) as 'vector' | 'hybrid' | 'vector+reranked' | 'hybrid+reranked',
    embeddingSource: source,
    timings,
    matches: dedupedMatches,
  };
}

