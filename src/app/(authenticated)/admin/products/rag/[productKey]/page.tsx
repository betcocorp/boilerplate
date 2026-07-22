import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const metadata = {
  title: 'RAG Product Line Details | Betco BEX',
  description: 'Inspect RAG document, source, entity, and chunk records for a product line.',
};

type JsonObject = Record<string, unknown>;

type RagSourceRecord = {
  id: string;
  source_schema: string;
  source_table: string;
  source_pk: string;
  source_locale: string;
  source_type: string;
  checksum: string | null;
  is_active: boolean;
  last_seen_at: string;
  metadata: JsonObject | null;
  created_at: string;
  updated_at: string;
};

type RagDocument = {
  id: string;
  document_key: string;
  source_record_id: string;
  entity_id: string | null;
  document_kind: string;
  title: string;
  language_code: string;
  body_text: string;
  body_markdown: string | null;
  summary: string | null;
  token_count: number | null;
  metadata: JsonObject | null;
  created_at: string;
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
  created_at: string;
  updated_at: string;
};

type RagChunk = {
  id: string;
  chunk_key: string;
  chunk_index: number;
  section_path: string[] | null;
  heading: string | null;
  chunk_text: string;
  token_count: number | null;
  embedding_model_large: string | null;
  metadata: JsonObject | null;
  created_at: string;
  updated_at: string;
};

const PRODUCTS_ROUTE = '/admin/products/rag';

type ProductLineDetailsPageProps = {
  /** URL segment is the legacy product line key (`ProdLineKey`). */
  params: Promise<{ productKey: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

function readSearchParam(value: string | string[] | undefined, fallback = '') {
  if (Array.isArray(value)) {
    return value[0] ?? fallback;
  }

  return value ?? fallback;
}

function buildProductsHref(options: {
  query: string;
  productLineKey: string;
  limit: string;
  minSimilarity: string;
  page: number;
}) {
  const params = new URLSearchParams();

  if (options.query) {
    params.set('q', options.query);
  }

  if (options.productLineKey) {
    params.set('productLineKey', options.productLineKey);
  }

  if (options.limit) {
    params.set('limit', options.limit);
  }

  if (options.minSimilarity) {
    params.set('minSimilarity', options.minSimilarity);
  }

  if (options.page > 1) {
    params.set('page', String(options.page));
  }

  const queryString = params.toString();

  return queryString ? `${PRODUCTS_ROUTE}?${queryString}` : PRODUCTS_ROUTE;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMetadataString(metadata: JsonObject | null | undefined, key: string) {
  if (!metadata || !(key in metadata)) {
    return null;
  }

  const value = metadata[key];

  return typeof value === 'string' && value.trim() ? value : null;
}

function formatFieldLabel(fieldName: string) {
  return fieldName
    .replaceAll('_', ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatFieldValue(value: unknown) {
  if (value == null) {
    return 'N/A';
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  if (Array.isArray(value)) {
    return value.join(', ');
  }

  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }

  return String(value);
}

function getVisibleFields(record: Record<string, unknown>) {
  return Object.entries(record)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => ({
      key,
      label: formatFieldLabel(key),
      value: formatFieldValue(value),
    }));
}

function getHeroCopy(document: RagDocument, sourceRecord: RagSourceRecord) {
  return (
    document.summary?.trim() ||
    getMetadataString(document.metadata, 'title') ||
    getMetadataString(document.metadata, 'product_line_key') ||
    getMetadataString(sourceRecord.metadata, 'title') ||
    document.body_text.trim().slice(0, 320)
  );
}

function getVariantProductKeys(metadata: JsonObject): string[] {
  const raw = metadata.variant_product_keys;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter((item): item is string => typeof item === 'string');
}

export default async function RagProductLineDetailsPage({
  params,
  searchParams,
}: ProductLineDetailsPageProps) {
  await connection();

  const [{ productKey: productLineKeyParam }, resolvedSearchParams] =
    await Promise.all([params, searchParams]);
  const productLineKey = decodeURIComponent(productLineKeyParam);
  const searchValue = readSearchParam(resolvedSearchParams.q);
  const searchProductLineKey = readSearchParam(resolvedSearchParams.productLineKey);
  const limit = readSearchParam(resolvedSearchParams.limit);
  const minSimilarity = readSearchParam(resolvedSearchParams.minSimilarity);
  const requestedPage = Number.parseInt(
    readSearchParam(resolvedSearchParams.page, '1'),
    10,
  );
  const currentPage =
    Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const supabase = getSupabaseServiceRoleClient();
  const rag = supabase.schema('rag');

  const sourceRecordResponse = await rag
    .from('source_record')
    .select(
      'id, source_schema, source_table, source_pk, source_locale, source_type, checksum, is_active, last_seen_at, metadata, created_at, updated_at',
    )
    .eq('source_schema', 'legacy')
    .eq('source_table', 'prod_line')
    .eq('source_pk', productLineKey)
    .eq('source_locale', 'EN')
    .maybeSingle();

  if (sourceRecordResponse.error) {
    throw new Error(sourceRecordResponse.error.message);
  }

  if (!sourceRecordResponse.data) {
    notFound();
  }

  const sourceRecord = sourceRecordResponse.data as unknown as RagSourceRecord;

  const documentResponse = await rag
    .from('document')
    .select(
      'id, document_key, source_record_id, entity_id, document_kind, title, language_code, body_text, body_markdown, summary, token_count, metadata, created_at, updated_at',
    )
    .eq('source_record_id', sourceRecord.id)
    .eq('document_kind', 'product_line_profile')
    .eq('language_code', 'EN')
    .maybeSingle();

  if (documentResponse.error) {
    throw new Error(documentResponse.error.message);
  }

  if (!documentResponse.data) {
    notFound();
  }

  const document = documentResponse.data as unknown as RagDocument;

  const [entityResponse, chunksResponse] = await Promise.all([
    document.entity_id
      ? rag
          .from('entity')
          .select(
            'id, entity_type, canonical_key, title, sku, product_key, product_line_key, metadata, created_at, updated_at',
          )
          .eq('id', document.entity_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    rag
      .from('document_chunk')
      .select(
        'id, chunk_key, chunk_index, section_path, heading, chunk_text, token_count, embedding_model_large, metadata, created_at, updated_at',
      )
      .eq('document_id', document.id)
      .order('chunk_index', { ascending: true }),
  ]);

  if (entityResponse.error) {
    throw new Error(entityResponse.error.message);
  }

  if (chunksResponse.error) {
    throw new Error(chunksResponse.error.message);
  }

  const entity = entityResponse.data
    ? (entityResponse.data as unknown as RagEntity)
    : null;
  const chunks = (chunksResponse.data ?? []) as unknown as RagChunk[];

  const backHref = buildProductsHref({
    query: searchValue,
    productLineKey: searchProductLineKey,
    limit,
    minSimilarity,
    page: currentPage,
  });
  const heroCopy = getHeroCopy(document, sourceRecord);
  const documentFields = getVisibleFields(document as unknown as Record<string, unknown>);
  const sourceFields = getVisibleFields(
    sourceRecord as unknown as Record<string, unknown>,
  );
  const entityFields = entity
    ? getVisibleFields(entity as unknown as Record<string, unknown>)
    : [];
  const documentMetadata = isJsonObject(document.metadata) ? document.metadata : {};
  const sourceMetadata = isJsonObject(sourceRecord.metadata)
    ? sourceRecord.metadata
    : {};
  const documentMetadataFields = getVisibleFields(documentMetadata);
  const sourceMetadataFields = getVisibleFields(sourceMetadata);
  const variantProductKeys = getVariantProductKeys(documentMetadata);

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <div className="flex items-center">
          <Link
            className="inline-flex items-center rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50"
            href={backHref}
          >
            Back to RAG catalog
          </Link>
        </div>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,420px)]">
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                  {document.language_code}
                </span>
                <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">
                  {document.document_kind}
                </span>
                {variantProductKeys.length > 0 ? (
                  <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                    {variantProductKeys.length} size variant
                    {variantProductKeys.length === 1 ? '' : 's'}
                  </span>
                ) : null}
                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                  Active: {sourceRecord.is_active ? 'Yes' : 'No'}
                </span>
              </div>

              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                  RAG product line
                </p>
                <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                  {document.title}
                </h1>
                <p className="mt-3 max-w-3xl whitespace-pre-wrap text-base leading-7 text-slate-600">
                  {heroCopy}
                </p>
              </div>

              <dl className="grid gap-4 pt-2 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-2xl bg-slate-50 p-4">
                  <dt className="text-sm font-medium text-slate-500">
                    Product line key
                  </dt>
                  <dd className="mt-1 break-all text-sm text-slate-900">
                    {entity?.product_line_key ??
                      getMetadataString(document.metadata, 'product_line_key') ??
                      sourceRecord.source_pk}
                  </dd>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <dt className="text-sm font-medium text-slate-500">
                    Line ID
                  </dt>
                  <dd className="mt-1 text-sm text-slate-900">
                    {getMetadataString(document.metadata, 'prod_line_id') ??
                      'N/A'}
                  </dd>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <dt className="text-sm font-medium text-slate-500">
                    Document key
                  </dt>
                  <dd className="mt-1 break-all text-sm text-slate-900">
                    {document.document_key}
                  </dd>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <dt className="text-sm font-medium text-slate-500">
                    Chunk count
                  </dt>
                  <dd className="mt-1 text-sm text-slate-900">
                    {chunks.length}
                  </dd>
                </div>
              </dl>

              {variantProductKeys.length > 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <h3 className="text-sm font-semibold text-slate-900">
                    Size variants (legacy catalog)
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    Each SKU/size maps to a `legacy.products` row. Open the legacy
                    product page for full variant fields.
                  </p>
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {variantProductKeys.map((pk, index) => (
                      <li key={`${index}-${pk}`}>
                        <Link
                          className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-sky-800 ring-1 ring-slate-200 transition hover:bg-sky-50"
                          href={`/admin/products/legacy/${encodeURIComponent(pk)}`}
                        >
                          {pk}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-3">
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6 shadow-sm">
                <h2 className="text-lg font-semibold text-slate-950">
                  Retrieval summary
                </h2>
                <dl className="mt-4 grid gap-3 text-sm text-slate-700">
                  <div>
                    <dt className="font-medium text-slate-500">Token count</dt>
                    <dd>{document.token_count ?? 'N/A'}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-slate-500">Source type</dt>
                    <dd>{sourceRecord.source_type}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-slate-500">Source locale</dt>
                    <dd>{sourceRecord.source_locale}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-slate-500">Last seen</dt>
                    <dd>{sourceRecord.last_seen_at}</dd>
                  </div>
                </dl>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
                <p className="font-medium text-slate-900">About this page</p>
                <p className="mt-1">
                  One retrieval document per legacy product line. Size variants are
                  listed in the body, with product keys in metadata for deep links.
                </p>
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
                    Document record
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Every non-empty field from `rag.document` is listed here so you
                    can inspect the fully assembled retrieval record.
                  </p>
                </div>
                <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {documentFields.length} fields
                </div>
              </div>

              <dl className="mt-6 grid gap-x-6 gap-y-5 sm:grid-cols-2">
                {documentFields.map((field) => (
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
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                    Retrieval-ready body
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    This is the assembled `rag.document.body_text` content that is
                    later chunked for lexical and vector search.
                  </p>
                </div>
                <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {document.token_count ?? 'N/A'} estimated tokens
                </div>
              </div>

              <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <pre className="wrap-break-word whitespace-pre-wrap text-sm leading-7 text-slate-800">
                  {document.body_text}
                </pre>
              </div>
            </section>

            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                    Document chunks
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    These records come from `rag.document_chunk` and represent the
                    retrieval units that get embedded and searched.
                  </p>
                </div>
                <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {chunks.length} chunks
                </div>
              </div>

              {chunks.length === 0 ? (
                <p className="mt-6 text-sm text-slate-600">
                  No chunks have been generated yet for this document.
                </p>
              ) : (
                <div className="mt-6 flex flex-col gap-4">
                  {chunks.map((chunk) => (
                    <article
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-5"
                      key={chunk.id}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                          Chunk {chunk.chunk_index}
                        </span>
                        {chunk.heading ? (
                          <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">
                            {chunk.heading}
                          </span>
                        ) : null}
                        {chunk.embedding_model_large ? (
                          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                            {chunk.embedding_model_large}
                          </span>
                        ) : (
                          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                            Not embedded yet
                          </span>
                        )}
                      </div>

                      <dl className="mt-4 grid gap-3 text-sm text-slate-600 sm:grid-cols-2">
                        <div>
                          <dt className="font-medium text-slate-500">
                            Section path
                          </dt>
                          <dd>{chunk.section_path?.join(' / ') || 'N/A'}</dd>
                        </div>
                        <div>
                          <dt className="font-medium text-slate-500">
                            Token count
                          </dt>
                          <dd>{chunk.token_count ?? 'N/A'}</dd>
                        </div>
                      </dl>

                      <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                        {chunk.chunk_text}
                      </p>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>

          <div className="flex flex-col gap-6">
            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                    Source record
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Lineage and sync state from `rag.source_record`.
                  </p>
                </div>
                <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                  {sourceFields.length} fields
                </div>
              </div>

              <dl className="mt-6 grid gap-4">
                {sourceFields.map((field) => (
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

            {entity ? (
              <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                      Entity record
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Canonical product line identity from `rag.entity`.
                    </p>
                  </div>
                  <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    {entityFields.length} fields
                  </div>
                </div>

                <dl className="mt-6 grid gap-4">
                  {entityFields.map((field) => (
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
            ) : null}

            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                Metadata
              </h2>
              <div className="mt-6 flex flex-col gap-6">
                <div>
                  <h3 className="text-base font-semibold text-slate-900">
                    Document metadata
                  </h3>
                  {documentMetadataFields.length === 0 ? (
                    <p className="mt-3 text-sm text-slate-600">
                      No document metadata is present.
                    </p>
                  ) : (
                    <dl className="mt-4 grid gap-4">
                      {documentMetadataFields.map((field) => (
                        <div
                          className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                          key={`document-${field.key}`}
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
                  )}
                </div>

                <div>
                  <h3 className="text-base font-semibold text-slate-900">
                    Source metadata
                  </h3>
                  {sourceMetadataFields.length === 0 ? (
                    <p className="mt-3 text-sm text-slate-600">
                      No source metadata is present.
                    </p>
                  ) : (
                    <dl className="mt-4 grid gap-4">
                      {sourceMetadataFields.map((field) => (
                        <div
                          className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                          key={`source-${field.key}`}
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
                  )}
                </div>
              </div>
            </section>
          </div>
        </section>
      </main>
    </div>
  );
}
