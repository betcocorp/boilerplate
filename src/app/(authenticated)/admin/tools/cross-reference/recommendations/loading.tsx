import { Card, CardContent, CardHeader } from '~/components/ui/card';
import { Skeleton } from '~/components/ui/skeleton';

// The header + tabs live in the segment layout, so this fallback only covers the tab body:
// intro copy, the metrics card, the filter bar, and the collapsed recommendation rows.
export default function Loading() {
  return (
    <div className="space-y-4">
      <div className="flex max-w-3xl flex-col gap-2">
        <Skeleton className="h-4 w-full rounded-md" />
        <Skeleton className="h-4 w-full rounded-md" />
        <Skeleton className="h-4 w-3/5 rounded-md" />
      </div>

      <div className="space-y-6">
        <Card className="rounded-3xl border border-border/60 shadow-none">
          <CardHeader>
            <Skeleton className="h-5 w-44 rounded-md" />
            <Skeleton className="h-4 w-80 max-w-full rounded-md" />
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              {Array.from({ length: 6 }, (_, index) => (
                <div
                  className="rounded-2xl border border-border/60 bg-muted/30 p-3"
                  key={index}
                >
                  <Skeleton className="h-3 w-20 rounded-md" />
                  <Skeleton className="mt-2 h-6 w-16 rounded-md" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-3xl border border-border/60 shadow-none">
          <CardContent className="pt-6">
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-2">
                <Skeleton className="h-4 w-16 rounded-md" />
                <Skeleton className="h-9 w-40 rounded-3xl" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-4 w-28 rounded-md" />
                <Skeleton className="h-9 w-32 rounded-3xl" />
              </div>
              <Skeleton className="h-9 w-20 rounded-4xl" />
              <div className="ml-auto flex flex-wrap gap-2">
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton className="h-6 w-24 rounded-4xl" key={index} />
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-3xl border border-border/60 shadow-none">
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="space-y-2">
              <Skeleton className="h-5 w-40 rounded-md" />
              <Skeleton className="h-4 w-52 rounded-md" />
            </div>
            <Skeleton className="h-4 w-24 rounded-md" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div className="rounded-2xl border border-border/60 px-4 py-3" key={index}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Skeleton className="h-5 w-64 max-w-full rounded-md" />
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-5 w-20 rounded-4xl" />
                    <Skeleton className="h-5 w-16 rounded-4xl" />
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
