import { Skeleton } from '~/components/ui/skeleton';

function FactGridSkeleton({ cells }: { cells: number }) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {Array.from({ length: cells }, (_, index) => (
        <div className="rounded-2xl bg-muted px-4 py-3" key={index}>
          <Skeleton className="h-4 w-20 rounded-md" />
          <Skeleton className="mt-1 h-5 w-24 rounded-md" />
        </div>
      ))}
    </div>
  );
}

export default function Loading() {
  return (
    <div className="flex flex-1 bg-background">
      <main className="flex w-full flex-1 flex-col gap-6 px-6 py-10 sm:px-8">
        <Skeleton className="h-9 w-44 rounded-full" />

        {/* Document context */}
        <section className="rounded-3xl border border-border bg-card p-8 shadow-sm">
          <Skeleton className="h-4 w-24 rounded-md" />
          <Skeleton className="mt-2 h-7 w-80 rounded-md" />
          <Skeleton className="mt-2 h-4 w-64 rounded-md" />
          <FactGridSkeleton cells={2} />
        </section>

        {/* Chunk header */}
        <section className="rounded-3xl border border-border bg-card p-8 shadow-sm">
          <Skeleton className="h-4 w-20 rounded-md" />
          <Skeleton className="mt-2 h-9 w-96 rounded-md" />
          <Skeleton className="mt-2 h-4 w-72 rounded-md" />
          <FactGridSkeleton cells={4} />
          <div className="mt-6 space-y-3 border-t border-border pt-3">
            {Array.from({ length: 4 }, (_, index) => (
              <div className="flex gap-4" key={index}>
                <Skeleton className="h-4 w-44 shrink-0 rounded-md" />
                <Skeleton className="h-4 w-full rounded-md" />
              </div>
            ))}
          </div>
        </section>

        {/* Chunk text */}
        <section className="rounded-3xl border border-border bg-card p-8 shadow-sm">
          <Skeleton className="h-5 w-32 rounded-md" />
          <Skeleton className="mt-1 h-4 w-72 rounded-md" />
          <Skeleton className="mt-6 h-64 w-full rounded-2xl" />
        </section>

        {/* Chunk metadata */}
        <section className="rounded-3xl border border-border bg-card p-8 shadow-sm">
          <Skeleton className="h-5 w-40 rounded-md" />
          <Skeleton className="mt-6 h-32 w-full rounded-2xl" />
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-9 w-48 rounded-full" />
          <Skeleton className="h-9 w-48 rounded-full" />
        </div>
      </main>
    </div>
  );
}
