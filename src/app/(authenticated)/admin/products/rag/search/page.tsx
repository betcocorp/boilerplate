import Link from 'next/link';
import { connection } from 'next/server';

import { searchProductChunks } from '~/lib/rag/search';

const SEARCH_ROUTE = '/admin/products/rag/search';

type SearchPageProps = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
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
  const rawMinSimilarity = readSearchParam(resolvedSearchParams.minSimilarity);
  const minSimilarity = parseMinSimilarity(resolvedSearchParams.minSimilarity);
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
        minSimilarity: minSimilarity ?? undefined,
      });

      if (result.matches.length > 0) {
        const sims = result.matches.map((m) => m.similarity).sort((a, b) => a - b);
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
              Retrieval is one document per legacy product line. Chunks include
              rolled-up size variants; filters only target product line keys.
            </p>
          </div>

          <form
            action={SEARCH_ROUTE}
            className="mt-8 grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(220px,0.8fr)_120px_160px_auto]"
            method="get"
          >
            <input
              className="h-12 rounded-2xl border border-slate-300 bg-white px-4 text-sm text-slate-950 outline-none ring-0 transition focus:border-sky-500"
              defaultValue={query}
              name="q"
              placeholder="Ask something like: peroxide bathroom disinfectant"
              type="search"
            />
            <input
              className="h-12 rounded-2xl border border-slate-300 bg-white px-4 text-sm text-slate-950 outline-none ring-0 transition focus:border-sky-500"
              defaultValue={productLineKey}
              name="productLineKey"
              placeholder="Optional product line key"
              type="text"
            />
            <input
              className="h-12 rounded-2xl border border-slate-300 bg-white px-4 text-sm text-slate-950 outline-none ring-0 transition focus:border-sky-500"
              defaultValue={String(limit)}
              max="20"
              min="1"
              name="limit"
              type="number"
            />
            <input
              className="h-12 rounded-2xl border border-slate-300 bg-white px-4 text-sm text-slate-950 outline-none ring-0 transition focus:border-sky-500"
              defaultValue={rawMinSimilarity}
              name="minSimilarity"
              placeholder="0.65 or 65"
              type="text"
            />
            <button
              className="inline-flex h-12 items-center justify-center rounded-2xl bg-slate-950 px-6 text-sm font-semibold text-white transition hover:bg-slate-800"
              type="submit"
            >
              Run search
            </button>
          </form>
          <p className="mt-3 text-sm text-slate-500">
            Minimum similarity is optional. Enter a decimal like `0.65` or a whole
            percent like `65`.
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
                <code className="rounded bg-slate-100 px-1">{result.model}</code>.
                {similaritySummary ? ` Similarity range: ${similaritySummary}.` : ''}
              </div>
              <div className="text-sm text-slate-600">
                {result.productLineKey
                  ? `Filtered to product line ${result.productLineKey}.`
                  : 'No metadata filter applied.'}
                {result.minSimilarity !== null
                  ? ` Minimum similarity: ${(result.minSimilarity * 100).toFixed(1)}%.`
                  : ' No similarity floor applied.'}
              </div>
            </section>

            <section className="grid gap-4">
              {result.matches.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600">
                  No semantic matches were returned for that query. Try lowering the
                  minimum similarity if the query is too strict.
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
                    <Link
                      className="inline-flex rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
                      href={`/admin/products/rag/${encodeURIComponent(match.product_line_key || match.source_pk)}`}
                    >
                      View RAG product line
                    </Link>
                    <Link
                      className="inline-flex rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-50"
                      href="/admin/products/rag"
                    >
                      Browse RAG corpus
                    </Link>
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
