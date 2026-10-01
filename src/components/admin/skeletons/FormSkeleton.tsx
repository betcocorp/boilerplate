import { Skeleton } from '~/components/ui/skeleton';
import { cn } from '~/lib/utils';

export type FormSkeletonProps = {
  /** Merged onto the wrapper. */
  className?: string;
  /** Tailwind column classes. When set the fields lay out as a grid instead of a stack. */
  columnsClassName?: string;
  /** Merged onto every input bar (e.g. `h-10` for compact forms). */
  fieldClassName?: string;
  /** Number of label + input clusters. Default `3`. */
  fields?: number;
  /** Render a label bar above each input. Default `true`. */
  labels?: boolean;
  /** Render a trailing submit-button block. Default `true`. */
  submitButton?: boolean;
  /** Merged onto the submit-button bar. */
  submitButtonClassName?: string;
};

/** Label + input + button clusters for testers and search forms. */
export function FormSkeleton({
  className,
  columnsClassName,
  fieldClassName,
  fields = 3,
  labels = true,
  submitButton = true,
  submitButtonClassName,
}: FormSkeletonProps) {
  return (
    <div
      className={cn(
        columnsClassName ? cn('grid gap-3', columnsClassName) : 'flex flex-col gap-4',
        className,
      )}
    >
      {Array.from({ length: fields }, (_, index) => (
        <div className="flex flex-col gap-2" key={index}>
          {labels ? <Skeleton className="h-4 w-24 rounded-md" /> : null}
          <Skeleton className={cn('h-12 w-full rounded-2xl', fieldClassName)} />
        </div>
      ))}

      {submitButton ? (
        <Skeleton
          className={cn('mt-auto h-12 w-40 rounded-2xl', submitButtonClassName)}
        />
      ) : null}
    </div>
  );
}
