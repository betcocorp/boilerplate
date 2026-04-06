function ProductCardSkeleton({ index }: { index: number }) {
  return (
    <article
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
      key={index}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
          EN
        </span>
        <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">
          product_profile
        </span>
        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
          SKU:
        </span>
      </div>

      <div className="mt-4 h-8 w-3/4 animate-pulse rounded bg-slate-200" />

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <div className="text-sm font-medium text-slate-500">Product key</div>
          <div className="h-5 w-24 animate-pulse rounded bg-slate-200" />
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium text-slate-500">Product line</div>
          <div className="h-5 w-28 animate-pulse rounded bg-slate-200" />
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium text-slate-500">Source type</div>
          <div className="h-5 w-16 animate-pulse rounded bg-slate-200" />
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium text-slate-500">Active</div>
          <div className="h-5 w-20 animate-pulse rounded bg-slate-200" />
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
        <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-slate-100" />
      </div>
    </article>
  );
}

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
              RAG Product Search
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-slate-950">
              Search products from your RAG schema
            </h1>
            <p className="max-w-3xl text-base leading-7 text-slate-600">
              This view reads retrieval-ready product profile documents from the
              derived `rag` schema.
            </p>
          </div>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <input
              className="h-12 flex-1 rounded-2xl border border-slate-300 bg-white px-4 text-sm text-slate-400 outline-none ring-0"
              disabled
              placeholder="Search by title, product key, SKU, document key, or body text"
              type="search"
            />
            <button
              className="inline-flex h-12 w-44 items-center justify-center rounded-2xl bg-slate-950 px-6 text-sm font-semibold text-white opacity-80"
              disabled
              type="button"
            >
              Search RAG products
            </button>
          </div>
        </section>

        <section className="flex items-center justify-between">
          <div className="text-sm text-slate-600">Loading RAG products...</div>
          <div className="text-sm text-slate-600">Page ...</div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <ProductCardSkeleton index={index} key={index} />
          ))}
        </section>
      </main>
    </div>
  );
}
