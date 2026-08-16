import { Card, CardContent, CardHeader } from '~/components/ui/card';
import { Skeleton } from '~/components/ui/skeleton';

// The header + tabs live in the segment layout, so this fallback only covers the tab body:
// intro copy and the collapsed alias review rows.
export default function Loading() {
  return (
    <div className="space-y-4">
      <div className="flex max-w-3xl flex-col gap-2">
        <Skeleton className="h-4 w-full rounded-md" />
        <Skeleton className="h-4 w-full rounded-md" />
        <Skeleton className="h-4 w-3/5 rounded-md" />
      </div>

      <Card className="rounded-3xl border border-border/60 shadow-none">
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-5 w-40 rounded-md" />
            <Skeleton className="h-4 w-64 rounded-md" />
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
  );
}
