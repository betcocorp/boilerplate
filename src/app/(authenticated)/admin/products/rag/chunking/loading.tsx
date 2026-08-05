import { PageHeaderSkeleton, TableSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

/** Eyebrow + title on the left and a status pill on the right — not the page-header shape. */
function CardHeadingSkeleton({ titleWidth }: { titleWidth: string }) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Skeleton className="h-5 w-32 rounded-md" />
          <Skeleton className={`mt-1 h-8 rounded-md ${titleWidth}`} />
        </div>
        <Skeleton className="h-7 w-40 rounded-full" />
      </div>
      <Skeleton className="mt-3 h-4 w-full rounded-md" />
      <Skeleton className="mt-2 h-4 w-4/5 rounded-md" />
    </>
  );
}

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-9 w-44 rounded-full" />
          <Skeleton className="h-9 w-40 rounded-full" />
        </div>

        <PageHeaderSkeleton>
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div className="rounded-2xl bg-slate-50 px-4 py-3" key={index}>
                <Skeleton className="h-4 w-28 rounded-md" />
                <Skeleton className="mt-1.5 h-5 w-32 rounded-full" />
              </div>
            ))}
          </div>
        </PageHeaderSkeleton>

        {/* Chunking strategy and token budget */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <CardHeadingSkeleton titleWidth="w-80" />

          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div className="rounded-2xl bg-slate-50 px-4 py-3" key={index}>
                <Skeleton className="h-4 w-24 rounded-md" />
                <Skeleton className="mt-1 h-7 w-20 rounded-md" />
              </div>
            ))}
          </div>

          <div className="mt-6">
            <Skeleton className="mb-3 h-5 w-48 rounded-md" />
            <div className="grid grid-cols-5 gap-3">
              {Array.from({ length: 5 }, (_, index) => (
                <div className="flex flex-col gap-1" key={index}>
                  <Skeleton className="h-4 w-full rounded-md" />
                  <Skeleton className="h-2 w-full rounded-full" />
                  <Skeleton className="ml-auto h-3 w-8 rounded-md" />
                </div>
              ))}
            </div>
            <Skeleton className="mt-2 h-4 w-2/3 rounded-md" />
          </div>

          <div className="mt-8 border-t border-slate-100 pt-6">
            <Skeleton className="mb-4 h-5 w-44 rounded-md" />
            <div className="flex flex-wrap gap-4">
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-4 w-16 rounded-md" />
                <Skeleton className="h-10 w-56 rounded-xl" />
              </div>
              {Array.from({ length: 3 }, (_, index) => (
                <div className="flex flex-col gap-1.5" key={index}>
                  <Skeleton className="h-4 w-20 rounded-md" />
                  <Skeleton className="h-10 w-28 rounded-xl" />
                </div>
              ))}
            </div>
          </div>

          <Skeleton className="mt-6 h-5 w-40 rounded-md" />
        </section>

        {/* Domain metadata enrichment */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <CardHeadingSkeleton titleWidth="w-72" />
          <TableSkeleton className="mt-6" columns={6} rows={8} />
          <div className="mt-4 flex items-center justify-between">
            <Skeleton className="h-4 w-52 rounded-md" />
            <div className="flex gap-2">
              <Skeleton className="h-7 w-14 rounded-xl" />
              <Skeleton className="h-7 w-14 rounded-xl" />
            </div>
          </div>
        </section>

        {/* Similarity boost rules */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <CardHeadingSkeleton titleWidth="w-64" />
          <TableSkeleton className="mt-6" columns={4} rows={4} />
          <Skeleton className="mt-6 h-5 w-48 rounded-md" />
        </section>
      </main>
    </div>
  );
}
