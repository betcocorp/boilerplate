import { CardGridSkeleton, PageHeaderSkeleton, StatCardGridSkeleton, TableSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

/** Shaped to `page.tsx` + `LabelControls`: header, 3-step pipeline card, documents card. */
export default function AdminLabelsLoading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <PageHeaderSkeleton descriptionLines={3} />

        <PageHeaderSkeleton descriptionLines={1} titleClassName="h-7 w-96">
          <CardGridSkeleton
            actions={1}
            badges={0}
            className="mt-8"
            columnsClassName="md:grid-cols-2 lg:grid-cols-3"
            count={3}
            lines={2}
          />
        </PageHeaderSkeleton>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <Skeleton className="h-4 w-28 rounded-md" />
          <StatCardGridSkeleton
            caption={false}
            className="mt-4"
            columnsClassName="md:grid-cols-3 xl:grid-cols-6"
            count={8}
          />
          <TableSkeleton className="mt-5" columns={7} />
        </section>
      </main>
    </div>
  );
}
