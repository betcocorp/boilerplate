import { Skeleton } from '~/components/ui/skeleton';

/** B0-577 — mirrors the health page's header + five panel slots while data loads. */
export default function BexHealthLoading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <Skeleton className="h-5 w-32 rounded" />
          <Skeleton className="mt-2 h-9 w-48 rounded" />
          <Skeleton className="mt-4 h-6 w-96 max-w-full rounded" />
        </section>
        {Array.from({ length: 5 }, (_, index) => (
          <section
            className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"
            key={index}
          >
            <Skeleton className="h-6 w-40 rounded" />
            <Skeleton className="mt-4 h-40 w-full rounded-2xl" />
          </section>
        ))}
      </main>
    </div>
  );
}
