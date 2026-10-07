import {
  FormSkeleton,
  PageHeaderSkeleton,
  TableSkeleton,
} from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <PageHeaderSkeleton descriptionLines={3} />

        {/* Create or upload test dataset */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <Skeleton className="h-6 w-72 rounded-md" />
          <Skeleton className="mt-2 h-4 w-full max-w-2xl rounded-md" />

          {/* Test name + intended agent sit side by side; the CSV picker spans both. */}
          <FormSkeleton
            className="mt-4"
            columnsClassName="sm:grid-cols-2"
            fields={2}
            submitButton={false}
          />
          <FormSkeleton
            className="mt-4"
            fields={1}
            submitButtonClassName="h-10 w-52"
          />

          <div className="mt-6 border-t border-slate-200 pt-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Skeleton className="h-4 w-80 rounded-md" />
                <Skeleton className="mt-2 h-4 w-full max-w-3xl rounded-md" />
                <Skeleton className="mt-2 h-4 w-2/3 rounded-md" />
              </div>
              <Skeleton className="h-9 w-44 rounded-2xl" />
            </div>
            <Skeleton className="mt-4 h-12 w-full rounded-2xl" />
          </div>
        </section>

        {/* Uploaded tests */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <Skeleton className="h-6 w-40 rounded-md" />
            <Skeleton className="h-4 w-24 rounded-md" />
          </div>
          <TableSkeleton
            className="rounded-none border-0"
            columns={7}
            rows={6}
          />
        </section>
      </main>
    </div>
  );
}
