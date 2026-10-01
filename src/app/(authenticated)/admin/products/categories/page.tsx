import { connection } from 'next/server';

import { CategoryCurationTable } from '~/components/admin/category/CategoryCurationTable';
import {
  listCategoryLinkRows,
  listTaxonomyOptions,
  listUnlinkedRows,
  parseCurationFilter,
  type CurationListResult,
} from '~/lib/category/curation-repository';

export const metadata = {
  title: 'Category Curation | Betco BEX',
  description: 'Review, approve, edit, and bulk-reassign product→category links.',
};

type PageProps = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

function readParam(value: string | string[] | undefined, fallback = ''): string {
  return Array.isArray(value) ? (value[0] ?? fallback) : (value ?? fallback);
}

export default async function CategoryCurationPage({ searchParams }: PageProps) {
  await connection();

  const resolved = await searchParams;
  const filter = parseCurationFilter(readParam(resolved.filter));
  const requestedPage = Number.parseInt(readParam(resolved.page, '1'), 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  let list: CurationListResult;
  let loadError: string | null = null;
  const options = await listTaxonomyOptions().catch(() => []);
  try {
    list =
      filter === 'unlinked'
        ? await listUnlinkedRows({ page })
        : await listCategoryLinkRows({ filter, page });
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Failed to load links.';
    list = { rows: [], page, pageSize: 25, total: 0 };
  }

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-6 px-6 py-10 sm:px-8">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Product Taxonomy
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Category curation</h1>
          <p className="max-w-3xl text-base leading-7 text-slate-600">
            Review and correct product→category links. Approvals and reassignments are saved as
            <span className="font-medium"> human-curated</span> and are never changed by a delta
            re-sync. Use the queues to work through low-confidence classifier proposals and unlinked
            product lines.
          </p>
        </header>

        {loadError ? (
          <section className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
            {loadError}
          </section>
        ) : null}

        <CategoryCurationTable
          rows={list.rows}
          options={options}
          filter={filter}
          page={list.page}
          pageSize={list.pageSize}
          total={list.total}
        />
      </main>
    </div>
  );
}
