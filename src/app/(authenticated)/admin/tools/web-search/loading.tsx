import type { ReactNode } from 'react';

import {
  FormSkeleton,
  PageHeaderSkeleton,
  TableSkeleton,
} from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

/** Icon tile + heading block, matching the page's `flex flex-wrap items-start gap-3` header. */
function SectionHeaderSkeleton({
  children,
  titleClassName,
}: {
  children?: ReactNode;
  titleClassName?: string;
}) {
  return (
    <section className="rounded-[2rem] border border-border/60 bg-background p-6 shadow-sm sm:p-8">
      <div className="flex flex-wrap items-start gap-3">
        <Skeleton className="size-10 shrink-0 rounded-2xl" />
        <PageHeaderSkeleton
          card={false}
          className="min-w-0 flex-1"
          descriptionLines={3}
          titleClassName={titleClassName}
        />
      </div>
      {children}
    </section>
  );
}

/** Query + depth + include-domains row shared by both testers. */
function SearchRowSkeleton() {
  return (
    <FormSkeleton
      columnsClassName="sm:grid-cols-[minmax(0,1fr)_9rem_14rem_auto]"
      fieldClassName="h-10 rounded-2xl"
      fields={3}
      submitButtonClassName="mt-auto h-10 w-24 rounded-2xl"
    />
  );
}

export default function Loading() {
  return (
    <main className="min-w-0 space-y-6 p-4 sm:p-6">
      <SectionHeaderSkeleton titleClassName="h-9 w-52">
        <div className="mt-8">
          <SearchRowSkeleton />
        </div>
      </SectionHeaderSkeleton>

      <SectionHeaderSkeleton titleClassName="h-9 w-40">
        <div className="mt-8 space-y-3">
          <FormSkeleton
            fieldClassName="h-10 rounded-2xl"
            fields={1}
            submitButton={false}
          />
          <SearchRowSkeleton />
        </div>
      </SectionHeaderSkeleton>

      <SectionHeaderSkeleton titleClassName="h-8 w-44">
        <TableSkeleton
          className="mt-6 border-border/60 bg-transparent"
          columnWidths={['w-56', 'w-20', 'w-16', 'w-12', 'w-28', 'w-16']}
          columns={6}
          rows={8}
        />
      </SectionHeaderSkeleton>
    </main>
  );
}
