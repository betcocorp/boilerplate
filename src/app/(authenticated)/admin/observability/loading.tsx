import { PageHeaderSkeleton, TableSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

/** Shaped to `page.tsx` + `RunsTable`: header, collapsed filter bar, runs table (10 cols). */
export default function AdminObservabilityLoading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <PageHeaderSkeleton descriptionLines={4} />

        {/* Filters — collapsed by default, matching RunsFilters' initial `showFilters` state. */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Skeleton className="h-7 w-20 rounded-md" />
            <Skeleton className="h-8 w-28 rounded-full" />
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-7 w-36 rounded-md" />
              <Skeleton className="h-6 w-10 rounded-full" />
            </div>
            <Skeleton className="h-4 w-16 rounded-md" />
          </div>
          <TableSkeleton columns={10} />
        </section>
      </main>
    </div>
  );
}
