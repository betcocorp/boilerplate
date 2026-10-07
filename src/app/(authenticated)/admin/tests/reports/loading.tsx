import { PageHeaderSkeleton, TableSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <PageHeaderSkeleton descriptionLines={3} />

        {/* Reports */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <Skeleton className="h-6 w-28 rounded-md" />
            <Skeleton className="h-4 w-24 rounded-md" />
          </div>
          <TableSkeleton
            className="rounded-none border-0"
            columns={5}
            rows={8}
          />
        </section>
      </main>
    </div>
  );
}
