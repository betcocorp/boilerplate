import { PageHeaderSkeleton, TableSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

/** Shaped to `page.tsx` + `ConversationsTable`: header, collapsed filter bar, table (9 cols). */
export default function AdminConversationsLoading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <PageHeaderSkeleton descriptionLines={3} />
        <section className="rounded-3xl border border-slate-200 bg-white px-8 py-4 shadow-sm">
          <Skeleton className="h-7 w-20 rounded-md" />
        </section>
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-7 w-36 rounded-md" />
              <Skeleton className="h-6 w-10 rounded-full" />
            </div>
            <Skeleton className="h-4 w-20 rounded-md" />
          </div>
          <TableSkeleton columns={9} />
        </section>
      </main>
    </div>
  );
}
