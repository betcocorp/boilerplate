function ProductCardSkeleton({ index }: { index: number }) {
  return (
    <article
      className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
      key={index}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="h-6 w-28 animate-pulse rounded-full bg-emerald-100" />
        <div className="h-6 w-20 animate-pulse rounded-full bg-slate-100" />
        <div className="h-6 w-24 animate-pulse rounded-full bg-sky-100" />
      </div>

      <div className="mt-4 h-8 w-3/4 animate-pulse rounded bg-slate-200" />

      <div className="mt-4 flex flex-col gap-2">
        <div className="h-5 w-2/3 animate-pulse rounded bg-slate-200" />
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="h-4 w-32 animate-pulse rounded bg-slate-100" />
          <div className="h-4 w-36 animate-pulse rounded bg-slate-100" />
          <div className="h-4 w-40 animate-pulse rounded bg-slate-100" />
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
        <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-slate-100" />
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <div className="h-10 w-40 animate-pulse rounded-full bg-slate-900/15" />
        <div className="h-10 w-36 animate-pulse rounded-full bg-slate-200" />
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

          <div className="mt-8 grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(220px,0.8fr)_120px_160px_auto]">
            <input
              className="h-12 rounded-2xl border border-slate-300 bg-white px-4 text-sm text-slate-400 outline-none ring-0"
              disabled
              placeholder="Ask something like: peroxide bathroom disinfectant"
              type="search"
            />
            <input
              className="h-12 rounded-2xl border border-slate-300 bg-white px-4 text-sm text-slate-400 outline-none ring-0"
              disabled
              placeholder="Optional product line key"
              type="text"
            />
            <input
              className="h-12 rounded-2xl border border-slate-300 bg-white px-4 text-sm text-slate-400 outline-none ring-0"
              disabled
              placeholder="8"
              type="number"
            />
            <input
              className="h-12 rounded-2xl border border-slate-300 bg-white px-4 text-sm text-slate-400 outline-none ring-0"
              disabled
              placeholder="0.65 or 65"
              type="text"
            />
            <button
              className="inline-flex h-12 items-center justify-center rounded-2xl bg-slate-950 px-6 text-sm font-semibold text-white opacity-80"
              disabled
              type="button"
            >
              Run search
            </button>
          </div>
          <p className="mt-3 text-sm text-slate-500">
            Minimum similarity is optional. Enter a decimal like `0.65` or a whole
            percent like `65`.
          </p>
        </section>

        <section className="flex items-center justify-between">
          <div className="text-sm text-slate-600">Loading semantic search results...</div>
          <div className="text-sm text-slate-600">Preparing similarity range...</div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 6 }, (_, index) => (
            <ProductCardSkeleton index={index} key={index} />
          ))}
        </section>
      </main>
    </div>
  );
}
