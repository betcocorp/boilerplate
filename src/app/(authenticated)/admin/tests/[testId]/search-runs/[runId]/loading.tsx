import { PageHeaderSkeleton, TableSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        {/* Search run header + toolbar (Back, Delete run) */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <PageHeaderSkeleton
              card={false}
              descriptionLines={2}
              titleClassName="h-9 w-72"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-9 w-28 rounded-md" />
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
          <div className="mt-2 grid grid-cols-4 items-center gap-4">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton className="h-3 w-full rounded-md" key={index} />
            ))}
          </div>
        </section>

        {/* Gold eval by category */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <Skeleton className="mb-1 h-6 w-56 rounded-md" />
          <Skeleton className="mb-4 h-4 w-40 rounded-md" />
          <TableSkeleton columns={5} rows={5} />
        </section>

        {/* Per-prompt results */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <Skeleton className="mb-4 h-6 w-48 rounded-md" />
          <TableSkeleton columns={10} rows={8} />
          <Skeleton className="mt-3 h-3 w-80 rounded-md" />
        </section>
      </main>
    </div>
  );
}
