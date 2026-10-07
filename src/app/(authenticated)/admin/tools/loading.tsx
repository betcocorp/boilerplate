import { CardGridSkeleton, PageHeaderSkeleton } from '~/components/admin/skeletons';

export default function Loading() {
  return (
    <main className="min-w-0 p-4 sm:p-6">
      <PageHeaderSkeleton
        className="rounded-[2rem] border-border/60 bg-background p-6 sm:p-8"
        titleClassName="h-9 w-40"
      >
        <CardGridSkeleton
          badges={1}
          cardClassName="h-full rounded-3xl border-border/60 bg-card p-6 shadow-none"
          className="mt-8"
          columnsClassName="md:grid-cols-2 xl:grid-cols-3"
          count={4}
          lines={3}
        />
      </PageHeaderSkeleton>
    </main>
  );
}
