import { PageHeaderSkeleton, TableSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        {/* Item header + prompt / should-answer panel */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <PageHeaderSkeleton
              card={false}
              descriptionLines={1}
              titleClassName="h-9 w-72"
            />
            <div className="flex items-center gap-2">
              <Skeleton className="h-9 w-36 rounded-md" />
              <Skeleton className="h-9 w-32 rounded-md" />
              <Skeleton className="h-9 w-32 rounded-md" />
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div>
              <Skeleton className="h-4 w-20 rounded-md" />
              <Skeleton className="mt-2 h-4 w-full rounded-md" />
              <Skeleton className="mt-1.5 h-4 w-4/5 rounded-md" />
            </div>
            <div className="border-l border-slate-200 pl-4">
              <Skeleton className="ml-auto h-4 w-28 rounded-md" />
              <Skeleton className="ml-auto mt-2 h-4 w-16 rounded-md" />
            </div>
          </div>
        </section>

        {/* At-a-glance charts */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Skeleton className="h-6 w-48 rounded-md" />
            <Skeleton className="h-3 w-64 rounded-md" />
          </div>
          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => (
              <article
                className="min-w-0 rounded-2xl border border-slate-200 p-5"
                key={index}
              >
                <Skeleton className="h-4 w-36 rounded-md" />
                <Skeleton className="mt-4 h-56 w-full rounded-xl" />
              </article>
            ))}
          </div>
        </section>

        {/* Historical outcomes */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <Skeleton className="h-6 w-60 rounded-md" />
          <TableSkeleton className="mt-4" columns={7} rows={8} />
        </section>
      </main>
    </div>
  );
}
