import { CardGridSkeleton } from '~/components/admin/skeletons';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';

export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
              Supabase Product Search
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-slate-950">
              Search products from your generated schema
            </h1>
            <p className="max-w-3xl text-base leading-7 text-slate-600">
              This view is typed from `src/types/supabase.ts` and searches the
              `products` table, then enriches results with matching
              `products_descr` records.
            </p>
          </div>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Input
              className="h-12 flex-1 rounded-2xl px-4"
              disabled
              placeholder="Search by title, SKU, product ID, or description"
              type="search"
            />
            <Button
              className="h-12 w-40 shrink-0 rounded-2xl px-6 font-semibold opacity-80"
              disabled
              type="button"
            >
              Search products
            </Button>
          </div>
        </section>

        <section className="flex items-center justify-between">
          <div className="text-sm text-slate-600">Loading products...</div>
          <div className="text-sm text-slate-600">Page ...</div>
        </section>

        <CardGridSkeleton
          badges={2}
          columnsClassName="md:grid-cols-2 xl:grid-cols-3"
          count={6}
          lines={3}
          metaFields={4}
        />
      </main>
    </div>
  );
}
