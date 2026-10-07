import { Skeleton } from '~/components/ui/skeleton';

/**
 * Shaped to `page.tsx` (`BexComparePage`): icon + title header, two conversation
 * selects, and the two-thread comparison columns. The difference-analysis table only
 * renders once both threads are loaded, so it's omitted here rather than guessed.
 */
export default function BexCompareLoading() {
  return (
    <main className="flex min-h-0 flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-start gap-3">
        <Skeleton className="size-10 shrink-0 rounded-2xl" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-24 rounded-md" />
          <Skeleton className="h-7 w-56 rounded-lg" />
          <Skeleton className="h-4 w-full max-w-2xl rounded-md" />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <div className="flex items-center gap-2" key={index}>
            <Skeleton className="h-4 w-16 shrink-0 rounded-md" />
            <Skeleton className="h-9 flex-1 rounded-md" />
          </div>
        ))}
      </div>

      <div className="flex min-h-96 flex-col gap-3 lg:flex-row">
        {Array.from({ length: 2 }, (_, index) => (
          <div
            className="flex min-w-0 flex-1 flex-col rounded-2xl border border-border/60 bg-background"
            key={index}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border/50 p-3">
              <div className="min-w-0 space-y-1.5">
                <Skeleton className="h-3 w-16 rounded-md" />
                <Skeleton className="h-4 w-32 rounded-md" />
              </div>
              <Skeleton className="h-8 w-28 shrink-0 rounded-xl" />
            </div>
            <div className="min-h-0 flex-1 space-y-2 p-3">
              {Array.from({ length: 3 }, (_, rowIndex) => (
                <Skeleton className="h-16 w-full rounded-xl" key={rowIndex} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
