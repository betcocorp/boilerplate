import { Skeleton } from '~/components/ui/skeleton';
import { cn } from '~/lib/utils';

/** Deterministic width cycles — avoid hydration mismatches from random widths. */
const BADGE_WIDTHS = ['w-28', 'w-20', 'w-24'] as const;
const META_TAG_WIDTHS = ['w-32', 'w-36', 'w-40'] as const;
const META_VALUE_WIDTHS = ['w-24', 'w-28', 'w-16', 'w-20'] as const;
const LINE_WIDTHS = ['w-full', 'w-full', 'w-2/3'] as const;
const ACTION_WIDTHS = ['w-40', 'w-36', 'w-32'] as const;

export type CardGridSkeletonProps = {
  /** Number of trailing pill-shaped action bars per card. Default `0`. */
  actions?: number;
  /** Number of pill-shaped badge bars at the top of each card. Default `2`. */
  badges?: number;
  /** Replaces the default card chrome (`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm`). */
  cardClassName?: string;
  /** Merged onto the grid wrapper. */
  className?: string;
  /** Tailwind column classes for the grid. Default `md:grid-cols-2 xl:grid-cols-3`. */
  columnsClassName?: string;
  /** Number of cards. Default `6`. */
  count?: number;
  /** Number of body paragraph lines per card. Default `3`. */
  lines?: number;
  /** Number of label + value pairs rendered in a two-column grid. Default `0`. */
  metaFields?: number;
  /** Number of short inline meta bars rendered under the subtitle. Default `0`. */
  metaTags?: number;
  /** Render a subtitle bar under the title. Default `false`. */
  subtitle?: boolean;
};

/** Generalised product/result card grid (legacy + RAG catalogues). */
export function CardGridSkeleton({
  actions = 0,
  badges = 2,
  cardClassName,
  className,
  columnsClassName = 'md:grid-cols-2 xl:grid-cols-3',
  count = 6,
  lines = 3,
  metaFields = 0,
  metaTags = 0,
  subtitle = false,
}: CardGridSkeletonProps) {
  return (
    <section className={cn('grid gap-4', columnsClassName, className)}>
      {Array.from({ length: count }, (_, cardIndex) => (
        <article
          className={cn(
            'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm',
            cardClassName,
          )}
          key={cardIndex}
        >
          {badges > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {Array.from({ length: badges }, (_, index) => (
                <Skeleton
                  className={cn(
                    'h-6 rounded-full',
                    BADGE_WIDTHS[index % BADGE_WIDTHS.length],
                  )}
                  key={index}
                />
              ))}
            </div>
          ) : null}

          <Skeleton className="mt-4 h-8 w-3/4 rounded-md" />

          {subtitle || metaTags > 0 ? (
            <div className="mt-4 flex flex-col gap-2">
              {subtitle ? <Skeleton className="h-5 w-2/3 rounded-md" /> : null}
              {metaTags > 0 ? (
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {Array.from({ length: metaTags }, (_, index) => (
                    <Skeleton
                      className={cn(
                        'h-4 rounded-md',
                        META_TAG_WIDTHS[index % META_TAG_WIDTHS.length],
                      )}
                      key={index}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {metaFields > 0 ? (
            <div className="mt-4 grid grid-cols-2 gap-3">
              {Array.from({ length: metaFields }, (_, index) => (
                <div className="space-y-2" key={index}>
                  <Skeleton className="h-4 w-20 rounded-md" />
                  <Skeleton
                    className={cn(
                      'h-5 rounded-md',
                      META_VALUE_WIDTHS[index % META_VALUE_WIDTHS.length],
                    )}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {lines > 0 ? (
            <div className="mt-4 space-y-2">
              {Array.from({ length: lines }, (_, index) => (
                <Skeleton
                  className={cn(
                    'h-4 rounded-md',
                    LINE_WIDTHS[index % LINE_WIDTHS.length],
                  )}
                  key={index}
                />
              ))}
            </div>
          ) : null}

          {actions > 0 ? (
            <div className="mt-4 flex flex-wrap gap-3">
              {Array.from({ length: actions }, (_, index) => (
                <Skeleton
                  className={cn(
                    'h-10 rounded-full',
                    ACTION_WIDTHS[index % ACTION_WIDTHS.length],
                  )}
                  key={index}
                />
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </section>
  );
}
