import { PageHeaderSkeleton } from '~/components/admin/skeletons';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <main className="min-w-0 space-y-6 p-4 sm:p-6">
      <section className="rounded-[2rem] border border-border/60 bg-background p-6 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start gap-3">
          <Skeleton className="size-10 shrink-0 rounded-2xl" />
          <PageHeaderSkeleton
            card={false}
            className="min-w-0 flex-1"
            descriptionLines={3}
            titleClassName="h-9 w-40"
          />
        </div>

        <div className="mt-8 space-y-4">
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
      </section>
    </main>
  );
}
