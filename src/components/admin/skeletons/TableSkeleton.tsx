import { Skeleton } from '~/components/ui/skeleton';
import { cn } from '~/lib/utils';

/** Deterministic width cycle — avoids hydration mismatches from random widths. */
const DEFAULT_COLUMN_WIDTHS = [
  'w-28',
  'w-40',
  'w-20',
  'w-32',
  'w-24',
  'w-36',
] as const;

export type TableSkeletonProps = {
  /** Merged onto every body cell bar — raise it (e.g. `h-8`) for tables whose rows hold inputs. */
  cellClassName?: string;
  /** Merged onto the bordered table container. */
  className?: string;
  /** Number of columns per row. */
  columns: number;
  /** Tailwind width classes per column, cycled when shorter than `columns`. */
  columnWidths?: readonly string[];
  /** Render the header row. Default `true`. */
  header?: boolean;
  /** Merged onto the header row wrapper. */
  headerClassName?: string;
  /** Number of body rows. Default `5`. */
  rows?: number;
};

/** Header row + N body rows, for test runner / failure queue / cross-reference tables. */
export function TableSkeleton({
  cellClassName,
  className,
  columns,
  columnWidths = DEFAULT_COLUMN_WIDTHS,
  header = true,
  headerClassName,
  rows = 5,
}: TableSkeletonProps) {
  const widthAt = (index: number) =>
    columnWidths[index % columnWidths.length] ?? 'w-24';

  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl border border-slate-200 bg-white',
        className,
      )}
    >
      {header ? (
        <div
          className={cn(
            'flex items-center gap-4 border-b border-slate-200 px-4 py-3',
            headerClassName,
          )}
        >
          {Array.from({ length: columns }, (_, index) => (
            <div className="min-w-0 flex-1" key={index}>
              <Skeleton className={cn('h-3.5 rounded-md', widthAt(index))} />
            </div>
          ))}
        </div>
      ) : null}

      <div className="divide-y divide-slate-100">
        {Array.from({ length: rows }, (_, rowIndex) => (
          <div className="flex items-center gap-4 px-4 py-3" key={rowIndex}>
            {Array.from({ length: columns }, (_, columnIndex) => (
              <div className="min-w-0 flex-1" key={columnIndex}>
                <Skeleton
                  className={cn(
                    'h-4 rounded-md',
                    widthAt(columnIndex + rowIndex),
                    cellClassName,
                  )}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
