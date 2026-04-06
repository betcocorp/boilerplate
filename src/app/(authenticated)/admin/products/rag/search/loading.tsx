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
              Search the RAG product corpus semantically
            </h1>
            <p className="max-w-3xl text-base leading-7 text-slate-600">
              Loading semantic search tools...
            </p>
          </div>

          <div className="mt-8 grid gap-3 lg:grid-cols-[minmax(0,1.8fr)_minmax(180px,0.8fr)_minmax(180px,0.8fr)_120px_auto]">
            {Array.from({ length: 5 }, (_, index) => (
              <div
                className="h-12 rounded-2xl border border-slate-300 bg-white"
                key={index}
              />
            ))}
          </div>
        </section>

        <section className="grid gap-4">
          {Array.from({ length: 4 }, (_, index) => (
            <article
              className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
              key={index}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                  Similarity
                </span>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                  Chunk
                </span>
              </div>
              <div className="mt-4 h-8 w-1/2 animate-pulse rounded bg-slate-200" />
              <div className="mt-4 h-4 w-full animate-pulse rounded bg-slate-100" />
              <div className="mt-2 h-4 w-5/6 animate-pulse rounded bg-slate-100" />
              <div className="mt-2 h-4 w-3/4 animate-pulse rounded bg-slate-100" />
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
