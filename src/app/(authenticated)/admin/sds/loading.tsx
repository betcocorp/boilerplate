import { PageHeaderSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function AdminSdsLoading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-6 px-6 py-10 sm:px-8">
        <PageHeaderSkeleton />
        <Skeleton className="h-[560px] w-full rounded-3xl" />
      </main>
    </div>
  );
}
