import { TableSkeleton } from '~/components/admin/skeletons';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import { Skeleton } from '~/components/ui/skeleton';
import { CROSS_REFERENCE_MAPPINGS_PAGE_SIZE } from '~/lib/tools/cross-reference-mappings';
import { cn } from '~/lib/utils';

// Colocated (not in ~/components) because these mirror one route's markup only: the
// cross-reference loading.tsx files and the mappings Suspense fallback share them so the
// skeleton and the loaded card keep identical chrome.

/** Card title + description bars matching a shadcn `CardHeader`. */
function CardHeaderSkeleton({
  descriptionLines = 2,
  titleClassName = 'w-40',
}: {
  descriptionLines?: number;
  titleClassName?: string;
}) {
  const widths = ['w-full', 'w-4/5'] as const;

  return (
    <CardHeader>
      <Skeleton className={cn('h-5 rounded-md', titleClassName)} />
      <div className="flex max-w-2xl flex-col gap-2 pt-1">
        {Array.from({ length: descriptionLines }, (_, index) => (
          <Skeleton
            className={cn('h-4 rounded-md', widths[index % widths.length])}
            key={index}
          />
        ))}
      </div>
    </CardHeader>
  );
}

/** Fallback for the "Lookup tester" card (outer card + the tester's own "Run lookup" card). */
export function LookupTesterCardSkeleton() {
  return (
    <Card className="rounded-3xl border border-border/60 shadow-none">
      <CardHeaderSkeleton titleClassName="w-32" />
      <CardContent>
        <Card className="rounded-3xl border border-border/60 shadow-none">
          <CardHeaderSkeleton descriptionLines={1} titleClassName="w-28" />
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {Array.from({ length: 2 }, (_, index) => (
                <div className="space-y-2" key={index}>
                  <Skeleton className="h-4 w-32 rounded-md" />
                  <Skeleton className="h-9 w-full rounded-3xl" />
                </div>
              ))}
            </div>
            <div className="space-y-2 sm:max-w-xs">
              <Skeleton className="h-4 w-24 rounded-md" />
              <Skeleton className="h-9 w-full rounded-3xl" />
            </div>
            <Skeleton className="h-9 w-28 rounded-4xl" />
          </CardContent>
        </Card>
      </CardContent>
    </Card>
  );
}

/**
 * Fallback for `CrossReferenceMappingsTable`. Row count matches the real page size so the
 * table region keeps its height when the data swaps in.
 */
export function MappingsTableCardSkeleton() {
  return (
    <Card className="rounded-3xl border border-border/60 shadow-none">
      <CardHeaderSkeleton titleClassName="w-52" />
      <CardContent className="space-y-4">
        {/* search form */}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Skeleton className="h-9 flex-1 rounded-3xl" />
          <Skeleton className="h-9 w-24 shrink-0 rounded-4xl" />
        </div>

        {/* result count + page indicator */}
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-40 rounded-md" />
          <Skeleton className="h-4 w-28 rounded-md" />
        </div>

        <TableSkeleton
          className="border-border/60 bg-transparent"
          columnWidths={['w-28', 'w-44', 'w-40', 'w-20', 'w-16']}
          columns={5}
          rows={CROSS_REFERENCE_MAPPINGS_PAGE_SIZE}
        />

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Skeleton className="h-8 w-24 rounded-4xl" />
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton className="h-8 w-9 rounded-4xl" key={index} />
          ))}
          <Skeleton className="h-8 w-16 rounded-4xl" />
        </div>
      </CardContent>
    </Card>
  );
}

/** Fallback for the lookup tab as a whole (tester card + mappings card). */
export function CrossReferenceLookupSkeleton() {
  return (
    <div className="space-y-6">
      <LookupTesterCardSkeleton />
      <MappingsTableCardSkeleton />
    </div>
  );
}
