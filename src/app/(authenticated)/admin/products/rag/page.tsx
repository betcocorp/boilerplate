import Link from 'next/link';
import { connection } from 'next/server';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

type JsonObject = Record<string, unknown>;

type RagDocument = {
  id: string;
  document_key: string;
  source_record_id: string;
  entity_id: string | null;
  document_kind: string;
  title: string;
  language_code: string;
  body_text: string;
  summary: string | null;
  token_count: number | null;
  metadata: JsonObject | null;
  updated_at: string;
};

type RagEntity = {
  id: string;
  entity_type: string;
  canonical_key: string;
  title: string | null;
  sku: string | null;
  product_key: string | null;
  product_line_key: string | null;
  metadata: JsonObject | null;
};

type RagSourceRecord = {
  id: string;
  source_pk: string;
  source_type: string;
  source_locale: string;
  is_active: boolean;
};

type RagSearchResult = {
  document: RagDocument;
  entity: RagEntity | null;
  sourceRecord: RagSourceRecord | null;
};

const PRODUCTS_ROUTE = '/admin/products/rag';
const RESULT_LIMIT = 24;
const PAGE_LINK_WINDOW = 5;

function readSearchParam(value: string | string[] | undefined, fallback = '') {
  if (Array.isArray(value)) {
    return value[0] ?? fallback;
  }

  return value ?? fallback;
}

function normalizeSearchTerm(value: string) {
  return value
    .trim()
    .replaceAll(',', ' ')
    .replaceAll('%', '')
    .replaceAll('(', '')
    .replaceAll(')', '');
}

function buildProductsHref(query: string, page: number) {
  const params = new URLSearchParams();

  if (query) {
    params.set('q', query);
  }

  if (page > 1) {
    params.set('page', String(page));
  }

  const queryString = params.toString();

  return queryString ? `${PRODUCTS_ROUTE}?${queryString}` : PRODUCTS_ROUTE;
}

function buildProductLineDetailHref(
  productLineKey: string,
  query: string,
  page: number,
) {
  const params = new URLSearchParams();

  if (query) {
    params.set('q', query);
  }

  if (page > 1) {
    params.set('page', String(page));
  }

  const queryString = params.toString();
  const detailPath = `${PRODUCTS_ROUTE}/${encodeURIComponent(productLineKey)}`;

  return queryString ? `${detailPath}?${queryString}` : detailPath;
}

function buildPagination(currentPage: number, totalPages: number) {
  const halfWindow = Math.floor(PAGE_LINK_WINDOW / 2);
  let start = Math.max(1, currentPage - halfWindow);
  const end = Math.min(totalPages, start + PAGE_LINK_WINDOW - 1);

  start = Math.max(1, end - PAGE_LINK_WINDOW + 1);

  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMetadataValue(metadata: JsonObject | null | undefined, key: string) {
  if (!metadata || !(key in metadata)) {
    return null;
  }

  const value = metadata[key];

  return typeof value === 'string' && value.trim() ? value : null;
}

function getProductLineKey(result: RagSearchResult) {
  return (
    result.entity?.product_line_key ||
    getMetadataValue(result.document.metadata, 'product_line_key') ||
    result.sourceRecord?.source_pk ||
    null
  );
}

function getSummary(result: RagSearchResult) {
  const summary =
    result.document.summary?.trim() ||
    getMetadataValue(result.document.metadata, 'title') ||
    result.document.body_text.trim();

  return summary.length > 220 ? `${summary.slice(0, 217)}...` : summary;
}

type ProductsPageProps = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function RagProductsPage({
  searchParams,
}: ProductsPageProps) {
  await connection();

  const resolvedSearchParams = await searchParams;
  const searchValue = readSearchParam(resolvedSearchParams.q);
  const normalizedSearchValue = normalizeSearchTerm(searchValue);
  const requestedPage = Number.parseInt(
    readSearchParam(resolvedSearchParams.page, '1'),
    10,
  );
  const currentPage =
    Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const rangeStart = (currentPage - 1) * RESULT_LIMIT;
  const rangeEnd = rangeStart + RESULT_LIMIT - 1;

  const supabase = getSupabaseServiceRoleClient();
  const rag = supabase.schema('rag');
  const documentSelection =
    'id, document_key, source_record_id, entity_id, document_kind, title, language_code, body_text, summary, token_count, metadata, updated_at';

  let results: RagSearchResult[] = [];
  let error: string | null = null;
  let totalCount = 0;

  try {
    let matchingEntityIds: string[] = [];

    if (normalizedSearchValue) {
      const entitySearchResponse = await rag
        .from('entity')
        .select('id')
        .eq('entity_type', 'product_line')
        .or(
          [
            `title.ilike.%${normalizedSearchValue}%`,
            `sku.ilike.%${normalizedSearchValue}%`,
            `canonical_key.ilike.%${normalizedSearchValue}%`,
            `product_line_key.ilike.%${normalizedSearchValue}%`,
          ].join(','),
        )
        .limit(250);

      if (entitySearchResponse.error) {
        throw entitySearchResponse.error;
      }

      matchingEntityIds = (entitySearchResponse.data ?? [])
        .map((row) => row.id)
        .filter((value): value is string => Boolean(value));
    }

    const documentQuery = rag
      .from('document')
      .select(documentSelection, { count: 'exact' })
      .eq('document_kind', 'product_line_profile')
      .eq('language_code', 'EN')
      .order('updated_at', { ascending: false })
      .range(rangeStart, rangeEnd);

    const documentResponse = normalizedSearchValue
      ? await documentQuery.or(
          [
            `title.ilike.%${normalizedSearchValue}%`,
            `body_text.ilike.%${normalizedSearchValue}%`,
            `document_key.ilike.%${normalizedSearchValue}%`,
            ...(matchingEntityIds.length > 0
              ? [`entity_id.in.(${matchingEntityIds.join(',')})`]
              : []),
          ].join(','),
        )
      : await documentQuery;

    if (documentResponse.error) {
      throw documentResponse.error;
    }

    const documents = ((documentResponse.data ?? []) as unknown[]).filter(
      isJsonObject,
    ) as unknown as RagDocument[];
    totalCount = documentResponse.count ?? 0;

    const entityIds = Array.from(
      new Set(
        documents
          .map((document) => document.entity_id)
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const sourceRecordIds = Array.from(
      new Set(
        documents
          .map((document) => document.source_record_id)
          .filter((value): value is string => Boolean(value)),
      ),
    );

    const [entitiesResponse, sourceRecordsResponse] = await Promise.all([
      entityIds.length > 0
        ? rag
            .from('entity')
            .select(
              'id, entity_type, canonical_key, title, sku, product_key, product_line_key, metadata',
            )
            .in('id', entityIds)
        : Promise.resolve({ data: [], error: null }),
      sourceRecordIds.length > 0
        ? rag
            .from('source_record')
            .select('id, source_pk, source_type, source_locale, is_active')
            .in('id', sourceRecordIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (entitiesResponse.error) {
      throw entitiesResponse.error;
    }

    if (sourceRecordsResponse.error) {
      throw sourceRecordsResponse.error;
    }

    const entityMap = new Map<string, RagEntity>();
    const sourceRecordMap = new Map<string, RagSourceRecord>();

    for (const entity of (entitiesResponse.data ?? []) as unknown[]) {
      if (isJsonObject(entity) && typeof entity.id === 'string') {
        entityMap.set(entity.id, entity as unknown as RagEntity);
      }
    }

    for (const sourceRecord of (sourceRecordsResponse.data ?? []) as unknown[]) {
      if (isJsonObject(sourceRecord) && typeof sourceRecord.id === 'string') {
        sourceRecordMap.set(
          sourceRecord.id,
          sourceRecord as unknown as RagSourceRecord,
        );
      }
    }

    results = documents.map((document) => ({
      document,
      entity: document.entity_id ? (entityMap.get(document.entity_id) ?? null) : null,
      sourceRecord:
        sourceRecordMap.get(document.source_record_id) ?? null,
    }));
  } catch (loadError) {
    error =
      loadError instanceof Error
        ? loadError.message
        : 'Unable to load RAG product documents.';
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / RESULT_LIMIT));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const paginationPages = buildPagination(safeCurrentPage, totalPages);

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
              RAG product line search
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-slate-950">
              Browse product lines in your RAG schema
            </h1>
            <p className="max-w-3xl text-base leading-7 text-slate-600">
              Each document is one legacy product line (`product_line_profile`),
              with size variants embedded in the body and `variant_product_keys` in
              metadata.
            </p>
          </div>

          <form
            action={PRODUCTS_ROUTE}
            className="mt-8 flex flex-col gap-3 sm:flex-row"
            method="get"
          >
            <input
              className="h-12 flex-1 rounded-2xl border border-slate-300 bg-white px-4 text-sm text-slate-950 outline-none ring-0 transition focus:border-sky-500"
              defaultValue={searchValue}
              name="q"
              placeholder="Search by title, line key, document key, or body text"
              type="search"
            />
            <button
              className="inline-flex h-12 items-center justify-center rounded-2xl bg-slate-950 px-6 text-sm font-semibold text-white transition hover:bg-slate-800"
              type="submit"
            >
              Search RAG lines
            </button>
            <Link
              className="inline-flex h-12 items-center justify-center rounded-2xl bg-white px-6 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-50"
              href="/admin/products/rag/search"
            >
              Semantic search
            </Link>
            <Link
              className="inline-flex h-12 items-center justify-center rounded-2xl bg-white px-6 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-50"
              href="/admin/products/rag/generate"
            >
              Generate
            </Link>
          </form>
        </section>

        <section className="flex items-center justify-between">
          <div className="text-sm text-slate-600">
            {normalizedSearchValue
              ? `Showing ${results.length} of ${totalCount} matches for "${searchValue}".`
              : `Showing ${results.length} of ${totalCount} RAG product line documents.`}
          </div>
          <div className="text-sm text-slate-600">
            Page {safeCurrentPage} of {totalPages}
          </div>
        </section>

        {error ? (
          <section className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
            {error}
          </section>
        ) : null}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {!error && results.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600">
              No RAG product line documents matched that search.
            </div>
          ) : null}

          {results.map((result) => {
            const productLineKey = getProductLineKey(result);
            const detailHref = productLineKey
              ? buildProductLineDetailHref(
                  productLineKey,
                  searchValue,
                  safeCurrentPage,
                )
              : null;

            return (
              <article
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-sky-300 hover:shadow-md"
                key={result.document.id}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                    {result.document.language_code}
                  </span>
                  <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">
                    {result.document.document_kind}
                  </span>
                  {result.entity?.sku ? (
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                      SKU: {result.entity.sku}
                    </span>
                  ) : null}
                </div>

                <h2 className="mt-4 text-xl font-semibold leading-8 text-slate-950">
                  {result.document.title || 'Untitled product line'}
                </h2>

                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm text-slate-600">
                  <div>
                    <dt className="font-medium text-slate-500">Product line key</dt>
                    <dd className="break-all">{productLineKey ?? 'N/A'}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-slate-500">Variants</dt>
                    <dd>
                      {typeof result.document.metadata?.variant_count === 'number'
                        ? String(result.document.metadata.variant_count)
                        : 'N/A'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-slate-500">Source type</dt>
                    <dd>{result.sourceRecord?.source_type ?? 'N/A'}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-slate-500">Active</dt>
                    <dd>{result.sourceRecord?.is_active ? 'Yes' : 'No'}</dd>
                  </div>
                </dl>

                <p className="mt-4 text-sm leading-6 text-slate-700">
                  {getSummary(result)}
                </p>

                {detailHref ? (
                  <Link
                    className="mt-4 inline-flex text-sm font-medium text-sky-700"
                    href={detailHref}
                  >
                    View product line details
                  </Link>
                ) : (
                  <div className="mt-4 text-sm text-slate-500">
                    Missing product line key for detail link.
                  </div>
                )}
              </article>
            );
          })}
        </section>

        {!error && totalPages > 1 ? (
          <nav
            aria-label="RAG product pagination"
            className="flex flex-wrap items-center justify-center gap-2"
          >
            <Link
              className={`rounded-xl px-4 py-2 text-sm font-medium ${
                safeCurrentPage === 1
                  ? 'pointer-events-none bg-slate-100 text-slate-400'
                  : 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'
              }`}
              href={buildProductsHref(
                searchValue,
                Math.max(1, safeCurrentPage - 1),
              )}
            >
              Previous
            </Link>

            {paginationPages.map((pageNumber) => (
              <Link
                className={`rounded-xl px-4 py-2 text-sm font-medium ${
                  pageNumber === safeCurrentPage
                    ? 'bg-slate-950 text-white'
                    : 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'
                }`}
                href={buildProductsHref(searchValue, pageNumber)}
                key={pageNumber}
              >
                {pageNumber}
              </Link>
            ))}

            <Link
              className={`rounded-xl px-4 py-2 text-sm font-medium ${
                safeCurrentPage === totalPages
                  ? 'pointer-events-none bg-slate-100 text-slate-400'
                  : 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'
              }`}
              href={buildProductsHref(
                searchValue,
                Math.min(totalPages, safeCurrentPage + 1),
              )}
            >
              Next
            </Link>
          </nav>
        ) : null}
      </main>
    </div>
  );
}
