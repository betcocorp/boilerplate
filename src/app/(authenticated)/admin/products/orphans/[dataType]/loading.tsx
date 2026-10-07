import { TableSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

/** Shaped to `page.tsx` + `OrphanQueueTable`: back link, header, search/filter row, 5-col table, pager. */
export default function OrphanDataTypeLoading() {
  return (
    <div className="space-y-6 p-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-32 rounded-md" />
        <Skeleton className="h-7 w-64 rounded-lg" />
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-9 max-w-sm flex-1 rounded-md" />
          <Skeleton className="h-9 w-20 rounded-md" />
          <Skeleton className="h-4 w-36 rounded-md" />
          <Skeleton className="h-4 w-32 rounded-md" />
        </div>

        <TableSkeleton columns={5} />

        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-40 rounded-md" />
          <div className="flex gap-2">
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
        </div>
      </div>
    </div>
  );
}
