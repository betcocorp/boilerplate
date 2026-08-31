import { PageHeaderSkeleton, StatCardGridSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <main className="min-w-0 space-y-6 p-4 sm:p-6">
      <PageHeaderSkeleton
        card={false}
        descriptionLines={1}
        titleClassName="h-9 w-48"
      />
      <StatCardGridSkeleton columnsClassName="md:grid-cols-3" count={3} />
      <Skeleton className="h-[340px] w-full rounded-3xl bg-muted/60" />
      <Skeleton className="h-[340px] w-full rounded-3xl bg-muted/60" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72 w-full rounded-3xl bg-muted/60" />
        <Skeleton className="h-72 w-full rounded-3xl bg-muted/60" />
      </div>
    </main>
  );
}
