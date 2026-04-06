export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            RAG Generation
          </p>
          <div className="mt-3 h-10 w-2/3 animate-pulse rounded bg-slate-200" />
          <div className="mt-4 h-5 w-full animate-pulse rounded bg-slate-100" />
          <div className="mt-2 h-5 w-5/6 animate-pulse rounded bg-slate-100" />
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <article
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              key={index}
            >
              <div className="h-4 w-24 animate-pulse rounded bg-slate-100" />
              <div className="mt-4 h-8 w-20 animate-pulse rounded bg-slate-200" />
              <div className="mt-4 h-4 w-32 animate-pulse rounded bg-slate-100" />
            </article>
          ))}
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
            <div className="h-8 w-56 animate-pulse rounded bg-slate-200" />
            <div className="mt-4 h-4 w-full animate-pulse rounded bg-slate-100" />
            <div className="mt-2 h-4 w-5/6 animate-pulse rounded bg-slate-100" />
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {Array.from({ length: 3 }, (_, index) => (
                <div
                  className="h-12 rounded-2xl border border-slate-300 bg-white"
                  key={index}
                />
              ))}
            </div>
            <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <div
                  className="h-12 rounded-2xl bg-slate-950/20"
                  key={index}
                />
              ))}
            </div>
          </section>

          <div className="flex flex-col gap-4">
            {Array.from({ length: 3 }, (_, index) => (
              <section
                className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"
                key={index}
              >
                <div className="h-8 w-40 animate-pulse rounded bg-slate-200" />
                <div className="mt-6 flex flex-col gap-3">
                  {Array.from({ length: 3 }, (_, rowIndex) => (
                    <div
                      className="h-12 rounded-2xl bg-slate-50"
                      key={rowIndex}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
