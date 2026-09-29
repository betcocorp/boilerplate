import { CardGridSkeleton, PageHeaderSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        {/* Sweep header: eyebrow, triggered-at title, status/source/mode badges, stat row */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <PageHeaderSkeleton
              card={false}
              descriptionLines={1}
              titleClassName="h-9 w-80"
            />
            <Skeleton className="h-9 w-28 rounded-md" />
          </div>
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index}>
                <Skeleton className="h-3 w-20 rounded-md" />
                <Skeleton className="mt-2 h-8 w-16 rounded-md" />
              </div>
            ))}
          </div>
        </section>

        {/* One card per test set */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <Skeleton className="h-6 w-24 rounded-md" />
            <Skeleton className="h-4 w-20 rounded-md" />
          </div>
          <CardGridSkeleton
            badges={3}
            columnsClassName="sm:grid-cols-2 xl:grid-cols-3"
            count={6}
            lines={2}
            metaFields={4}
          />
        </section>
      </main>
    </div>
  );
}
