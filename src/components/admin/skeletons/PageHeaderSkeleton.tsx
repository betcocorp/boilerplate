import type { ReactNode } from 'react';

import { Skeleton } from '~/components/ui/skeleton';
import { cn } from '~/lib/utils';

/** Deterministic width cycle — avoids hydration mismatches from random widths. */
const DESCRIPTION_WIDTHS = ['w-full', 'w-5/6', 'w-4/6'] as const;

export type PageHeaderSkeletonProps = {
  /** Render the standard `rounded-3xl border bg-white p-8` section wrapper. Default `true`. */
  card?: boolean;
  /** Extra content rendered inside the header block (e.g. a `FormSkeleton`). */
  children?: ReactNode;
  /** Merged onto the outer wrapper. */
  className?: string;
  /** Number of description lines under the title. `0` renders none. Default `2`. */
  descriptionLines?: number;
  /** Render the small uppercase eyebrow bar above the title. Default `true`. */
  eyebrow?: boolean;
  /** Merged onto the title bar (e.g. `h-9 w-48` to match a smaller heading). */
  titleClassName?: string;
};

/** Eyebrow + title + description block used at the top of admin pages. */
export function PageHeaderSkeleton({
  card = true,
  children,
  className,
  descriptionLines = 2,
  eyebrow = true,
  titleClassName,
}: PageHeaderSkeletonProps) {
  const header = (
    <div className="flex flex-col gap-3">
      {eyebrow ? <Skeleton className="h-4 w-40 rounded-md" /> : null}
      <Skeleton className={cn('h-10 w-2/3 rounded-lg', titleClassName)} />
      {descriptionLines > 0 ? (
        <div className="flex max-w-3xl flex-col gap-2">
          {Array.from({ length: descriptionLines }, (_, index) => (
            <Skeleton
              className={cn(
                'h-5 rounded-md',
                DESCRIPTION_WIDTHS[index % DESCRIPTION_WIDTHS.length],
              )}
              key={index}
            />
          ))}
        </div>
      ) : null}
    </div>
  );

  if (!card) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        {header}
        {children}
      </div>
    );
  }

  return (
    <section
      className={cn(
        'rounded-3xl border border-slate-200 bg-white p-8 shadow-sm',
        className,
      )}
    >
      {header}
      {children}
    </section>
  );
}
