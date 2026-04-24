import { Search } from 'lucide-react';
import Link from 'next/link';
import { connection } from 'next/server';

import { RagQueryAutocomplete } from '~/components/admin/RagQueryAutocomplete';
import { RagSearchTimingPanel } from '~/components/admin/RagSearchTimingPanel';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/native-select';
import { searchProductChunks } from '~/lib/rag/search';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const metadata = {
  title: 'RAG Search | Betco BEX',
  description: 'Semantic search across Betco RAG product and SDS content.',
};

const SEARCH_ROUTE = '/admin/products/rag';
type SearchScope = 'all' | 'products' | 'sds';

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

function truncateText(value: string, maxLength = 320) {
  const trimmed = value.trim();

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 3)}...`;
}

function formatDurationMs(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)}s`;
  }

  return `${Math.round(value)}ms`;
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

function parseScope(value: string | string[] | undefined): SearchScope {
  const raw = readSearchParam(value).trim().toLowerCase();
  if (raw === 'products' || raw === 'sds') {
    return raw;
  }

  return 'all';
}

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
  await connection();

  const resolvedSearchParams = await searchParams;
  const query = readSearchParam(resolvedSearchParams.q);
  const productLineKey = readSearchParam(resolvedSearchParams.productLineKey);
  const scope = parseScope(resolvedSearchParams.scope);
  const rawMinSimilarity = readSearchParam(resolvedSearchParams.minSimilarity);
  const minSimilarity = parseMinSimilarity(resolvedSearchParams.minSimilarity);
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

  if (query.trim()) {
    try {
      result = await searchProductChunks({
        query,
        limit,
        productLineKey: productLineKey || undefined,
        scope,
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

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
              RAG Similarity Search
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-slate-950">
              Search the RAG product line corpus semantically
            </h1>
            <p className="max-w-3xl text-base leading-7 text-slate-600">
              Retrieval is one document per legacy product line. Semantic search
              is constrained to English (`EN`) documents only. Chunks include
              rolled-up size variants; filters only target product line keys.
            </p>
          </div>

          <form action={SEARCH_ROUTE} className="mt-8 flex gap-2" method="get">
            <div className="flex flex-col gap-4 flex-1">
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-medium text-slate-700">
                    Query
                  </Label>
                  <RagQueryAutocomplete
                    defaultValue={query}
                    options={popularQueries}
                    name="q"
                    placeholder="Ask something like: peroxide bathroom disinfectant"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-medium text-slate-700">
                    Product line key
                  </Label>
                  <Input
                    className="h-12 rounded-2xl px-4"
                    defaultValue={productLineKey}
                    name="productLineKey"
                    placeholder="Optional product line key"
                    type="text"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-medium text-slate-700">
                    Scope
                  </Label>
                  <NativeSelect
                    className="h-12 rounded-2xl px-4"
                    defaultValue={scope}
                    name="scope"
                  >
                    <option value="all">All</option>
                    <option value="products">Products</option>
                    <option value="sds">SDS</option>
                  </NativeSelect>
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-medium text-slate-700">
                    Limit
                  </Label>
                  <Input
                    className="h-12 rounded-2xl px-4"
                    defaultValue={String(limit)}
                    max={20}
                    min={1}
                    name="limit"
                    type="number"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-medium text-slate-700">
                    Similarity threshold
                  </Label>
                  <Input
                    className="h-12 rounded-2xl px-4"
                    defaultValue={rawMinSimilarity}
                    name="minSimilarity"
                    placeholder="0.65 or 65"
                    type="text"
                  />
                </div>
              </div>
            </div>
            <Button
              className="mt-auto h-12 rounded-2xl px-6 font-semibold"
              type="submit"
            >
              <Search className="size-4" />
            </Button>
          </form>
          <p className="mt-3 text-sm text-slate-500">
            Minimum similarity is optional. Enter a decimal like `0.65` or a
            whole percent like `65`.
          </p>
        </section>

        {error ? (
          <section className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
            {error}
          </section>
        ) : null}

        {result ? (
          <>
            <section className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-slate-600">
                Showing {result.matches.length} line-level matches using{' '}
                <code className="rounded bg-slate-100 px-1">
                  {result.model}
                </code>
                .
              </div>
              <div className="text-sm text-slate-600">
                {result.scope === 'all'
                  ? 'Scope: all corpus docs (EN only).'
                  : result.scope === 'products'
                    ? 'Scope: products only (EN only).'
                    : 'Scope: SDS only (EN only).'}{' '}
                {result.productLineKey
                  ? `Filtered to product line ${result.productLineKey}.`
                  : 'No metadata filter applied.'}
                {result.minSimilarity !== null
                  ? ` Minimum similarity: ${(result.minSimilarity * 100).toFixed(1)}%.`
                  : ' No similarity floor applied.'}
              </div>
            </section>

            <RagSearchTimingPanel
              embeddingSourceLabel={formatEmbeddingSource(
                result.embeddingSource,
              )}
              timings={[
                ['Total search', formatDurationMs(result.timings.totalMs)],
                [
                  'Query embedding total',
                  formatDurationMs(result.timings.queryEmbeddingMs),
                ],
                [
                  'Similarity search',
                  formatDurationMs(result.timings.similaritySearchMs),
                ],
                [
                  'Query rewrite',
                  formatDurationMs(result.timings.queryRewriteMs),
                ],
                [
                  'Cache lookup',
                  formatDurationMs(result.timings.cacheLookupMs),
                ],
                [
                  'Embedding creation',
                  formatDurationMs(result.timings.embeddingCreateMs),
                ],
                [
                  'Cache persist/update',
                  formatDurationMs(result.timings.cachePersistMs),
                ],
                ['Similarity range', similaritySummary],
              ].map(([label, value]) => ({
                label,
                value,
              }))}
            />

            <section className="grid gap-4 lg:grid-cols-2">
              {result.matches.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 lg:col-span-2">
                  No semantic matches were returned for that query. Try lowering
                  the minimum similarity if the query is too strict.
                </div>
              ) : null}

              {result.matches.map((match) => (
                <article
                  className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
                  key={match.chunk_id}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                      Similarity: {(match.similarity * 100).toFixed(1)}%
                    </span>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                      Chunk {match.chunk_index}
                    </span>
                    <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700">
                      {match.document_kind}
                    </span>
                    {match.heading ? (
                      <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">
                        {match.heading}
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-4 flex flex-col gap-2">
                    <h2 className="text-xl font-semibold text-slate-950">
                      {match.document_title}
                    </h2>
                    <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">
                      <span>
                        Product line:{' '}
                        {match.product_line_key || match.source_pk || 'N/A'}
                      </span>
                      <span>Representative SKU: {match.sku || 'N/A'}</span>
                      <span>
                        Section path: {match.section_path?.join(' / ') || 'N/A'}
                      </span>
                    </div>
                  </div>

                  <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                    {truncateText(match.chunk_text)}
                  </p>

                  <div className="mt-4 flex flex-wrap gap-3">
                    {match.document_kind === 'product_line_profile' ? (
                      <Link
                        className="inline-flex rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
                        href={buildProductLineDetailHref(
                          match.product_line_key || match.source_pk,
                          {
                            query,
                            productLineKey,
                            limit,
                            minSimilarity: rawMinSimilarity,
                            scope,
                          },
                        )}
                      >
                        View RAG product line
                      </Link>
                    ) : null}
                  </div>
                </article>
              ))}
            </section>
          </>
        ) : (
          <section className="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-sm leading-7 text-slate-600">
            Enter a natural-language query to test vector similarity against
            product line chunks. Optional filters: product line key and minimum
            similarity.
          </section>
        )}
      </main>
    </div>
  );
}
