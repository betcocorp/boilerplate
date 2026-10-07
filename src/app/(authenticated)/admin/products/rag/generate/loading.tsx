import {
  FormSkeleton,
  PageHeaderSkeleton,
  StatCardGridSkeleton,
} from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <PageHeaderSkeleton />

        <StatCardGridSkeleton count={4} />

        <section className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
            <Skeleton className="h-8 w-56 rounded-md" />
            <Skeleton className="mt-4 h-4 w-full rounded-md" />
            <Skeleton className="mt-2 h-4 w-5/6 rounded-md" />
            <FormSkeleton
              className="mt-8 gap-4"
              columnsClassName="md:grid-cols-3"
              fields={3}
              labels={false}
              submitButton={false}
            />
            <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton className="h-12 rounded-2xl" key={index} />
              ))}
            </div>
          </section>

          <div className="flex flex-col gap-4">
            {Array.from({ length: 3 }, (_, index) => (
              <section
                className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"
                key={index}
              >
                <Skeleton className="h-8 w-40 rounded-md" />
                <div className="mt-6 flex flex-col gap-3">
                  {Array.from({ length: 3 }, (_, rowIndex) => (
                    <Skeleton className="h-12 rounded-2xl" key={rowIndex} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
