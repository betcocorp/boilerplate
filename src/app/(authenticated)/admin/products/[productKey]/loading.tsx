export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <div className="flex items-center">
          <div className="inline-flex items-center rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200">
            Back to products
          </div>
        </div>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-4">
            <div className="flex gap-2">
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                Status:
              </span>
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                OnWeb:
              </span>
              <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">
                SKU:
              </span>
            </div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
              Product details
            </p>
            <div className="h-10 w-2/3 animate-pulse rounded bg-slate-200" />
            <div className="h-5 w-full animate-pulse rounded bg-slate-100" />
            <div className="h-5 w-5/6 animate-pulse rounded bg-slate-100" />

            <div className="grid gap-4 pt-2 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <div
                  className="rounded-2xl bg-slate-50 p-4"
                  key={index}
                >
                  <div className="text-sm font-medium text-slate-500">
                    {index === 0
                      ? 'Inventory ID'
                      : index === 1
                        ? 'MSRP'
                        : index === 2
                          ? 'Years of service'
                          : 'Product key'}
                  </div>
                  <div className="mt-3 h-5 w-3/4 animate-pulse rounded bg-slate-100" />
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-3">
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  Product record
                </h2>
                <p className="text-sm leading-6 text-slate-600">
                  Every non-empty field from the `products` row is listed here so
                  the detail page reflects the full typed record.
                </p>
              </div>
              <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                Loading fields
              </div>
            </div>

            <div className="mt-6 grid gap-x-6 gap-y-5 sm:grid-cols-2">
              {Array.from({ length: 10 }, (_, index) => (
                <div
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  key={index}
                >
                  <div className="text-sm font-medium text-slate-500">
                    Field {index + 1}
                  </div>
                  <div className="mt-3 h-5 w-full animate-pulse rounded bg-slate-100" />
                  <div className="mt-2 h-5 w-2/3 animate-pulse rounded bg-slate-100" />
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-6">
            {Array.from({ length: 2 }, (_, sectionIndex) => (
              <section
                className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"
                key={sectionIndex}
              >
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  {sectionIndex === 0 ? 'Descriptions' : 'Images'}
                </h2>
                <div className="mt-6 flex flex-col gap-4">
                  {Array.from({ length: 3 }, (_, cardIndex) => (
                    <div
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                      key={cardIndex}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="h-5 w-40 animate-pulse rounded bg-slate-200" />
                        <div className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                          {sectionIndex === 0 ? 'Language' : 'Sequence'}
                        </div>
                      </div>
                      <div className="mt-4 h-4 w-full animate-pulse rounded bg-slate-100" />
                      <div className="mt-2 h-4 w-5/6 animate-pulse rounded bg-slate-100" />
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
