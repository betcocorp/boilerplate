import { PageHeaderSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <main className="min-w-0 space-y-6 p-4 sm:p-6">
      <PageHeaderSkeleton
        card={false}
        descriptionLines={0}
        eyebrow={false}
        titleClassName="h-9 w-48"
      />
      <Skeleton className="h-24 w-full rounded-2xl bg-muted/60" />
      <Skeleton className="h-52 w-full rounded-3xl bg-muted/60" />
      <Skeleton className="h-64 w-full rounded-3xl bg-muted/60" />
    </main>
  );
}
