import { Skeleton } from '~/components/ui/skeleton';

/** Shaped to `page.tsx` + `OrphanSummaryCards`: plain header, one card per data type (7). */
export default function OrphanDashboardLoading() {
  return (
    <div className="space-y-6 p-6">
      <header className="space-y-2">
        <Skeleton className="h-7 w-48 rounded-lg" />
        <Skeleton className="h-4 w-full max-w-2xl rounded-md" />
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 7 }, (_, index) => (
          <div className="rounded-2xl border border-border bg-card p-5" key={index}>
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-28 rounded-md" />
              <Skeleton className="h-5 w-8 rounded-full" />
            </div>
            <Skeleton className="mt-3 h-8 w-12 rounded-md" />
            <Skeleton className="mt-2 h-3 w-32 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
