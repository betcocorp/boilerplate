import { PageHeaderSkeleton, TableSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <PageHeaderSkeleton descriptionLines={3} titleClassName="h-9 w-96" />

        {/* Disagreement matrix */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <Skeleton className="mb-4 h-5 w-48 rounded-md" />
          <TableSkeleton className="rounded-xl border-slate-100" columns={5} rows={5} />
        </section>

        {/* Latency profiling */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <Skeleton className="mb-3 h-5 w-40 rounded-md" />
          <Skeleton className="h-4 w-full max-w-2xl rounded-md" />
        </section>

        {/* Cutover-readiness */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <Skeleton className="mb-4 h-5 w-56 rounded-md" />
          <div className="flex flex-wrap gap-3">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton className="h-6 w-48 rounded-full" key={index} />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
