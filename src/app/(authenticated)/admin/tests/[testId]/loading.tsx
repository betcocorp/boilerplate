import { PageHeaderSkeleton, TableSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        {/* Dataset header + toolbar (Add prompt, Back, Run search eval, model + Run) */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <PageHeaderSkeleton
              card={false}
              descriptionLines={1}
              titleClassName="h-9 w-72"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-9 w-28 rounded-md" />
              <Skeleton className="h-9 w-32 rounded-md" />
              <Skeleton className="h-9 w-36 rounded-md" />
              <Skeleton className="h-9 w-36 rounded-md" />
              <Skeleton className="h-9 w-28 rounded-md" />
            </div>
          </div>
        </section>

        {/* Historical performance trends */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-5 flex items-end justify-between gap-3">
            <Skeleton className="h-6 w-64 rounded-md" />
            <Skeleton className="h-4 w-40 rounded-md" />
          </div>
          <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <article
                className="min-w-0 rounded-2xl border border-slate-200 p-5"
                key={index}
              >
                <Skeleton className="h-4 w-32 rounded-md" />
                <Skeleton className="mt-1 h-3 w-24 rounded-md" />
                <Skeleton className="mt-4 h-56 w-full rounded-xl" />
              </article>
            ))}
          </div>
        </section>

        {/* Recent runs */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <Skeleton className="h-6 w-36 rounded-md" />
          <TableSkeleton className="mt-4" columns={8} rows={6} />
        </section>

        {/* Search eval runs */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <Skeleton className="h-6 w-44 rounded-md" />
          <TableSkeleton className="mt-4" columns={10} rows={4} />
        </section>

        {/* Test prompts */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <Skeleton className="h-6 w-48 rounded-md" />
            <div className="flex w-full items-center gap-2 lg:max-w-2xl lg:flex-[0_1_44rem]">
              <Skeleton className="h-9 min-w-0 flex-1 rounded-2xl" />
              <Skeleton className="h-9 w-36 rounded-2xl" />
              <Skeleton className="size-9 shrink-0 rounded-2xl" />
            </div>
          </div>
          <Skeleton className="mt-2 h-3 w-72 rounded-md" />
          <TableSkeleton className="mt-4" columns={10} rows={8} />
        </section>
      </main>
    </div>
  );
}
