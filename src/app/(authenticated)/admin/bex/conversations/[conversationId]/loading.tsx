import { PageHeaderSkeleton } from '~/components/admin/skeletons';
import { Skeleton } from '~/components/ui/skeleton';

/** Shaped to `page.tsx` + `ConversationTurnTimeline`: header card, then three turn cards. */
export default function AdminConversationTurnsLoading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <PageHeaderSkeleton descriptionLines={2} />
        {[0, 1, 2].map((index) => (
          <section
            className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"
            key={index}
          >
            <div className="flex items-center gap-3">
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-6 w-24 rounded-md" />
            </div>
            <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <div className="space-y-4">
                <Skeleton className="h-20 w-full rounded-2xl" />
                <Skeleton className="h-32 w-full rounded-2xl" />
              </div>
              <Skeleton className="h-56 w-full rounded-2xl" />
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
