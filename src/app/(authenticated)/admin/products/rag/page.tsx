import { connection } from 'next/server';

import type { RagSearchSettingsValues } from '~/components/admin/rag/RagSearchControls';
import { RagSearchControls } from '~/components/admin/rag/RagSearchControls';
import { RagSearchResultCard } from '~/components/admin/rag/RagSearchResultCard';
import { RagSearchTimingPanel } from '~/components/admin/RagSearchTimingPanel';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import type { RagIdLookupResult, RagIdLookupTarget } from '~/lib/rag/id-lookup';
import {
  lookupRagChunksById,
  ragIdLookupInputSchema,
} from '~/lib/rag/id-lookup';
import type { SearchScope } from '~/lib/rag/search';
import { searchProductChunks } from '~/lib/rag/search';
import { formatDurationMs } from '~/lib/utils/time';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const metadata = {
  title: 'RAG Search | Betco BEX',
  description: 'Semantic search across Betco RAG product and SDS content.',
};

const SEARCH_ROUTE = '/admin/products/rag';

type SearchPageProps = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

type PopularQueryRow = {
  query_string: string | null;
  query_count: number | null;
};

type PopularQueryClient = {
  schema: (schemaName: 'rag') => {
    from: (tableName: 'search_embedding') => {
      select: (columns: 'query_string, query_count') => {
        order: (
          column: 'query_count',
          options: { ascending: boolean },
        ) => {
          limit: (count: number) => Promise<{
            data: PopularQueryRow[] | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
};

function readSearchParam(value: string | string[] | undefined, fallback = '') {
  if (Array.isArray(value)) {
    return value[0] ?? fallback;
  }

  return value ?? fallback;
}

function formatEmbeddingSource(
  value:
    | 'exact-cache-hit'
    | 'rewritten-cache-hit'
    | 'approximate-query-hit'
    | 'approximate-rewritten-hit'
    | 'new-embedding',
) {
  if (value === 'exact-cache-hit') {
    return 'Exact cache hit';
  }

  if (value === 'rewritten-cache-hit') {
    return 'Rewritten cache hit';
  }

  if (value === 'approximate-query-hit') {
    return 'Approximate query match';
  }

  if (value === 'approximate-rewritten-hit') {
    return 'Approximate rewritten match';
  }

  return 'New embedding';
}

function buildProductLineDetailHref(
  productLineKey: string,
  options: {
    query: string;
    productLineKey: string;
    limit: number;
    minSimilarity: string;
    scope: SearchScope;
  },
) {
  const params = new URLSearchParams();

  if (options.query) {
    params.set('q', options.query);
  }

  if (options.productLineKey) {
    params.set('productLineKey', options.productLineKey);
  }

  if (options.limit > 0) {
    params.set('limit', String(options.limit));
  }

  if (options.minSimilarity) {
    params.set('minSimilarity', options.minSimilarity);
  }

  if (options.scope !== 'all') {
    params.set('scope', options.scope);
  }

  const queryString = params.toString();
  const detailPath = `${SEARCH_ROUTE}/${encodeURIComponent(productLineKey)}`;

  return queryString ? `${detailPath}?${queryString}` : detailPath;
}

/**
 * B0-621 — the drawer's Scope select only offers all/label/efficacy/sds (products and knowledge
 * are out of scope for this tool), but `products`/`knowledge` stay parseable here so existing
 * deep links keep working; `searchProductChunks` already accepts all six `SearchScope` values.
 */
function parseScope(value: string | string[] | undefined): SearchScope {
  const raw = readSearchParam(value).trim().toLowerCase();
  if (
    raw === 'products' ||
    raw === 'sds' ||
    raw === 'efficacy' ||
    raw === 'knowledge' ||
    raw === 'label'
  ) {
    return raw;
  }

  return 'all';
}

/**
 * Retrieval mode. Defaults to `hybrid` so short/alphanumeric tokens (SKUs, product codes like
 * "ph7q") are matched lexically via BM25 — pure vector search embeds such tokens to near-noise
 * and returns arbitrary neighbours. Explicit `retrieval=vector` opts back into vector-only.
 */
function parseUseHybrid(value: string | string[] | undefined): boolean {
  const raw = readSearchParam(value).trim().toLowerCase();
  return raw !== 'vector';
}

/**
 * B0-619 — a checkbox on a GET-submitted form omits its name entirely from the query string when
 * unchecked, so "absent" and "explicitly unchecked" are indistinguishable — which is exactly the
 * semantics wanted here: an unchecked box means "don't override", not "force off", so
 * `searchProductChunks` keeps inheriting its own default (ENABLE_RERANKER via the settings
 * service). Only a checked box produces an explicit `true`.
 */
function parseExplicitTrue(
  value: string | string[] | undefined,
): true | undefined {
  const raw = readSearchParam(value).trim().toLowerCase();
  return raw === 'true' || raw === 'on' ? true : undefined;
}

function parseSectionType(
  value: string | string[] | undefined,
): string | undefined {
  const raw = readSearchParam(value).trim();
  return raw ? raw : undefined;
}

/**
 * B0-1017 — strict GUID lookup mode. The drawer's switch is a form-participating checkbox, so an
 * absent param means "off" exactly like `parseExplicitTrue`; `on` covers a plain checkbox fallback.
 */
function parseMode(value: string | string[] | undefined): 'guid' | 'semantic' {
  const raw = readSearchParam(value).trim().toLowerCase();
  return raw === 'guid' || raw === 'true' || raw === 'on' ? 'guid' : 'semantic';
}

/** B0-1017 — which table the GUID in the search box addresses. Defaults to chunk ids. */
function parseGuidTarget(
  value: string | string[] | undefined,
): RagIdLookupTarget {
  return readSearchParam(value).trim().toLowerCase() === 'document'
    ? 'document'
    : 'chunk';
}

/** GHS section types recognized by the corpus chunker (see `~/lib/rag/section-type-inference.ts`). */
const SECTION_TYPE_OPTIONS = [
  'organism_contact_time',
  'virucidal_activity',
  'fungistatic',
  'bactericidal_efficacy',
  'first_aid',
  'hazard',
  'handling_storage',
  'regulatory',
  'exposure_ppe',
  'physical_properties',
  'composition',
  'stability',
  'spill_response',
  'disposal',
  'transport',
  'fire_fighting',
  'toxicology',
  'ecological',
];

async function loadPopularQueries() {
  const supabase =
    getSupabaseServiceRoleClient() as unknown as PopularQueryClient;
  const { data, error } = await supabase
    .schema('rag')
    .from('search_embedding')
    .select('query_string, query_count')
    .order('query_count', { ascending: false })
    .limit(100);

  if (error) {
    return [];
  }

  const deduped = new Set<string>();

  return ((data ?? []) as PopularQueryRow[])
    .map((row) => ({
      query: row.query_string?.trim() || '',
      queryCount: row.query_count ?? 0,
    }))
    .filter((row) => {
      if (!row.query) {
        return false;
      }

      const key = row.query.toLowerCase();
      if (deduped.has(key)) {
        return false;
      }

      deduped.add(key);
      return true;
    });
}

function parseMinSimilarity(value: string | string[] | undefined) {
  const raw = readSearchParam(value).trim();

  if (!raw) {
    return null;
  }

  const parsed = Number.parseFloat(raw);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed > 1 ? Math.min(parsed / 100, 1) : Math.min(parsed, 1);
}

export default async function RagSearchPage({ searchParams }: SearchPageProps) {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_TOOLS,
    'GET /admin/products/rag',
  );

  await connection();

  const resolvedSearchParams = await searchParams;
  const query = readSearchParam(resolvedSearchParams.q);
  const productLineKey = readSearchParam(resolvedSearchParams.productLineKey);
  const scope = parseScope(resolvedSearchParams.scope);
  const useHybrid = parseUseHybrid(resolvedSearchParams.retrieval);
  const useReranker = parseExplicitTrue(resolvedSearchParams.useReranker);
  const useMultiIntent = parseExplicitTrue(resolvedSearchParams.useMultiIntent);
  const sectionType = parseSectionType(resolvedSearchParams.sectionType);
  const mode = parseMode(resolvedSearchParams.mode);
  const guidTarget = parseGuidTarget(resolvedSearchParams.guidTarget);
  const rawMinSimilarity = readSearchParam(resolvedSearchParams.minSimilarity);
  const minSimilarity = parseMinSimilarity(resolvedSearchParams.minSimilarity);
  // B0-619 — presence-only check (never the key itself) so the panel can tell "reranker toggled
  // off" apart from "reranker requested but unprovisioned, silently falling back".
  const cohereConfigured = Boolean(process.env.COHERE_API_KEY);
  const popularQueries = await loadPopularQueries();
  let similaritySummary = '';
  const requestedLimit = Number.parseInt(
    readSearchParam(resolvedSearchParams.limit, '8'),
    10,
  );
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 20)
      : 8;

  let error: string | null = null;
  let result: Awaited<ReturnType<typeof searchProductChunks>> | null = null;
  let lookup: RagIdLookupResult | null = null;
  let guidPrompt = false;

  // B0-1017 — GUID mode short-circuits retrieval entirely: the search box is read as a record id,
  // with no embedding, no filters and no semantic search.
  if (mode === 'guid') {
    const candidate = query.trim();

    if (!candidate) {
      guidPrompt = true;
    } else {
      const parsedLookup = ragIdLookupInputSchema.safeParse({
        id: candidate,
        target: guidTarget,
      });

      if (!parsedLookup.success) {
        error = `"${candidate}" is not a valid GUID.`;
      } else {
        try {
          lookup = await lookupRagChunksById(parsedLookup.data);
        } catch (lookupError) {
          error =
            lookupError instanceof Error
              ? lookupError.message
              : 'Unable to look up that record id.';
        }
      }
    }
  } else if (query.trim()) {
    try {
      result = await searchProductChunks({
        query,
        limit,
        productLineKey: productLineKey || undefined,
        scope,
        useHybrid,
        useReranker,
        useMultiIntent,
        sectionType,
        minSimilarity: minSimilarity ?? undefined,
      });

      if (result.matches.length > 0) {
        const sims = result.matches
          .map((m) => m.similarity)
          .sort((a, b) => a - b);
        similaritySummary = `${(sims[sims.length - 1]! * 100).toFixed(1)}% – ${(sims[0]! * 100).toFixed(1)}%`;
      }
    } catch (searchError) {
      error =
        searchError instanceof Error
          ? searchError.message
          : 'Unable to run similarity search.';
    }
  }

  const initialSettings: RagSearchSettingsValues = {
    scope,
    retrieval: useHybrid ? 'hybrid' : 'vector',
    limit: String(limit),
    minSimilarity: rawMinSimilarity,
    sectionType: sectionType ?? '',
    productLineKey,
    useReranker: useReranker === true,
    useMultiIntent: useMultiIntent === true,
    mode,
    guidTarget,
  };

  return (
    <div className="flex flex-1 bg-muted/30">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-[2rem] border border-border/60 bg-background p-8 shadow-sm">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
              RAG Similarity Search
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-foreground">
              Search the RAG product line corpus semantically
            </h1>
          </div>

          <div className="mt-8">
            <RagSearchControls
              formAction={SEARCH_ROUTE}
              initialSettings={initialSettings}
              popularQueries={popularQueries}
              query={query}
              resultCount={result ? result.matches.length : null}
              sectionTypeOptions={SECTION_TYPE_OPTIONS}
            />
          </div>
        </section>

        {error ? (
          <section className="rounded-2xl border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive">
            {error}
          </section>
        ) : null}

        {guidPrompt ? (
          <section className="rounded-[2rem] border border-dashed border-border/60 bg-background p-8 text-sm leading-7 text-muted-foreground">
            Strict GUID lookup is on. Paste a rag.document_chunk.id or
            rag.document.id into the search box to pull that exact record up, or
            switch the mode off to run a semantic search.
          </section>
        ) : lookup ? (
          <>
            <section className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                Direct ID lookup of{' '}
                <code className="rounded bg-muted px-1">
                  {lookup.target === 'document'
                    ? 'rag.document'
                    : 'rag.document_chunk'}
                </code>{' '}
                <code className="rounded bg-muted px-1">{lookup.id}</code>.{' '}
                {lookup.found
                  ? lookup.totalChunkCount > lookup.matches.length
                    ? `Showing ${lookup.matches.length} of ${lookup.totalChunkCount} chunks.`
                    : `Showing ${lookup.matches.length} ${
                        lookup.matches.length === 1 ? 'chunk' : 'chunks'
                      }.`
                  : 'No matching record.'}
              </div>
            </section>

            <section className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
              {!lookup.found ? (
                <div className="rounded-2xl border border-dashed border-border/60 bg-background p-8 text-sm text-muted-foreground lg:col-span-2">
                  No rag.document_chunk / rag.document row exists with that id.
                </div>
              ) : null}

              {lookup.found && lookup.matches.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/60 bg-background p-8 text-sm text-muted-foreground lg:col-span-2">
                  That document exists but has no chunks.
                </div>
              ) : null}

              {lookup.matches.map((match, index) => (
                <RagSearchResultCard
                  key={match.chunk_id}
                  match={match}
                  productLineHref={
                    match.document_kind === 'product_line_profile'
                      ? buildProductLineDetailHref(
                          match.product_line_key || match.source_pk,
                          {
                            query: '',
                            productLineKey: '',
                            limit,
                            minSimilarity: '',
                            scope: 'all',
                          },
                        )
                      : null
                  }
                  rank={index + 1}
                  resultCount={lookup.matches.length}
                  showSimilarity={false}
                />
              ))}
            </section>
          </>
        ) : result ? (
          <>
            <section className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                Showing {result.matches.length} line-level matches using{' '}
                <code className="rounded bg-muted px-1">{result.model}</code>.
              </div>
              <div className="text-sm text-muted-foreground">
                {result.scope === 'all'
                  ? 'Scope: all corpus docs (EN only).'
                  : result.scope === 'products'
                    ? 'Scope: products only (EN only).'
                    : result.scope === 'sds'
                      ? 'Scope: SDS only (EN only).'
                      : result.scope === 'efficacy'
                        ? 'Scope: efficacy documents only (EN only).'
                        : result.scope === 'knowledge'
                          ? 'Scope: knowledge/markdown only (EN only).'
                          : 'Scope: labels only (EN only).'}{' '}
                {result.productLineKey
                  ? `Filtered to product line ${result.productLineKey}.`
                  : 'No metadata filter applied.'}
                {result.minSimilarity !== null
                  ? ` Minimum similarity: ${(result.minSimilarity * 100).toFixed(1)}%.`
                  : ' No similarity floor applied.'}
              </div>
            </section>

            <RagSearchTimingPanel
              cohereConfigured={cohereConfigured}
              embeddingSourceLabel={formatEmbeddingSource(
                result.embeddingSource,
              )}
              retrievalStrategy={result.retrieval_strategy}
              totalMs={result.timings.totalMs}
              timings={[
                {
                  label: 'Total search',
                  value: formatDurationMs(result.timings.totalMs),
                  ms: result.timings.totalMs,
                },
                {
                  label: 'Query embedding total',
                  value: formatDurationMs(result.timings.queryEmbeddingMs),
                  ms: result.timings.queryEmbeddingMs,
                },
                {
                  label: 'Similarity search',
                  value: formatDurationMs(result.timings.similaritySearchMs),
                  ms: result.timings.similaritySearchMs,
                },
                {
                  label: 'Rerank',
                  value:
                    result.timings.rerankMs > 0
                      ? formatDurationMs(result.timings.rerankMs)
                      : 'Reranker off',
                  ms:
                    result.timings.rerankMs > 0
                      ? result.timings.rerankMs
                      : undefined,
                },
                {
                  label: 'Query rewrite',
                  value: formatDurationMs(result.timings.queryRewriteMs),
                  ms: result.timings.queryRewriteMs,
                },
                {
                  label: 'Cache lookup',
                  value: formatDurationMs(result.timings.cacheLookupMs),
                  ms: result.timings.cacheLookupMs,
                },
                {
                  label: 'Embedding creation',
                  value: formatDurationMs(result.timings.embeddingCreateMs),
                  ms: result.timings.embeddingCreateMs,
                },
                {
                  label: 'Cache persist/update',
                  value: formatDurationMs(result.timings.cachePersistMs),
                  ms: result.timings.cachePersistMs,
                },
                { label: 'Similarity range', value: similaritySummary },
              ]}
            />

            <section className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
              {result.matches.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/60 bg-background p-8 text-sm text-muted-foreground lg:col-span-2">
                  No semantic matches were returned for that query. Try lowering
                  the minimum similarity if the query is too strict.
                </div>
              ) : null}

              {result.matches.map((match, index) => (
                <RagSearchResultCard
                  key={match.chunk_id}
                  match={match}
                  productLineHref={
                    match.document_kind === 'product_line_profile'
                      ? buildProductLineDetailHref(
                          match.product_line_key || match.source_pk,
                          {
                            query,
                            productLineKey,
                            limit,
                            minSimilarity: rawMinSimilarity,
                            scope,
                          },
                        )
                      : null
                  }
                  rank={index + 1}
                  resultCount={result.matches.length}
                />
              ))}
            </section>
          </>
        ) : mode === 'guid' ? null : (
          <section className="rounded-[2rem] border border-dashed border-border/60 bg-background p-8 text-sm leading-7 text-muted-foreground">
            Enter a natural-language query to test vector similarity against
            product line chunks. Optional filters: product line key and minimum
            similarity.
          </section>
        )}
      </main>
    </div>
  );
}
