import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { getSupabaseServerClient } from '~/supabase/clients/server';
import type { Tables } from '~/types/supabase.legacy';

export const metadata = {
  title: 'Legacy Product Details | Betco BEX',
  description: 'Detailed legacy product record including metadata and related assets.',
};

type ProductRow = Tables<{ schema: 'legacy' }, 'products'>;
type ProductAttrRow = Tables<{ schema: 'legacy' }, 'products_attr'>;
type ProductDescriptionRow = Tables<{ schema: 'legacy' }, 'products_descr'>;
type ProductImageRow = Tables<{ schema: 'legacy' }, 'prod_images'>;
type DocumentRow = Tables<{ schema: 'legacy' }, 'documents'>;
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
  | 'H1'
  | 'H2'
  | 'MetaDescription'
  | 'MetaKeyWords'
>;
type TechSpecDefinitionRow = Tables<{ schema: 'legacy' }, 'tech_spec_def'>;

const PRODUCTS_ROUTE = '/admin/products/legacy';

type ProductDetailsPageProps = {
  params: Promise<{ productKey: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

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

function normalizeAttrTable(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? '';
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return Boolean(value?.trim());
}

function getUniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter(isNonEmptyString)));
}

function getAttrKeys(
  attrs: Array<Pick<ProductAttrRow, 'AttrKey' | 'AttrTable'>>,
  tableName: string,
) {
  return getUniqueStrings(
    attrs
      .filter((attr) => normalizeAttrTable(attr.AttrTable) === tableName)
      .map((attr) => attr.AttrKey),
  );
}

function joinTextParts(parts: Array<string | null | undefined>) {
  return parts
    .filter(isNonEmptyString)
    .join(' ')
    .replace(/\s+,/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildDocumentHref(document: DocumentRow) {
  if (!document.FileName) {
    return null;
  }

  const location = document.Location?.replace(/^\/+|\/+$/g, '') ?? '';
  const fileName = document.FileName.replace(/^\/+/, '');

  return `https://www.betco.com/${location ? `${location}/` : ''}${fileName}`;
}

function buildImageHref(image: ProductImageRow) {
  const fileName = image.Filename?.replace(/^\/+/, '') ?? '';
  const imageLink = image.ImageLink?.trim() ?? '';

  if (!imageLink && !fileName) {
    return null;
  }

  if (imageLink.startsWith('http://') || imageLink.startsWith('https://')) {
    return fileName
      ? `${imageLink.replace(/\/+$/, '')}/${fileName}`
      : imageLink;
  }

  const normalizedBase = imageLink.replace(/^\/+|\/+$/g, '');

  return `https://www.betco.com/${normalizedBase}${fileName ? `/${fileName}` : ''}`;
}

function dedupeByKey<T>(items: T[], getKey: (item: T) => string) {
  const seen = new Set<string>();

  return items.filter((item) => {
    const key = getKey(item);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
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

function summarizeProduct(
  product: ProductRow,
  descriptions: ProductDescriptionRow[],
) {
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

function summarizeProductListItem(
  product: ProductListItem,
  description: ProductDescriptionRow | null,
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
    directImagesResponse,
    productAttrsResponse,
  ] = await Promise.all([
    legacy
      .from('products')
      .select('*')
      .eq('ProductsKey', productKey)
      .maybeSingle(),
    legacy
      .from('products_descr')
      .select('*')
      .eq('ProductsKey', productKey)
      .order('LanguageCD', { ascending: true }),
    legacy
      .from('prod_images')
      .select('*')
      .eq('ProductsKey', productKey)
      .order('Sequence', { ascending: true, nullsFirst: false }),
    legacy
      .from('products_attr')
      .select('AttrKey, AttrTable')
      .eq('ProductsKey', productKey),
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

  if (directImagesResponse.error) {
    throw new Error(directImagesResponse.error.message);
  }

  if (productAttrsResponse.error) {
    throw new Error(productAttrsResponse.error.message);
  }

  const product = productResponse.data;
  const descriptions = descriptionsResponse.data ?? [];
  const productAttrs = productAttrsResponse.data ?? [];
  const productLineKeys = getAttrKeys(productAttrs, 'prodline');
  const productClassKeys = getAttrKeys(productAttrs, 'prodclass');
  const sizeCodeKeys = getAttrKeys(productAttrs, 'sizecode');
  const productImageGroupKeys = getAttrKeys(productAttrs, 'prodimages');

  const [
    productLineResponse,
    productLineDescriptionsResponse,
    productLineAttrsResponse,
    productClassesResponse,
    sizeCodesResponse,
    sizeCodeDescriptionsResponse,
  ] = await Promise.all([
    productLineKeys.length > 0
      ? legacy
          .from('prod_line')
          .select('*')
          .in('ProdLineKey', productLineKeys)
          .order('ProdLineID', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    productLineKeys.length > 0
      ? legacy
          .from('prod_line_descr')
          .select('*')
          .in('ProdLineKey', productLineKeys)
          .eq('LanguageCD', 'EN')
      : Promise.resolve({ data: [], error: null }),
    productLineKeys.length > 0
      ? legacy
          .from('prod_line_attr')
          .select('AttrKey, AttrTable, ProdLineKey')
          .in('ProdLineKey', productLineKeys)
      : Promise.resolve({ data: [], error: null }),
    productClassKeys.length > 0
      ? legacy
          .from('prod_class')
          .select('*')
          .in('ProdClassKey', productClassKeys)
      : Promise.resolve({ data: [], error: null }),
    sizeCodeKeys.length > 0
      ? legacy.from('size_code').select('*').in('SizeCodeKey', sizeCodeKeys)
      : Promise.resolve({ data: [], error: null }),
    sizeCodeKeys.length > 0
      ? legacy
          .from('size_code_descr')
          .select('*')
          .in('SizeCodeKey', sizeCodeKeys)
          .eq('LanguageCD', 'EN')
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (productLineResponse.error) {
    throw new Error(productLineResponse.error.message);
  }

  if (productLineDescriptionsResponse.error) {
    throw new Error(productLineDescriptionsResponse.error.message);
  }

  if (productLineAttrsResponse.error) {
    throw new Error(productLineAttrsResponse.error.message);
  }

  if (productClassesResponse.error) {
    throw new Error(productClassesResponse.error.message);
  }

  if (sizeCodesResponse.error) {
    throw new Error(sizeCodesResponse.error.message);
  }

  if (sizeCodeDescriptionsResponse.error) {
    throw new Error(sizeCodeDescriptionsResponse.error.message);
  }

  const productLine = productLineResponse.data?.[0] ?? null;
  const productLineDescriptions = productLineDescriptionsResponse.data ?? [];
  const productLineDescription = productLineDescriptions[0] ?? null;
  const productLineAttrs = productLineAttrsResponse.data ?? [];
  const productClasses = productClassesResponse.data ?? [];
  const sizeCodes = sizeCodesResponse.data ?? [];
  const sizeCodeDescriptions = sizeCodeDescriptionsResponse.data ?? [];

  const featureKeys = getAttrKeys(productLineAttrs, 'featuresrch');
  const directionKeys = getAttrKeys(productLineAttrs, 'productdirectionofuse');
  const documentKeys = getAttrKeys(productLineAttrs, 'documents');
  const videoKeys = getAttrKeys(productLineAttrs, 'videos');
  const techSpecKeys = getAttrKeys(productLineAttrs, 'techspec');
  const lineImageGroupKeys = getAttrKeys(productLineAttrs, 'prodimages');
  const imageGroupKeys = getUniqueStrings([
    ...productImageGroupKeys,
    ...lineImageGroupKeys,
  ]);

  const [
    featuresResponse,
    directionsResponse,
    documentsResponse,
    videosResponse,
    techSpecsResponse,
    groupedImagesResponse,
    availableInLinksResponse,
  ] = await Promise.all([
    featureKeys.length > 0
      ? legacy
          .from('feature_srch')
          .select('*')
          .in('FeatureSrchKey', featureKeys)
          .order('SEQ', { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [], error: null }),
    directionKeys.length > 0
      ? legacy
          .from('product_direction_of_use')
          .select('*')
          .in('ProductDirectionOfUseKey', directionKeys)
          .order('Sequence', { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [], error: null }),
    documentKeys.length > 0
      ? legacy
          .from('documents')
          .select('*')
          .in('DocumentsKey', documentKeys)
          .order('Sequence', { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [], error: null }),
    videoKeys.length > 0
      ? legacy
          .from('videos')
          .select('*')
          .in('VideosKey', videoKeys)
          .order('SortOrder', { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [], error: null }),
    techSpecKeys.length > 0
      ? legacy
          .from('tech_spec')
          .select('*')
          .in('TechSpecKey', techSpecKeys)
          .order('SortOrder', { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [], error: null }),
    imageGroupKeys.length > 0
      ? legacy
          .from('prod_images')
          .select('*')
          .in('ProdImagesKey', imageGroupKeys)
          .order('Sequence', { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [], error: null }),
    productLineKeys.length > 0
      ? legacy
          .from('products_attr')
          .select('ProductsKey, AttrKey, AttrTable')
          .in('AttrKey', productLineKeys)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (featuresResponse.error) {
    throw new Error(featuresResponse.error.message);
  }

  if (directionsResponse.error) {
    throw new Error(directionsResponse.error.message);
  }

  if (documentsResponse.error) {
    throw new Error(documentsResponse.error.message);
  }

  if (videosResponse.error) {
    throw new Error(videosResponse.error.message);
  }

  if (techSpecsResponse.error) {
    throw new Error(techSpecsResponse.error.message);
  }

  if (groupedImagesResponse.error) {
    throw new Error(groupedImagesResponse.error.message);
  }

  if (availableInLinksResponse.error) {
    throw new Error(availableInLinksResponse.error.message);
  }

  const techSpecDefKeys = getUniqueStrings(
    (techSpecsResponse.data ?? []).map(
      (techSpec) =>
        (techSpec as { TechSpecDefKey?: string | null }).TechSpecDefKey,
    ),
  );
  const techSpecDefinitionsResponse =
    techSpecDefKeys.length > 0
      ? await legacy
          .from('tech_spec_def')
          .select('*')
          .in('TechSpecDefKey', techSpecDefKeys)
      : { data: [], error: null };

  if (techSpecDefinitionsResponse.error) {
    throw new Error(techSpecDefinitionsResponse.error.message);
  }

  const variantKeys = getUniqueStrings(
    (availableInLinksResponse.data ?? [])
      .filter((link) => normalizeAttrTable(link.AttrTable) === 'prodline')
      .map((link) => link.ProductsKey),
  ).filter((key) => key !== productKey);

  const [variantsResponse, variantDescriptionsResponse] = await Promise.all([
    variantKeys.length > 0
      ? legacy
          .from('products')
          .select(
            'ProductsKey, Title, SLDescr, SKU, InvtID, Status, OnWeb, MSRP, YearsOfService, H1, H2, MetaDescription, MetaKeyWords',
          )
          .in('ProductsKey', variantKeys)
          .order('Title', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    variantKeys.length > 0
      ? legacy
          .from('products_descr')
          .select('*')
          .in('ProductsKey', variantKeys)
          .eq('LanguageCD', 'EN')
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (variantsResponse.error) {
    throw new Error(variantsResponse.error.message);
  }

  if (variantDescriptionsResponse.error) {
    throw new Error(variantDescriptionsResponse.error.message);
  }

  const directImages = directImagesResponse.data ?? [];
  const groupedImages = groupedImagesResponse.data ?? [];
  const images = dedupeByKey(
    [...directImages, ...groupedImages],
    (image) =>
      image.ProdImagesKey ??
      image.Filename ??
      image.ImageLink ??
      `${image.ImageName}-${image.Sequence}`,
  );
  const features = featuresResponse.data ?? [];
  const directions = directionsResponse.data ?? [];
  const documents = documentsResponse.data ?? [];
  const videos = videosResponse.data ?? [];
  const techSpecs = techSpecsResponse.data ?? [];
  const techSpecDefinitions = techSpecDefinitionsResponse.data ?? [];
  const techSpecDefinitionMap = new Map<string, TechSpecDefinitionRow>();
  const sizeCode = sizeCodes[0] ?? null;
  const sizeCodeDescription = sizeCodeDescriptions[0] ?? null;
  const productClass = productClasses[0] ?? null;

  for (const techSpecDefinition of techSpecDefinitions) {
    if (techSpecDefinition.TechSpecDefKey) {
      techSpecDefinitionMap.set(
        techSpecDefinition.TechSpecDefKey,
        techSpecDefinition,
      );
    }
  }

  const variantDescriptionMap = new Map<string, ProductDescriptionRow>();

  for (const description of variantDescriptionsResponse.data ?? []) {
    if (
      description.ProductsKey &&
      !variantDescriptionMap.has(description.ProductsKey)
    ) {
      variantDescriptionMap.set(description.ProductsKey, description);
    }
  }

  const availableInVariants = (variantsResponse.data ?? [])
    .map((variant) => ({
      product: variant,
      description: variant.ProductsKey
        ? (variantDescriptionMap.get(variant.ProductsKey) ?? null)
        : null,
    }))
    .sort((left, right) =>
      summarizeProductListItem(left.product, left.description).localeCompare(
        summarizeProductListItem(right.product, right.description),
      ),
    );

  const title = summarizeProduct(product, descriptions);
  const productFacts = getProductFacts(product);
  const backHref = buildProductsHref(searchValue, currentPage);
  const primaryImage =
    images.find((image) =>
      (image.Filename ?? '').toLowerCase().includes('_main'),
    ) ??
    images.find((image) => image.Sequence === 1) ??
    images[0] ??
    null;
  const primaryImageHref = primaryImage ? buildImageHref(primaryImage) : null;
  const lineTitle =
    productLineDescription?.ShortDescr ||
    productLine?.Title ||
    productLine?.ProdLineDescr ||
    null;
  const primaryProdLineKey =
    productLine?.ProdLineKey ?? productLineKeys[0] ?? null;
  const heroCopy =
    product.MetaDescription ||
    product.H2 ||
    product.H1 ||
    descriptions.find((description) => description.LanguageCD === 'EN')
      ?.FullDescr ||
    productLineDescription?.FullDescr ||
    productLine?.MetaDescription ||
    product.SLDescr ||
    'This page is rendered on the server and aggregates product and product-line content from the legacy schema.';

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <div className="flex items-center">
          <Link
            className="inline-flex items-center rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50"
            href={backHref}
          >
            Back to products
          </Link>
        </div>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,420px)]">
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                {product.Status ? (
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                    Status: {product.Status}
                  </span>
                ) : null}
                {product.OnWeb === 1 ? (
                  <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                    On web
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
                  {heroCopy}
                </p>
              </div>

              <dl className="grid gap-4 pt-2 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-2xl bg-slate-50 p-4">
                  <dt className="text-sm font-medium text-slate-500">
                    Inventory ID
                  </dt>
                  <dd className="mt-1 text-sm text-slate-900">
                    {product.InvtID ?? 'N/A'}
                  </dd>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <dt className="text-sm font-medium text-slate-500">MSRP</dt>
                  <dd className="mt-1 text-sm text-slate-900">
                    {product.MSRP != null
                      ? `$${product.MSRP.toFixed(2)}`
                      : 'N/A'}
                  </dd>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <dt className="text-sm font-medium text-slate-500">
                    Years of service
                  </dt>
                  <dd className="mt-1 text-sm text-slate-900">
                    {product.YearsOfService ?? 'N/A'}
                  </dd>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <dt className="text-sm font-medium text-slate-500">
                    Product line
                  </dt>
                  <dd className="mt-1 break-all text-sm text-slate-900">
                    {primaryProdLineKey ? (
                      <Link
                        className="font-medium text-sky-700 underline underline-offset-4 hover:text-sky-900"
                        href={`${PRODUCTS_ROUTE}/line/${encodeURIComponent(primaryProdLineKey)}`}
                      >
                        {lineTitle ?? primaryProdLineKey}
                      </Link>
                    ) : (
                      (lineTitle ?? 'N/A')
                    )}
                  </dd>
                </div>
              </dl>

              {productClass || sizeCodeDescription ? (
                <div className="flex flex-wrap gap-3 pt-2">
                  {productClass?.DSLProdClassDescr ? (
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                      Class: {productClass.DSLProdClassDescr}
                    </span>
                  ) : null}
                  {sizeCodeDescription?.SizeDescr || sizeCode?.D2Code ? (
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                      Size: {sizeCodeDescription?.SizeDescr || sizeCode?.D2Code}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-3">
              <div className="overflow-hidden rounded-3xl border border-slate-200 bg-slate-50 shadow-sm">
                {primaryImageHref ? (
                  // Use a plain image tag here so the rendered asset URL matches the legacy site exactly.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    alt={
                      primaryImage?.ImageName || primaryImage?.Filename || title
                    }
                    className="aspect-square h-full w-full object-contain bg-white"
                    src={primaryImageHref}
                  />
                ) : (
                  <div className="flex aspect-square items-center justify-center text-sm text-slate-500">
                    No primary image available
                  </div>
                )}
              </div>
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
                <p className="font-medium text-slate-900">
                  Primary image comparison
                </p>
                <p className="mt-1">
                  This uses the first grouped image, preferring files marked
                  `_main`, so you can compare it against the legacy product
                  page.
                </p>
                {primaryImage?.Filename ? (
                  <p className="mt-2 break-all text-xs text-slate-500">
                    {primaryImage.Filename}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <div className="flex flex-col gap-6">
            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                    Product record
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Every non-empty field from the `products` row is listed here
                    so the detail page reflects the full typed record.
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
            </section>

            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Features
              </h2>
              {features.length === 0 ? (
                <p className="mt-4 text-sm text-slate-600">
                  No feature highlights were found for this product line.
                </p>
              ) : (
                <ul className="mt-6 space-y-3 text-sm leading-6 text-slate-700">
                  {features.map((feature) => (
                    <li
                      className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                      key={
                        feature.FeatureSrchKey ??
                        feature.FeatureMstrDescr ??
                        'feature'
                      }
                    >
                      {feature.FeatureMstrDescr || 'Untitled feature'}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Directions for use
              </h2>
              {directions.length === 0 ? (
                <p className="mt-4 text-sm text-slate-600">
                  No directions for use were found for this product line.
                </p>
              ) : (
                <div className="mt-6 flex flex-col gap-4">
                  {directions.map((direction) => (
                    <article
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                      key={
                        direction.ProductDirectionOfUseKey ??
                        `${direction.Sequence}-${direction.Directions}`
                      }
                    >
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-base font-semibold text-slate-900">
                          Step {direction.Sequence ?? 'N/A'}
                        </h3>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                        {direction.Directions || 'No instructions available.'}
                      </p>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Tech specs
              </h2>
              {techSpecs.length === 0 ? (
                <p className="mt-4 text-sm text-slate-600">
                  No technical specifications were found for this product line.
                </p>
              ) : (
                <dl className="mt-6 grid gap-4 sm:grid-cols-2">
                  {techSpecs.map((techSpec) => {
                    const techSpecDefinition = techSpec.TechSpecDefKey
                      ? (techSpecDefinitionMap.get(techSpec.TechSpecDefKey) ??
                        null)
                      : null;
                    const techSpecValue = joinTextParts([
                      techSpec.TechValue,
                      techSpec.User_Str_00,
                      techSpec.User_Str_01,
                    ]);

                    return (
                      <div
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                        key={
                          techSpec.TechSpecDefKey ??
                          techSpec.TechSpecKey ??
                          techSpecValue
                        }
                      >
                        <dt className="text-sm font-medium text-slate-500">
                          {techSpecDefinition?.TechSpecDef || 'Specification'}
                        </dt>
                        <dd className="mt-1 text-sm text-slate-900">
                          {techSpecValue || 'N/A'}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </section>

            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Available in
              </h2>
              {availableInVariants.length === 0 ? (
                <p className="mt-4 text-sm text-slate-600">
                  No sibling variants were found for this product line.
                </p>
              ) : (
                <div className="mt-6 grid gap-4 md:grid-cols-2">
                  {availableInVariants.map(
                    ({ product: variant, description }) => (
                      <Link
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-4 transition hover:border-sky-300 hover:bg-white"
                        href={buildProductDetailHref(
                          variant.ProductsKey ?? '',
                          searchValue,
                          currentPage,
                        )}
                        key={
                          variant.ProductsKey ?? variant.SKU ?? variant.Title
                        }
                      >
                        <p className="text-base font-semibold text-slate-900">
                          {summarizeProductListItem(variant, description)}
                        </p>
                        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm text-slate-600">
                          <div>
                            <dt className="font-medium text-slate-500">SKU</dt>
                            <dd>{variant.SKU ?? 'N/A'}</dd>
                          </div>
                          <div>
                            <dt className="font-medium text-slate-500">
                              Inventory ID
                            </dt>
                            <dd>{variant.InvtID ?? 'N/A'}</dd>
                          </div>
                        </dl>
                      </Link>
                    ),
                  )}
                </div>
              )}
            </section>
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
                        {description.FullDescr ||
                          'No full description available.'}
                      </p>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Resources
              </h2>
              {documents.length === 0 ? (
                <p className="mt-4 text-sm text-slate-600">
                  No resource documents were found for this product line.
                </p>
              ) : (
                <div className="mt-6 flex flex-col gap-4">
                  {documents.map((document) => {
                    const href = buildDocumentHref(document);
                    const resourceTitle =
                      document.DocDescr ||
                      document.LinkName ||
                      document.FileName ||
                      'Resource document';

                    return (
                      <article
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                        key={document.DocumentsKey ?? resourceTitle}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="text-base font-semibold text-slate-900">
                            {resourceTitle}
                          </h3>
                          <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                            {document.Sequence ?? 'N/A'}
                          </span>
                        </div>
                        {href ? (
                          <a
                            className="mt-3 inline-flex text-sm font-medium text-sky-700 underline underline-offset-4"
                            href={href}
                            rel="noreferrer"
                            target="_blank"
                          >
                            Open resource
                          </a>
                        ) : (
                          <p className="mt-3 text-sm text-slate-600">
                            No resource link available.
                          </p>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Videos
              </h2>
              {videos.length === 0 ? (
                <p className="mt-4 text-sm text-slate-600">
                  No videos were found for this product line.
                </p>
              ) : (
                <div className="mt-6 flex flex-col gap-4">
                  {videos.map((video) => (
                    <article
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                      key={video.VideosKey ?? video.VideoLoc ?? 'video'}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-base font-semibold text-slate-900">
                          {video.VideoDescr || 'Product video'}
                        </h3>
                        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                          Sort {video.SortOrder ?? 'N/A'}
                        </span>
                      </div>
                      {video.VideoLoc ? (
                        <a
                          className="mt-3 inline-flex text-sm font-medium text-sky-700 underline underline-offset-4"
                          href={video.VideoLoc}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open video
                        </a>
                      ) : (
                        <p className="mt-3 text-sm text-slate-600">
                          No video link available.
                        </p>
                      )}
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
                      key={
                        image.ProdImagesKey ??
                        `${image.Filename}-${image.Sequence}`
                      }
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
                          <dt className="font-medium text-slate-500">
                            Image type
                          </dt>
                          <dd>{image.ImageType ?? 'N/A'}</dd>
                        </div>
                        <div>
                          <dt className="font-medium text-slate-500">
                            Image size
                          </dt>
                          <dd>{image.ImageSize ?? 'N/A'}</dd>
                        </div>
                        <div>
                          <dt className="font-medium text-slate-500">
                            Filename
                          </dt>
                          <dd className="break-all">
                            {image.Filename ?? 'N/A'}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-medium text-slate-500">
                            Image link
                          </dt>
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
