function CardHeadingSkeleton({ titleWidth }: { titleWidth: string }) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="h-5 w-32 animate-pulse rounded bg-slate-100" />
          <div className={`mt-1 h-8 animate-pulse rounded bg-slate-200 ${titleWidth}`} />
        </div>
        <div className="h-7 w-40 animate-pulse rounded-full bg-slate-100" />
      </div>
      <div className="mt-3 h-4 w-full animate-pulse rounded bg-slate-100" />
      <div className="mt-2 h-4 w-4/5 animate-pulse rounded bg-slate-100" />
    </>
  );
}

function TableSkeleton({ columns, rows }: { columns: number; rows: number }) {
  return (
    <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-200">
      <div className="flex gap-4 bg-slate-50 px-4 py-2.5">
        {Array.from({ length: columns }, (_, index) => (
          <div
            className="h-4 flex-1 animate-pulse rounded bg-slate-200"
            key={index}
          />
        ))}
      </div>
      <div className="divide-y divide-slate-100">
        {Array.from({ length: rows }, (_, rowIndex) => (
          <div className="flex gap-4 px-4 py-3" key={rowIndex}>
            {Array.from({ length: columns }, (_, index) => (
              <div
                className="h-8 flex-1 animate-pulse rounded bg-slate-100"
                key={index}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <div className="h-9 w-44 animate-pulse rounded-full bg-white ring-1 ring-slate-200" />
          <div className="h-9 w-40 animate-pulse rounded-full bg-white ring-1 ring-slate-200" />
        </div>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
              RAG corpus quality
            </p>
            <div className="h-10 w-2/3 animate-pulse rounded bg-slate-200" />
            <div className="h-5 w-full animate-pulse rounded bg-slate-100" />
            <div className="h-5 w-5/6 animate-pulse rounded bg-slate-100" />
          </div>

          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div className="rounded-2xl bg-slate-50 px-4 py-3" key={index}>
                <div className="h-4 w-28 animate-pulse rounded bg-slate-200" />
                <div className="mt-1.5 h-5 w-32 animate-pulse rounded-full bg-slate-100" />
              </div>
            ))}
          </div>
        </section>

        {/* Chunking strategy and token budget */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <CardHeadingSkeleton titleWidth="w-80" />

          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div className="rounded-2xl bg-slate-50 px-4 py-3" key={index}>
                <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
                <div className="mt-1 h-7 w-20 animate-pulse rounded bg-slate-100" />
              </div>
            ))}
          </div>

          <div className="mt-6">
            <div className="mb-3 h-5 w-48 animate-pulse rounded bg-slate-200" />
            <div className="grid grid-cols-5 gap-3">
              {Array.from({ length: 5 }, (_, index) => (
                <div className="flex flex-col gap-1" key={index}>
                  <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
                  <div className="h-2 w-full animate-pulse rounded-full bg-slate-100" />
                  <div className="ml-auto h-3 w-8 animate-pulse rounded bg-slate-100" />
                </div>
              ))}
            </div>
            <div className="mt-2 h-4 w-2/3 animate-pulse rounded bg-slate-100" />
          </div>

          <div className="mt-8 border-t border-slate-100 pt-6">
            <div className="mb-4 h-5 w-44 animate-pulse rounded bg-slate-200" />
            <div className="flex flex-wrap gap-4">
              <div className="flex flex-col gap-1.5">
                <div className="h-4 w-16 animate-pulse rounded bg-slate-100" />
                <div className="h-10 w-56 animate-pulse rounded-xl border border-slate-200 bg-white" />
              </div>
              {Array.from({ length: 3 }, (_, index) => (
                <div className="flex flex-col gap-1.5" key={index}>
                  <div className="h-4 w-20 animate-pulse rounded bg-slate-100" />
                  <div className="h-10 w-28 animate-pulse rounded-xl border border-slate-200 bg-white" />
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6 h-5 w-40 animate-pulse rounded bg-slate-100" />
        </section>

        {/* Domain metadata enrichment */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <CardHeadingSkeleton titleWidth="w-72" />
          <TableSkeleton columns={6} rows={8} />
          <div className="mt-4 flex items-center justify-between">
            <div className="h-4 w-52 animate-pulse rounded bg-slate-100" />
            <div className="flex gap-2">
              <div className="h-7 w-14 animate-pulse rounded-xl bg-slate-100" />
              <div className="h-7 w-14 animate-pulse rounded-xl bg-slate-100" />
            </div>
          </div>
        </section>

        {/* Similarity boost rules */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <CardHeadingSkeleton titleWidth="w-64" />
          <TableSkeleton columns={4} rows={4} />
          <div className="mt-6 h-5 w-48 animate-pulse rounded bg-slate-100" />
        </section>
      </main>
    </div>
  );
}
