import { PageHeaderSkeleton, TableSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <PageHeaderSkeleton descriptionLines={3} titleClassName="h-9 w-64" />

        {/* Search */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-16 rounded-md" />
              <Skeleton className="h-9 w-full max-w-xl rounded-md" />
            </div>
            <Skeleton className="h-9 w-24 rounded-md" />
          </div>
        </section>

        {/* Failures */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-6 w-24 rounded-md" />
              <Skeleton className="h-6 w-10 rounded-full" />
            </div>
            {/* List / By category toggle */}
            <Skeleton className="h-10 w-52 rounded-xl" />
          </div>

          <TableSkeleton
            className="rounded-xl border-slate-100"
            columns={6}
            rows={8}
          />

          <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
            {Array.from({ length: 7 }, (_, index) => (
              <Skeleton className="h-9 w-16 rounded-xl" key={index} />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
