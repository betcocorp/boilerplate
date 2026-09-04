import { CheckCircle2, CircleDashed } from 'lucide-react';
import Link from 'next/link';
import { connection } from 'next/server';

import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';

import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import { fetchIngestedProductLineCodes } from '~/lib/rag/corpus-ingestion';
import { getSupabaseServerClient } from '~/supabase/clients/server';
import type { Tables } from '~/types/supabase.legacy';

export const metadata = {
  title: 'Legacy Products | Betco BEX',
  description: 'Browse legacy product catalog records and metadata.',
};

type ProductRow = Tables<{ schema: 'legacy' }, 'products'>;
type ProductDescriptionRow = Tables<{ schema: 'legacy' }, 'products_descr'>;
type ProductListItem = Pick<
  ProductRow,
  | 'ProductsKey'
  | 'Title'
  | 'SLDescr'
  | 'SKU'
  | 'InvtID'
  | 'Status'
  | 'OnWeb'
  | 'MSRP'
  | 'YearsOfService'
  | 'DSLProdLn'
  | 'H1'
  | 'H2'
  | 'MetaDescription'
  | 'MetaKeyWords'
>;
type ProductDescriptionListItem = Pick<
  ProductDescriptionRow,
  'ProductsKey' | 'ShortDescr' | 'FullDescr' | 'LanguageCD'
>;

type ProductSearchResult = {
  product: ProductListItem;
  description: ProductDescriptionListItem | null;
};

const PRODUCTS_ROUTE = '/admin/products/legacy';
const RESULT_LIMIT = 24;
const PAGE_LINK_WINDOW = 5;

function normalizeSearchTerm(value: string) {
  return value
    .trim()
    .replaceAll(',', ' ')
    .replaceAll('%', '')
    .replaceAll('(', '')
    .replaceAll(')', '');
}

function summarizeProduct(
  product: ProductListItem,
  description: ProductDescriptionListItem | null,
) {
  return (
    description?.ShortDescr ||
    product.Title ||
    product.SLDescr ||
    product.H1 ||
    product.H2 ||
    product.SKU ||
    'Untitled product'
  );
}

function productCopy(
  product: ProductListItem,
  description: ProductDescriptionListItem | null,
) {
  return (
    description?.FullDescr ||
    product.MetaDescription ||
    product.H2 ||
    product.H1 ||
    product.MetaKeyWords ||
    'No additional product details available.'
  );
}

function readSearchParam(value: string | string[] | undefined, fallback = '') {
  if (Array.isArray(value)) {
    return value[0] ?? fallback;
  }

  return value ?? fallback;
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

function buildProductDetailHref(
  productKey: string,
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
  const detailPath = `${PRODUCTS_ROUTE}/${encodeURIComponent(productKey)}`;

  return queryString ? `${detailPath}?${queryString}` : detailPath;
}

function buildPagination(currentPage: number, totalPages: number) {
  const halfWindow = Math.floor(PAGE_LINK_WINDOW / 2);
  let start = Math.max(1, currentPage - halfWindow);
  const end = Math.min(totalPages, start + PAGE_LINK_WINDOW - 1);

  start = Math.max(1, end - PAGE_LINK_WINDOW + 1);

  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

type ProductsPageProps = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function ProductsPage({
  searchParams,
}: ProductsPageProps) {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_PRODUCTS,
    'GET /admin/products/legacy',
  );

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

  const supabase = getSupabaseServerClient();
  const legacy = supabase.schema('legacy');
  const productSelection =
    'ProductsKey, Title, SLDescr, SKU, InvtID, Status, OnWeb, MSRP, YearsOfService, DSLProdLn, H1, H2, MetaDescription, MetaKeyWords';

  let results: ProductSearchResult[] = [];
  let error: string | null = null;
  let totalCount = 0;

  try {
    const queryBuilder = legacy
      .from('products')
      .select(productSelection, { count: 'exact' })
      .range(rangeStart, rangeEnd);

    const productResponse = normalizedSearchValue
      ? await queryBuilder.or(
          [
            `Title.ilike.%${normalizedSearchValue}%`,
            `SLDescr.ilike.%${normalizedSearchValue}%`,
            `SKU.ilike.%${normalizedSearchValue}%`,
            `InvtID.ilike.%${normalizedSearchValue}%`,
            `H1.ilike.%${normalizedSearchValue}%`,
            `H2.ilike.%${normalizedSearchValue}%`,
            `MetaDescription.ilike.%${normalizedSearchValue}%`,
          ].join(','),
        )
      : await queryBuilder.order('Title', { ascending: true });

    if (productResponse.error) {
      throw productResponse.error;
    }

    totalCount = productResponse.count ?? 0;

    const productRows = productResponse.data ?? [];
    const productKeys = productRows
      .map((product) => product.ProductsKey)
      .filter((productKey): productKey is string => Boolean(productKey));

    const descriptionMap = new Map<string, ProductDescriptionListItem>();

    if (productKeys.length > 0) {
      const { data: descriptions, error: descriptionsError } = await legacy
        .from('products_descr')
        .select('ProductsKey, ShortDescr, FullDescr, LanguageCD')
        .in('ProductsKey', productKeys)
        .eq('LanguageCD', 'EN');

      if (descriptionsError) {
        throw descriptionsError;
      }

      for (const description of descriptions ?? []) {
        if (
          description.ProductsKey &&
          !descriptionMap.has(description.ProductsKey)
        ) {
          descriptionMap.set(description.ProductsKey, description);
        }
      }
    }

    results = productRows.map((product) => ({
      product,
      description: product.ProductsKey
        ? (descriptionMap.get(product.ProductsKey) ?? null)
        : null,
    }));
  } catch (loadError) {
    error =
      loadError instanceof Error
        ? loadError.message
        : 'Unable to load products.';
  }

  // B0-100: mark which products are ingested into the retrieval corpus (product-line grain).
  let ingestedProductLines = new Set<string>();
  if (!error && results.length > 0) {
    try {
      ingestedProductLines = await fetchIngestedProductLineCodes(
        results.map(({ product }) => product.DSLProdLn ?? '').filter(Boolean),
      );
    } catch {
      // Non-fatal: fall back to showing "unknown" (no badge) rather than breaking the list.
      ingestedProductLines = new Set<string>();
    }
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
              Supabase Product Search
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-slate-950">
              Search products from your generated schema
            </h1>
            <p className="max-w-3xl text-base leading-7 text-slate-600">
              This view is typed from `src/types/supabase.legacy.ts` and
              searches the `legacy.products` table, then enriches results with
              matching `legacy.products_descr` records.
            </p>
          </div>

          <form
            className="mt-8 flex flex-col gap-3 sm:flex-row"
            action={PRODUCTS_ROUTE}
            method="get"
          >
            <Input
              className="h-12 flex-1 rounded-2xl px-4"
              type="search"
              name="q"
              defaultValue={searchValue}
              placeholder="Search by title, SKU, product ID, or description"
            />
            <Button
              className="h-12 shrink-0 rounded-2xl px-6 font-semibold"
              type="submit"
            >
              Search products
            </Button>
          </form>
        </section>

        <section className="flex items-center justify-between">
          <div className="text-sm text-slate-600">
            {normalizedSearchValue
              ? `Showing ${results.length} of ${totalCount} matches for "${searchValue}".`
              : `Showing ${results.length} of ${totalCount} products.`}
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
              No products matched that search.
            </div>
          ) : null}

          {results.map(({ product, description }) => {
            const title = summarizeProduct(product, description);
            const body = productCopy(product, description);
            const isIngested = product.DSLProdLn
              ? ingestedProductLines.has(product.DSLProdLn)
              : false;
            const syncBadge = isIngested ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700"
                title="This product's line has been ingested into the document corpus"
              >
                <CheckCircle2 className="size-3.5" aria-hidden />
                In corpus
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500"
                title="This product's line has not been ingested into the document corpus"
              >
                <CircleDashed className="size-3.5" aria-hidden />
                Not ingested
              </span>
            );
            const detailHref = product.ProductsKey
              ? buildProductDetailHref(
                  product.ProductsKey,
                  searchValue,
                  safeCurrentPage,
                )
              : null;

            return (
              <article
                key={product.ProductsKey ?? `${product.InvtID}-${product.SKU}`}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-sky-300 hover:shadow-md"
              >
                {detailHref ? (
                  <Link
                    className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
                    href={detailHref}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {syncBadge}
                      {product.Status ? (
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                          Status: {product.Status}
                        </span>
                      ) : null}
                      {product.OnWeb ? (
                        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                          OnWeb: {product.OnWeb}
                        </span>
                      ) : null}
                    </div>

                    <h2 className="mt-4 text-xl font-semibold leading-8 text-slate-950">
                      {title}
                    </h2>

                    <dl className="mt-4 grid grid-cols-2 gap-3 text-sm text-slate-600">
                      <div>
                        <dt className="font-medium text-slate-500">SKU</dt>
                        <dd>{product.SKU ?? 'N/A'}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-slate-500">
                          Inventory ID
                        </dt>
                        <dd>{product.InvtID ?? 'N/A'}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-slate-500">
                          Years of service
                        </dt>
                        <dd>{product.YearsOfService ?? 'N/A'}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-slate-500">MSRP</dt>
                        <dd>
                          {product.MSRP != null
                            ? `$${product.MSRP.toFixed(2)}`
                            : 'N/A'}
                        </dd>
                      </div>
                    </dl>

                    <p className="mt-4 text-sm leading-6 text-slate-700">
                      {body}
                    </p>

                    <div className="mt-4 text-sm font-medium text-sky-700">
                      View full details
                    </div>
                  </Link>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      {syncBadge}
                      {product.Status ? (
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                          Status: {product.Status}
                        </span>
                      ) : null}
                      {product.OnWeb ? (
                        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                          OnWeb: {product.OnWeb}
                        </span>
                      ) : null}
                    </div>

                    <h2 className="mt-4 text-xl font-semibold leading-8 text-slate-950">
                      {title}
                    </h2>

                    <dl className="mt-4 grid grid-cols-2 gap-3 text-sm text-slate-600">
                      <div>
                        <dt className="font-medium text-slate-500">SKU</dt>
                        <dd>{product.SKU ?? 'N/A'}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-slate-500">
                          Inventory ID
                        </dt>
                        <dd>{product.InvtID ?? 'N/A'}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-slate-500">
                          Years of service
                        </dt>
                        <dd>{product.YearsOfService ?? 'N/A'}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-slate-500">MSRP</dt>
                        <dd>
                          {product.MSRP != null
                            ? `$${product.MSRP.toFixed(2)}`
                            : 'N/A'}
                        </dd>
                      </div>
                    </dl>

                    <p className="mt-4 text-sm leading-6 text-slate-700">
                      {body}
                    </p>
                  </>
                )}
              </article>
            );
          })}
        </section>

        {!error && totalPages > 1 ? (
          <nav
            className="flex flex-wrap items-center justify-center gap-2"
            aria-label="Products pagination"
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
                key={pageNumber}
                className={`rounded-xl px-4 py-2 text-sm font-medium ${
                  pageNumber === safeCurrentPage
                    ? 'bg-slate-950 text-white'
                    : 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'
                }`}
                href={buildProductsHref(searchValue, pageNumber)}
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
