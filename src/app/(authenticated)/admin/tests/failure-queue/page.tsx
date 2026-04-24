import Link from 'next/link';
import { connection } from 'next/server';

import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { listLatestFailedTestResultItemsPage } from '~/lib/tests/repository';
import { formatDate, formatDurationSeconds } from '~/lib/utils/time';

export const metadata = {
  title: 'Failure Queue | Betco BEX',
  description: 'Latest failed prompts across test runs, deduped per prompt.',
};

const ROUTE = '/admin/tests/failure-queue';
const PAGE_SIZE = 25;
const PAGE_LINK_WINDOW = 5;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function readSearchParam(value: string | string[] | undefined, fallback = '') {
  if (Array.isArray(value)) {
    return value[0] ?? fallback;
  }
  return value ?? fallback;
}

function buildFailureQueueHref(query: string, page: number) {
  const params = new URLSearchParams();
  if (query.trim()) {
    params.set('q', query.trim());
  }
  if (page > 1) {
    params.set('page', String(page));
  }
  const qs = params.toString();
  return qs ? `${ROUTE}?${qs}` : ROUTE;
}

export default async function AdminFailureQueuePage({ searchParams }: PageProps) {
  await connection();
  const params = await searchParams;
  const query = readSearchParam(params.q);
  const requestedPage = Number.parseInt(readSearchParam(params.page, '1'), 10);
  const currentPage =
    Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  let loadError: string | null = null;
  let rows: Awaited<ReturnType<typeof listLatestFailedTestResultItemsPage>>['rows'] = [];
  let total = 0;

  try {
    const provisional = await listLatestFailedTestResultItemsPage({
      search: query,
      page: currentPage,
      pageSize: PAGE_SIZE,
    });
    total = provisional.total;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(currentPage, totalPages);
    rows =
      safePage === currentPage
        ? provisional.rows
        : (
            await listLatestFailedTestResultItemsPage({
              search: query,
              page: safePage,
              pageSize: PAGE_SIZE,
            })
          ).rows;
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : 'Unable to load failure queue. If this persists, apply the latest Supabase migration for the failure queue view and RPCs.';
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const paginationStart = Math.max(1, safeCurrentPage - Math.floor(PAGE_LINK_WINDOW / 2));
  const paginationEnd = Math.min(totalPages, paginationStart + PAGE_LINK_WINDOW - 1);
  const adjustedStart = Math.max(1, paginationEnd - PAGE_LINK_WINDOW + 1);
  const paginationPages = Array.from(
    { length: Math.max(0, paginationEnd - adjustedStart + 1) },
    (_, index) => adjustedStart + index,
  );

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Test runner
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            Failure queue
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
            Each row is the most recent failing result for a prompt. Re-running the same test set
            does not duplicate prompts here; only the latest failure is shown.
          </p>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <form action={ROUTE} className="flex flex-col gap-4 sm:flex-row sm:items-end" method="get">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Label className="text-sm text-slate-700" htmlFor="failure-queue-search">
                Search
              </Label>
              <Input
                className="max-w-xl"
                defaultValue={query}
                id="failure-queue-search"
                name="q"
                placeholder="Prompt, error, response snippet, or test name"
                type="search"
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit">Search</Button>
              {query ? (
                <Button asChild type="button" variant="outline">
                  <Link href={ROUTE}>Clear</Link>
                </Button>
              ) : null}
            </div>
          </form>
        </section>

        {loadError ? (
          <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
            {loadError}
          </section>
        ) : null}

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-slate-900">Failures</h2>
            <span className="text-sm text-slate-600">
              {total} {total === 1 ? 'prompt' : 'prompts'}
            </span>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Test</TableHead>
                <TableHead>Prompt</TableHead>
                <TableHead>Failed at</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead>Error</TableHead>
                <TableHead className="text-right">Links</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!loadError && rows.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={6}>
                    No failed prompts match this search.
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="max-w-[180px] align-top">
                    <Link
                      className="font-medium text-sky-700 underline-offset-2 hover:underline"
                      href={`/admin/tests/${row.test_id}`}
                    >
                      <span className="line-clamp-2">{row.test_name}</span>
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-md align-top text-sm text-slate-800">
                    <div className="flex flex-col gap-1.5">
                      <span className="line-clamp-3">{row.prompt}</span>
                      {row.response_text?.trim() ? (
                        <p className="line-clamp-4 text-xs leading-relaxed text-muted-foreground">
                          {row.response_text}
                        </p>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap align-top text-sm text-slate-600">
                    {formatDate(row.created_at)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap align-top text-sm text-slate-600">
                    {formatDurationSeconds(row.elapsed_ms)}
                  </TableCell>
                  <TableCell className="max-w-xs align-top text-sm text-slate-600">
                    <span className="line-clamp-3">{row.error_message || '—'}</span>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <div className="flex flex-col items-end gap-1 text-sm">
                      <Link
                        className="text-sky-700 underline-offset-2 hover:underline"
                        href={`/admin/tests/${row.test_id}/items/${row.test_item_id}`}
                      >
                        Item history
                      </Link>
                      <Link
                        className="text-sky-700 underline-offset-2 hover:underline"
                        href={`/admin/tests/${row.test_id}/runs/${row.test_result_id}`}
                      >
                        Run
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {!loadError && totalPages > 1 ? (
            <nav
              aria-label="Failure queue pagination"
              className="mt-8 flex flex-wrap items-center justify-center gap-2"
            >
              <Link
                className={`rounded-xl px-4 py-2 text-sm font-medium ${
                  safeCurrentPage === 1
                    ? 'pointer-events-none bg-slate-100 text-slate-400'
                    : 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'
                }`}
                href={buildFailureQueueHref(query, Math.max(1, safeCurrentPage - 1))}
              >
                Previous
              </Link>

              {paginationPages.map((pageNumber) => (
                <Link
                  key={pageNumber}
                  className={`rounded-xl px-4 py-2 text-sm font-medium ${
                    pageNumber === safeCurrentPage
                      ? 'bg-slate-950 text-white'
                      : 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'
                  }`}
                  href={buildFailureQueueHref(query, pageNumber)}
                >
                  {pageNumber}
                </Link>
              ))}

              <Link
                className={`rounded-xl px-4 py-2 text-sm font-medium ${
                  safeCurrentPage === totalPages
                    ? 'pointer-events-none bg-slate-100 text-slate-400'
                    : 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'
                }`}
                href={buildFailureQueueHref(
                  query,
                  Math.min(totalPages, safeCurrentPage + 1),
                )}
              >
                Next
              </Link>
            </nav>
          ) : null}
        </section>
      </main>
    </div>
  );
}
