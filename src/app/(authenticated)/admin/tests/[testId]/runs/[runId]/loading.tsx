import { PageHeaderSkeleton, TableSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        {/* Run header + toolbar (Back, Notes, Full export, Delete run) */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <PageHeaderSkeleton
              card={false}
              descriptionLines={1}
              titleClassName="h-9 w-72"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-9 w-28 rounded-md" />
              <Skeleton className="h-9 w-24 rounded-md" />
              <Skeleton className="h-9 w-32 rounded-md" />
              <Skeleton className="h-9 w-28 rounded-md" />
            </div>
          </div>
        </section>

        {/* Run progress */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex items-center justify-between">
            <Skeleton className="h-6 w-36 rounded-md" />
            <Skeleton className="h-4 w-56 rounded-md" />
          </div>
          <Skeleton className="mt-2 h-4 w-64 rounded-md" />
          <Skeleton className="mt-4 h-3 w-full rounded-full" />
          <div className="mt-2 grid grid-cols-3 items-center gap-4">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton className="h-3 w-full rounded-md" key={index} />
            ))}
          </div>
        </section>

        {/* At-a-glance charts: two full-width trends, then two half-width panels */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <Skeleton className="h-6 w-48 rounded-md" />
          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-4">
            {Array.from({ length: 2 }, (_, index) => (
              <article
                className="col-span-4 min-w-0 rounded-2xl border border-slate-200 p-5"
                key={`wide-${index}`}
              >
                <Skeleton className="h-4 w-64 rounded-md" />
                <Skeleton className="mt-4 h-56 w-full rounded-xl" />
              </article>
            ))}
            {Array.from({ length: 2 }, (_, index) => (
              <article
                className="col-span-4 min-w-0 rounded-2xl border border-slate-200 p-5 lg:col-span-2"
                key={`half-${index}`}
              >
                <Skeleton className="h-4 w-40 rounded-md" />
                <Skeleton className="mt-4 h-56 w-full rounded-xl" />
              </article>
            ))}
          </div>
        </section>

        {/* Run insights */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <Skeleton className="h-4 w-28 rounded-md" />
              <Skeleton className="mt-1 h-7 w-44 rounded-lg" />
              <Skeleton className="mt-1 h-4 w-96 max-w-full rounded-md" />
            </div>
            <Skeleton className="h-9 w-40 rounded-md" />
          </div>
        </section>

        {/* Item-level results */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <Skeleton className="h-6 w-44 rounded-md" />
            <div className="flex items-center gap-4">
              <Skeleton className="h-9 w-64 rounded-lg" />
              <Skeleton className="h-9 w-32 rounded-md" />
            </div>
          </div>
          <TableSkeleton columns={11} rows={8} />
          <Skeleton className="mt-3 h-3 w-80 rounded-md" />
        </section>
      </main>
    </div>
  );
}
