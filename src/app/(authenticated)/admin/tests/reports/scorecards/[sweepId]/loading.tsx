import { PageHeaderSkeleton, TableSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        {/* Card header: eyebrow, Thursday label, one summary line, two buttons */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <PageHeaderSkeleton
              card={false}
              descriptionLines={1}
              titleClassName="h-9 w-80"
            />
            <div className="flex gap-2">
              <Skeleton className="h-9 w-32 rounded-md" />
              <Skeleton className="h-9 w-24 rounded-md" />
            </div>
          </div>
        </section>

        {/* Scorecard table + highlights / notes cards */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <Skeleton className="h-6 w-40 rounded-md" />
            <Skeleton className="h-8 w-96 rounded-md" />
          </div>
          <Skeleton className="mb-3 h-3 w-80 rounded-md" />
          <TableSkeleton columns={8} rows={6} />
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {Array.from({ length: 2 }, (_, index) => (
              <div
                className="rounded-2xl border border-slate-200 bg-slate-50/60 p-5"
                key={index}
              >
                <Skeleton className="h-4 w-40 rounded-md" />
                <div className="mt-3 flex flex-col gap-2">
                  <Skeleton className="h-4 w-full rounded-md" />
                  <Skeleton className="h-4 w-5/6 rounded-md" />
                  <Skeleton className="h-4 w-4/6 rounded-md" />
                </div>
                <Skeleton className="mt-4 h-3 w-full rounded-md" />
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
