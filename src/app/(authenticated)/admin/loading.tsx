import { Card, CardContent, CardHeader } from '~/components/ui/card';
import { Skeleton } from '~/components/ui/skeleton';

/**
 * This boundary also covers every `/admin/*` child route that has no `loading.tsx` of its own,
 * so it stays copy-free and keeps to the neutral header + stat row + panels shape rather than
 * spelling out dashboard-specific labels.
 */
export default function Loading() {
  return (
    <main className="min-w-0 p-4 sm:p-6">
      <div className="rounded-[2rem] border border-border/60 bg-background shadow-sm">
        <div className="flex items-center justify-between gap-4 px-6 py-5 sm:px-8">
          <div>
            <Skeleton className="h-5 w-24 rounded" />
            <Skeleton className="mt-1 h-9 w-52 rounded" />
          </div>
          <div className="flex items-center gap-3">
            <div className="flex -space-x-2">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton
                  className="size-8 rounded-full ring-2 ring-background"
                  key={index}
                />
              ))}
            </div>
            <Skeleton className="h-10 w-36 rounded-2xl" />
          </div>
        </div>

        <div className="h-px w-full shrink-0 bg-border" />

        <div className="space-y-6 px-6 py-6 sm:px-8">
          <section className="grid gap-4 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <Card
                className="gap-4 rounded-3xl border border-border/60 shadow-none"
                key={index}
              >
                <CardHeader className="px-5 pb-0">
                  <Skeleton className="h-5 w-32 rounded" />
                  <Skeleton className="h-9 w-24 rounded" />
                </CardHeader>
                <CardContent className="space-y-1 px-5 pt-0">
                  <Skeleton className="h-5 w-full rounded" />
                  <Skeleton className="h-5 w-2/3 rounded" />
                </CardContent>
              </Card>
            ))}
          </section>

          <section className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
            <Card className="rounded-3xl border border-border/60 shadow-none">
              <CardHeader className="flex flex-row items-start justify-between gap-4 px-5 pb-0">
                <div className="space-y-1.5">
                  <Skeleton className="h-7 w-64 rounded" />
                  <Skeleton className="h-5 w-72 rounded" />
                </div>
                <Skeleton className="h-8 w-32 shrink-0 rounded-2xl" />
              </CardHeader>
              <CardContent className="px-5 pt-0">
                {/* Matches the h-60 ChartContainer the trend chart renders into. */}
                <Skeleton className="h-60 w-full rounded-2xl" />
              </CardContent>
            </Card>

            <Card className="rounded-3xl border border-border/60 shadow-none">
              <CardHeader className="px-5 pb-0">
                <Skeleton className="h-7 w-28 rounded" />
                <Skeleton className="h-5 w-full rounded" />
              </CardHeader>
              <CardContent className="space-y-4 px-5 pt-0">
                <div className="flex w-full justify-start gap-2 rounded-2xl bg-muted/70 p-1">
                  {Array.from({ length: 4 }, (_, index) => (
                    <Skeleton className="h-8 w-24 rounded-2xl" key={index} />
                  ))}
                </div>

                <div className="rounded-3xl bg-muted/60 p-4">
                  <Skeleton className="h-5 w-44 rounded" />
                  <div className="mt-4 grid gap-3">
                    {Array.from({ length: 7 }, (_, index) => (
                      <div
                        className="flex items-center justify-between rounded-2xl bg-background px-4 py-3"
                        key={index}
                      >
                        <Skeleton className="h-5 w-40 rounded" />
                        <Skeleton className="size-4 rounded" />
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>
        </div>
      </div>
    </main>
  );
}
