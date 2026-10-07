import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <div className="flex items-center">
          <div className="inline-flex items-center rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200">
            Back to RAG catalog
          </div>
        </div>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-4">
            <div className="flex gap-2">
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                EN
              </span>
              <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">
                product_line_profile
              </span>
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                SKU:
              </span>
            </div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
              RAG product line
            </p>
            <Skeleton className="h-10 w-2/3 rounded-md" />
            <Skeleton className="h-5 w-full rounded-md" />
            <Skeleton className="h-5 w-5/6 rounded-md" />

            <div className="grid gap-4 pt-2 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <div className="rounded-2xl bg-slate-50 p-4" key={index}>
                  <div className="text-sm font-medium text-slate-500">
                    {index === 0
                      ? 'Product line key'
                      : index === 1
                        ? 'Line ID'
                        : index === 2
                          ? 'Document key'
                          : 'Chunk count'}
                  </div>
                  <Skeleton className="mt-3 h-5 w-3/4 rounded-md" />
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <div className="flex flex-col gap-6">
            {Array.from({ length: 2 }, (_, sectionIndex) => (
              <section
                className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"
                key={sectionIndex}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-3">
                    <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                      {sectionIndex === 0 ? 'Retrieval-ready body' : 'Document chunks'}
                    </h2>
                    <p className="text-sm leading-6 text-slate-600">
                      Loading transformed RAG content.
                    </p>
                  </div>
                  <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    Loading
                  </div>
                </div>

                <div className="mt-6 flex flex-col gap-4">
                  {Array.from({ length: sectionIndex === 0 ? 1 : 3 }, (_, index) => (
                    <div
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                      key={index}
                    >
                      <Skeleton className="h-5 w-40 rounded-md" />
                      <Skeleton className="mt-4 h-4 w-full rounded-md" />
                      <Skeleton className="mt-2 h-4 w-5/6 rounded-md" />
                      <Skeleton className="mt-2 h-4 w-4/6 rounded-md" />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <div className="flex flex-col gap-6">
            {Array.from({ length: 3 }, (_, sectionIndex) => (
              <section
                className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"
                key={sectionIndex}
              >
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  {sectionIndex === 0
                    ? 'Source record'
                    : sectionIndex === 1
                      ? 'Entity record'
                      : 'Metadata'}
                </h2>
                <div className="mt-6 flex flex-col gap-4">
                  {Array.from({ length: 3 }, (_, cardIndex) => (
                    <div
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                      key={cardIndex}
                    >
                      <Skeleton className="h-5 w-32 rounded-md" />
                      <Skeleton className="mt-4 h-4 w-full rounded-md" />
                      <Skeleton className="mt-2 h-4 w-3/4 rounded-md" />
                    </div>
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
