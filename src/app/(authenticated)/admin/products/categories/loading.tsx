import { PageHeaderSkeleton, TableSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-6 px-6 py-10 sm:px-8">
        <PageHeaderSkeleton card={false} titleClassName="h-8 w-64" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <TableSkeleton columns={6} rows={8} />
      </main>
    </div>
  );
}
