import { Skeleton } from '~/components/ui/skeleton';
import { cn } from '~/lib/utils';

/** Deterministic widths — avoid hydration mismatches from random widths. */
const METRIC_WIDTHS = ['w-32', 'w-20', 'w-16', 'w-16'] as const;
const TITLE_WIDTHS = ['w-2/3', 'w-1/2', 'w-3/5'] as const;
const SNIPPET_WIDTHS = ['w-4/5', 'w-3/4', 'w-2/3'] as const;

export type WebSearchResultsSkeletonProps = {
  className?: string;
  /** Number of result cards. Default `3`. */
  count?: number;
};

/**
 * Mirrors the rendered web-search results region (metrics badge row + result
 * cards) used by both `WebSearchTester` and `WebSearchApiTester`.
 */
export function WebSearchResultsSkeleton({
  className,
  count = 3,
}: WebSearchResultsSkeletonProps) {
  return (
    <div
      aria-live="polite"
      className={cn('space-y-3', className)}
      role="status"
    >
      <div className="flex flex-wrap items-center gap-2">
        {METRIC_WIDTHS.map((width) => (
          <Skeleton className={cn('h-5 rounded-full', width)} key={width} />
        ))}
      </div>

      <ul className="space-y-2">
        {Array.from({ length: count }, (_, index) => (
          <li
            className="rounded-2xl border border-border/60 bg-background p-3"
            key={index}
          >
            <div className="flex items-start justify-between gap-2">
              <Skeleton
                className={cn(
                  'h-5 rounded-md',
                  TITLE_WIDTHS[index % TITLE_WIDTHS.length],
                )}
              />
              <div className="flex shrink-0 items-center gap-1">
                <Skeleton className="h-4 w-20 rounded-full" />
                <Skeleton className="h-4 w-10 rounded-full" />
              </div>
            </div>
            <div className="mt-2 space-y-1.5">
              <Skeleton className="h-4 w-full rounded-md" />
              <Skeleton
                className={cn(
                  'h-4 rounded-md',
                  SNIPPET_WIDTHS[index % SNIPPET_WIDTHS.length],
                )}
              />
            </div>
            <Skeleton className="mt-2 h-3 w-1/3 rounded-md" />
          </li>
        ))}
      </ul>

      {/* Last child: `sr-only` is absolutely positioned, so it adds no layout. */}
      <span className="sr-only">Loading results…</span>
    </div>
  );
}
