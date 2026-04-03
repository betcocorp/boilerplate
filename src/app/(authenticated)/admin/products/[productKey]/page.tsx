import Link from 'next/link';
import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import { getSupabaseServerClient } from '~/lib/supabase/server';
import type { Tables } from '~/types/supabase.legacy';

type ProductRow = Tables<{ schema: 'legacy' }, 'products'>;
type ProductDescriptionRow = Tables<{ schema: 'legacy' }, 'products_descr'>;
type ProductImageRow = Tables<{ schema: 'legacy' }, 'prod_images'>;

const PRODUCTS_ROUTE = '/admin/products';

type ProductDetailsPageProps = {
  params: Promise<{ productKey: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

function readSearchParam(
  value: string | string[] | undefined,
  fallback = '',
) {
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

function humanizeFieldName(fieldName: string) {
  return fieldName
    .replaceAll('_', ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatFieldValue(value: ProductRow[keyof ProductRow]) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value.toString() : value.toFixed(2);
  }

  return String(value);
}

function getProductFacts(product: ProductRow) {
  return Object.entries(product)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => ({
      key,
      label: humanizeFieldName(key),
      value: formatFieldValue(value as ProductRow[keyof ProductRow]),
    }));
}

function summarizeProduct(product: ProductRow, descriptions: ProductDescriptionRow[]) {
  const englishDescription = descriptions.find(
    (description) => description.LanguageCD === 'EN',
  );

  return (
    englishDescription?.ShortDescr ||
    product.Title ||
    product.SLDescr ||
    product.H1 ||
    product.H2 ||
    product.SKU ||
    'Untitled product'
  );
}

export default async function ProductDetailsPage({
  params,
  searchParams,
}: ProductDetailsPageProps) {
  await connection();

  const [{ productKey }, resolvedSearchParams] = await Promise.all([
    params,
    searchParams,
  ]);
  const searchValue = readSearchParam(resolvedSearchParams.q);
  const requestedPage = Number.parseInt(
    readSearchParam(resolvedSearchParams.page, '1'),
    10,
  );
  const currentPage =
    Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const supabase = getSupabaseServerClient();
  const legacy = supabase.schema('legacy');

  const [
    productResponse,
    descriptionsResponse,
    imagesResponse,
  ] = await Promise.all([
    legacy.from('products').select('*').eq('ProductsKey', productKey).maybeSingle(),
    legacy
      .from('products_descr')
      .select('*')
      .eq('ProductsKey', productKey)
      .order('LanguageCD', { ascending: true }),
    legacy
      .from('prod_images')
      .select('*')
      .eq('ProductsKey', productKey)
      .order('Sequence', { ascending: true }),
  ]);

  if (productResponse.error) {
    throw new Error(productResponse.error.message);
  }

  if (!productResponse.data) {
    notFound();
  }

  if (descriptionsResponse.error) {
    throw new Error(descriptionsResponse.error.message);
  }

  if (imagesResponse.error) {
    throw new Error(imagesResponse.error.message);
  }

  const product = productResponse.data;
  const descriptions = descriptionsResponse.data ?? [];
  const images = imagesResponse.data ?? [];
  const title = summarizeProduct(product, descriptions);
  const productFacts = getProductFacts(product);
  const backHref = buildProductsHref(searchValue, currentPage);

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <div className="flex items-center">
          <Link
            className="inline-flex items-center rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50"
            href={backHref}
          >
            Back to products
          </Link>
        </div>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
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
              {product.SKU ? (
                <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">
                  SKU: {product.SKU}
                </span>
              ) : null}
            </div>

            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                Product details
              </p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                {title}
              </h1>
              <p className="mt-3 max-w-3xl text-base leading-7 text-slate-600">
                {product.MetaDescription ||
                  product.H2 ||
                  product.H1 ||
                  product.SLDescr ||
                  'This page is rendered on the server and shows the full typed product record.'}
              </p>
            </div>

            <dl className="grid gap-4 pt-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl bg-slate-50 p-4">
                <dt className="text-sm font-medium text-slate-500">Inventory ID</dt>
                <dd className="mt-1 text-sm text-slate-900">
                  {product.InvtID ?? 'N/A'}
                </dd>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <dt className="text-sm font-medium text-slate-500">MSRP</dt>
                <dd className="mt-1 text-sm text-slate-900">
                  {product.MSRP != null ? `$${product.MSRP.toFixed(2)}` : 'N/A'}
                </dd>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <dt className="text-sm font-medium text-slate-500">Years of service</dt>
                <dd className="mt-1 text-sm text-slate-900">
                  {product.YearsOfService ?? 'N/A'}
                </dd>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <dt className="text-sm font-medium text-slate-500">Product key</dt>
                <dd className="mt-1 break-all text-sm text-slate-900">
                  {product.ProductsKey ?? 'N/A'}
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  Product record
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Every non-empty field from the `products` row is listed here so
                  the detail page reflects the full typed record.
                </p>
              </div>
              <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                {productFacts.length} fields
              </div>
            </div>

            <dl className="mt-6 grid gap-x-6 gap-y-5 sm:grid-cols-2">
              {productFacts.map((field) => (
                <div
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  key={field.key}
                >
                  <dt className="text-sm font-medium text-slate-500">
                    {field.label}
                  </dt>
                  <dd className="mt-1 wrap-break-word whitespace-pre-wrap text-sm text-slate-900">
                    {field.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="flex flex-col gap-6">
            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Descriptions
              </h2>
              {descriptions.length === 0 ? (
                <p className="mt-4 text-sm text-slate-600">
                  No language-specific descriptions were found for this product.
                </p>
              ) : (
                <div className="mt-6 flex flex-col gap-4">
                  {descriptions.map((description) => (
                    <article
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                      key={
                        description.ProductsDescrKey ??
                        `${description.LanguageCD}-${description.ProductsKey}`
                      }
                    >
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-base font-semibold text-slate-900">
                          {description.ShortDescr || 'Untitled description'}
                        </h3>
                        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                          {description.LanguageCD || 'Unknown language'}
                        </span>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                        {description.FullDescr || 'No full description available.'}
                      </p>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Images
              </h2>
              {images.length === 0 ? (
                <p className="mt-4 text-sm text-slate-600">
                  No related product images were found.
                </p>
              ) : (
                <div className="mt-6 flex flex-col gap-4">
                  {images.map((image: ProductImageRow) => (
                    <article
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                      key={image.ProdImagesKey ?? `${image.Filename}-${image.Sequence}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-base font-semibold text-slate-900">
                          {image.ImageName || image.Filename || 'Product image'}
                        </h3>
                        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                          Sequence {image.Sequence ?? 'N/A'}
                        </span>
                      </div>
                      {image.ImageDescr ? (
                        <p className="mt-3 text-sm leading-6 text-slate-700">
                          {image.ImageDescr}
                        </p>
                      ) : null}
                      <dl className="mt-4 grid gap-3 text-sm text-slate-600">
                        <div>
                          <dt className="font-medium text-slate-500">Image type</dt>
                          <dd>{image.ImageType ?? 'N/A'}</dd>
                        </div>
                        <div>
                          <dt className="font-medium text-slate-500">Image size</dt>
                          <dd>{image.ImageSize ?? 'N/A'}</dd>
                        </div>
                        <div>
                          <dt className="font-medium text-slate-500">Filename</dt>
                          <dd className="break-all">{image.Filename ?? 'N/A'}</dd>
                        </div>
                        <div>
                          <dt className="font-medium text-slate-500">Image link</dt>
                          <dd className="break-all">
                            {image.ImageLink ? (
                              <a
                                className="text-sky-700 underline underline-offset-4"
                                href={image.ImageLink}
                                rel="noreferrer"
                                target="_blank"
                              >
                                {image.ImageLink}
                              </a>
                            ) : (
                              'N/A'
                            )}
                          </dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>
        </section>
      </main>
    </div>
  );
}
