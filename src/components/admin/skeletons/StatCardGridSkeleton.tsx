import { Skeleton } from '~/components/ui/skeleton';
import { cn } from '~/lib/utils';

export type StatCardGridSkeletonProps = {
  /** Render the secondary caption line under the metric value. Default `true`. */
  caption?: boolean;
  /** Replaces the default card chrome (`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm`). */
  cardClassName?: string;
  /** Merged onto the grid wrapper. */
  className?: string;
  /** Tailwind column classes for the grid. Default `md:grid-cols-2 xl:grid-cols-4`. */
  columnsClassName?: string;
  /** Number of metric cards. Default `4`. */
  count?: number;
};

/** The 2/4-up metric card grid used on dashboards (e.g. RAG generate stats). */
export function StatCardGridSkeleton({
  caption = true,
  cardClassName,
  className,
  columnsClassName = 'md:grid-cols-2 xl:grid-cols-4',
  count = 4,
}: StatCardGridSkeletonProps) {
  return (
    <section className={cn('grid gap-4', columnsClassName, className)}>
      {Array.from({ length: count }, (_, index) => (
        <article
          className={cn(
            'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm',
            cardClassName,
          )}
          key={index}
        >
          <Skeleton className="h-4 w-24 rounded-md" />
          <Skeleton className="mt-4 h-8 w-20 rounded-md" />
          {caption ? <Skeleton className="mt-4 h-4 w-32 rounded-md" /> : null}
        </article>
      ))}
    </section>
  );
}
