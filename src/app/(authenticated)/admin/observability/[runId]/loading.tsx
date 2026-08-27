import { Skeleton } from '~/components/ui/skeleton';

/**
 * Shaped to `page.tsx`: header (badges row + 4-col meta grid + 3-col payload summary +
 * user message box), answer panel, timeline panel, collapsed retrieved-chunks panel.
 * Harness-only bands (verdict, prompt history) are omitted — they don't render for most runs.
 */
export default function AdminRunTraceLoading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-40 rounded-md" />
              <Skeleton className="h-9 w-48 rounded-lg" />
              <Skeleton className="h-3 w-64 rounded-md" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-8 w-24 rounded-2xl" />
              <Skeleton className="h-8 w-24 rounded-2xl" />
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            {Array.from({ length: 7 }, (_, index) => (
              <Skeleton className="h-6 w-24 rounded-full" key={index} />
            ))}
          </div>

          <div className="mt-6 grid gap-3 text-sm sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div className="flex flex-col gap-1" key={index}>
                <Skeleton className="h-3 w-16 rounded-md" />
                <Skeleton className="h-4 w-28 rounded-md" />
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div className="flex flex-col gap-1" key={index}>
                <Skeleton className="h-3 w-24 rounded-md" />
                <Skeleton className="h-4 w-20 rounded-md" />
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
            <Skeleton className="h-3 w-28 rounded-md" />
            <Skeleton className="mt-2 h-4 w-full rounded-md" />
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <Skeleton className="h-6 w-20 rounded-md" />
          <Skeleton className="mt-4 h-32 w-full rounded-2xl" />
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-6 flex items-center gap-3">
            <Skeleton className="h-6 w-24 rounded-md" />
            <Skeleton className="h-6 w-10 rounded-full" />
          </div>
          <Skeleton className="h-72 w-full rounded-2xl" />
        </section>

        <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center gap-3 px-8 py-6">
            <Skeleton className="h-6 w-40 rounded-md" />
            <Skeleton className="h-6 w-10 rounded-full" />
          </div>
        </section>
      </main>
    </div>
  );
}
