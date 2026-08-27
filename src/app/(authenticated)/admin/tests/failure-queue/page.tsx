import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { connection } from 'next/server';

import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { CollapseExpandAll } from '~/components/admin/CollapseExpandAll';
import { PromptCategorySelect } from '~/components/admin/PromptCategorySelect';
import {
  PROMPT_CATEGORIES_BY_GROUP,
  PROMPT_CATEGORY_BY_SLUG,
  type PromptCategorySlug,
} from '~/lib/constants/prompt-categories';
import { FAILURE_ROOT_CAUSE_PENDING_COPY } from '~/lib/tests/failure-queue';
import {
  listAllLatestFailedItemsForGroupedView,
  listLatestFailedTestResultItemsPage,
  listLatestToolRoutingMismatches,
  type ToolRoutingQueueRow,
} from '~/lib/tests/repository';
import { formatDurationSeconds } from '~/lib/utils/time';
import { readSearchParam } from '~/lib/utils/params';

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

function buildFailureQueueHref(
  query: string,
  page: number,
  view: 'list' | 'grouped' | 'routing' = 'list',
) {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  if (page > 1) params.set('page', String(page));
  if (view !== 'list') params.set('view', view);
  const qs = params.toString();
  return qs ? `${ROUTE}?${qs}` : ROUTE;
}

export default async function AdminFailureQueuePage({ searchParams }: PageProps) {
  await connection();
  const params = await searchParams;
  const query = readSearchParam(params.q);
  const rawView = readSearchParam(params.view, 'list');
  const view: 'list' | 'grouped' | 'routing' =
    rawView === 'grouped' ? 'grouped' : rawView === 'routing' ? 'routing' : 'list';
  const requestedPage = Number.parseInt(readSearchParam(params.page, '1'), 10);
  const currentPage =
    Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  let loadError: string | null = null;

  // ── List view data ────────────────────────────────────────────────────────
  let rows: Awaited<ReturnType<typeof listLatestFailedTestResultItemsPage>>['rows'] = [];
  let total = 0;

  // ── Grouped view data ─────────────────────────────────────────────────────
  type GroupedRow = (typeof rows)[number];
  type CategorySection = {
    slug: string;
    label: string;
    color: string;
    rows: GroupedRow[];
  };
  type GroupSection = {
    group: string;
    label: string;
    color: string;
    total: number;
    categories: CategorySection[];
  };
  let groupedSections: GroupSection[] = [];

  // ── Routing view data (B0-383) ────────────────────────────────────────────
  let routingRows: ToolRoutingQueueRow[] = [];

  try {
    if (view === 'routing') {
      routingRows = await listLatestToolRoutingMismatches();
      total = routingRows.length;
    } else if (view === 'grouped') {
      const all = await listAllLatestFailedItemsForGroupedView(query);
      total = all.length;

      const rowsByCategory = new Map<string, GroupedRow[]>();
      for (const row of all) {
        const cat = row.prompt_category ?? 'recommendation';
        const list = rowsByCategory.get(cat) ?? [];
        list.push(row);
        rowsByCategory.set(cat, list);
      }

      groupedSections = PROMPT_CATEGORIES_BY_GROUP.map(({ group, label, color, items }) => {
        const categories: CategorySection[] = items
          .map((cat) => ({
            slug: cat.slug,
            label: cat.label,
            color,
            rows: rowsByCategory.get(cat.slug) ?? [],
          }))
          .filter((c) => c.rows.length > 0);

        return {
          group,
          label,
          color,
          total: categories.reduce((s, c) => s + c.rows.length, 0),
          categories,
        };
      }).filter((g) => g.total > 0);
    } else {
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
    }
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : 'Unable to load failure queue. If this persists, apply the latest Supabase migration.';
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const paginationStart = Math.max(1, safeCurrentPage - Math.floor(PAGE_LINK_WINDOW / 2));
  const paginationEnd = Math.min(totalPages, paginationStart + PAGE_LINK_WINDOW - 1);
  const adjustedStart = Math.max(1, paginationEnd - PAGE_LINK_WINDOW + 1);
  const paginationPages = Array.from(
    { length: Math.max(0, paginationEnd - adjustedStart + 1) },
    (_, i) => adjustedStart + i,
  );

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">

        {/* Header */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Test runner
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            Failure queue
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
            Each row is the most recent failing result for a prompt. Re-running
            the same test set does not duplicate prompts here; only the latest
            failure is shown.
          </p>
        </section>

        {/* Search */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <form
            action={ROUTE}
            className="flex flex-col gap-4 sm:flex-row sm:items-end"
            method="get"
          >
            {/* preserve view param across search submissions */}
            {view !== 'list' && <input type="hidden" name="view" value={view} />}
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
                  <Link href={view !== 'list' ? `${ROUTE}?view=${view}` : ROUTE}>Clear</Link>
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

        {/* Failures section */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">

          {/* Toolbar */}
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-slate-900">
                {view === 'routing' ? 'Misrouted questions' : 'Failures'}
              </h2>
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-sm font-medium text-slate-500">
                {total}
              </span>
            </div>
            {/* View toggle */}
            <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1 text-sm font-medium">
              <Link
                href={buildFailureQueueHref(query, 1, 'list')}
                className={`rounded-lg px-3 py-1.5 transition-colors ${
                  view === 'list'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                List
              </Link>
              <Link
                href={buildFailureQueueHref(query, 1, 'grouped')}
                className={`rounded-lg px-3 py-1.5 transition-colors ${
                  view === 'grouped'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                By category
              </Link>
              <Link
                href={buildFailureQueueHref(query, 1, 'routing')}
                className={`rounded-lg px-3 py-1.5 transition-colors ${
                  view === 'routing'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
                title="Questions tagged with an expected_tool whose latest run called the wrong tool (B0-383)"
              >
                Tool routing
              </Link>
            </div>
          </div>

          {/* ── Routing view (B0-383) ────────────────────────────────── */}
          {view === 'routing' && !loadError && (
            <>
              <p className="mb-4 max-w-3xl text-sm text-slate-600">
                Latest run of every question tagged with an <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">expected_tool</code>{' '}
                (see the test-set CSV template) whose tool call trace never included the expected
                tool — independent of pass/fail, since a misrouted call can still produce a
                passing answer.
              </p>
              <div className="max-h-[min(72vh,52rem)] overflow-auto overscroll-contain rounded-xl border border-slate-100">
                <table className="w-full caption-bottom text-sm">
                  <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226,232,240)] [&_tr]:border-b-0">
                    <TableRow>
                      <TableHead>Test</TableHead>
                      <TableHead>Prompt</TableHead>
                      <TableHead>Expected tool</TableHead>
                      <TableHead>Offending tool call</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {routingRows.length === 0 ? (
                      <TableRow>
                        <TableCell className="text-slate-500" colSpan={5}>
                          No routing mismatches. Either every tagged question is routing correctly,
                          or no test items have an <code>expected_tool</code> set yet — add one as a
                          CSV column to start scoring routing accuracy.
                        </TableCell>
                      </TableRow>
                    ) : null}
                    {routingRows.map((row) => (
                      <TableRow key={row.resultItemId}>
                        <TableCell className="max-w-[180px] align-top">
                          <Link
                            className="font-medium text-sky-700 underline-offset-2 hover:underline"
                            href={`/admin/tests/${row.testId}`}
                          >
                            <span className="line-clamp-2">{row.testName}</span>
                          </Link>
                        </TableCell>
                        <TableCell className="max-w-md align-top text-sm text-slate-800">
                          <span className="line-clamp-3">{row.prompt}</span>
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge variant="outline">
                            <code>{row.expectedTool}</code>
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-xs align-top">
                          {row.calledTools.length === 0 ? (
                            <Badge variant="destructive">no tool called</Badge>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {row.calledTools.map((toolName, index) => (
                                <Badge key={`${toolName}-${index}`} variant="destructive">
                                  <code>{toolName}</code>
                                </Badge>
                              ))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right align-top">
                          <div className="flex flex-col items-end gap-1 text-sm">
                            <Link
                              className="text-sky-700 underline-offset-2 hover:underline"
                              href={`/admin/tests/${row.testId}/items/${row.testItemId}`}
                            >
                              Item history
                            </Link>
                            <Link
                              className="text-sky-700 underline-offset-2 hover:underline"
                              href={`/admin/tests/${row.testId}/runs/${row.runId}`}
                            >
                              Run
                            </Link>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </table>
              </div>
            </>
          )}

          {/* ── List view ─────────────────────────────────────────────── */}
          {view === 'list' && (
            <>
              <div className="max-h-[min(72vh,52rem)] overflow-auto overscroll-contain rounded-xl border border-slate-100">
                <table className="w-full caption-bottom text-sm">
                  <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226,232,240)] [&_tr]:border-b-0">
                    <TableRow>
                      <TableHead>Test</TableHead>
                      <TableHead>Prompt</TableHead>
                      <TableHead>Latency</TableHead>
                      <TableHead>Root cause</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!loadError && rows.length === 0 ? (
                      <TableRow>
                        <TableCell className="text-slate-500" colSpan={5}>
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
                            <PromptCategorySelect
                              currentCategory={row.prompt_category ?? null}
                              testItemId={row.test_item_id ?? ''}
                            />
                            {row.response_text?.trim() ? (
                              <p className="line-clamp-4 text-xs leading-relaxed text-muted-foreground">
                                {row.response_text}
                              </p>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap align-top text-sm text-slate-600">
                          {formatDurationSeconds(row.elapsed_ms)}
                        </TableCell>
                        <TableCell className="max-w-sm align-top text-sm text-slate-600">
                          {row.root_cause_content ? (
                            <div className="flex flex-col gap-2">
                              {row.root_cause_category ? (
                                <Badge className="w-fit" variant="outline">
                                  {row.root_cause_category}
                                </Badge>
                              ) : null}
                              <div>
                                <p className="text-xs font-semibold text-slate-500">Cause</p>
                                <p className="whitespace-pre-wrap break-words">
                                  {row.root_cause_reason ?? row.root_cause_content}
                                </p>
                              </div>
                              {row.root_cause_suggested_fix ? (
                                <div>
                                  <p className="text-xs font-semibold text-slate-500">Solution</p>
                                  <p className="whitespace-pre-wrap break-words">
                                    {row.root_cause_suggested_fix}
                                  </p>
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <span className="italic text-slate-400">
                              {FAILURE_ROOT_CAUSE_PENDING_COPY}
                            </span>
                          )}
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
                </table>
              </div>

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
                    href={buildFailureQueueHref(query, Math.min(totalPages, safeCurrentPage + 1))}
                  >
                    Next
                  </Link>
                </nav>
              ) : null}
            </>
          )}

          {/* ── Grouped view ──────────────────────────────────────────── */}
          {view === 'grouped' && !loadError && (
            <CollapseExpandAll>
            <div className="space-y-8">
              {groupedSections.length === 0 ? (
                <p className="text-sm text-slate-500">No failed prompts match this search.</p>
              ) : (
                groupedSections.map((g) => (
                  <div key={g.group}>
                    {/* Group header */}
                    <div className="mb-3 flex items-center gap-2">
                      <span className={`size-2 shrink-0 rounded-full ${g.color}`} />
                      <span className="text-sm font-semibold text-slate-700">{g.label}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                        {g.total}
                      </span>
                    </div>

                    {/* Category sections */}
                    <div className="space-y-2 pl-4">
                      {g.categories.map((cat) => (
                        <details key={cat.slug} className="group overflow-hidden rounded-2xl border border-slate-100">
                          <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-slate-50">
                            <ChevronDown className="size-3.5 shrink-0 text-slate-400 transition-transform duration-150 group-open:rotate-180" />
                            <span className={`size-1.5 shrink-0 rounded-full ${cat.color}`} />
                            <span className="flex-1 text-sm font-medium text-slate-800">
                              {cat.label}
                            </span>
                            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-slate-500">
                              {cat.rows.length}
                            </span>
                          </summary>

                          <div className="border-t border-slate-100">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b border-slate-100 bg-slate-50/60 text-xs font-medium text-slate-500">
                                  <th className="px-4 py-2 text-left font-medium">Test</th>
                                  <th className="px-4 py-2 text-left font-medium">Prompt</th>
                                  <th className="px-4 py-2 text-right font-medium">Actions</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-50">
                                {cat.rows.map((row) => {
                                  const catMeta = row.prompt_category
                                    ? PROMPT_CATEGORY_BY_SLUG[row.prompt_category as PromptCategorySlug]
                                    : null;
                                  void catMeta;
                                  return (
                                    <tr key={row.id} className="hover:bg-slate-50/50">
                                      <td className="w-40 px-4 py-3 align-top">
                                        <Link
                                          className="line-clamp-2 text-xs font-medium text-sky-700 underline-offset-2 hover:underline"
                                          href={`/admin/tests/${row.test_id}`}
                                        >
                                          {row.test_name}
                                        </Link>
                                      </td>
                                      <td className="max-w-sm px-4 py-3 align-top">
                                        <div className="flex flex-col gap-1.5">
                                          <span className="line-clamp-2 text-xs text-slate-800">
                                            {row.prompt}
                                          </span>
                                          <PromptCategorySelect
                                            currentCategory={row.prompt_category ?? null}
                                            testItemId={row.test_item_id ?? ''}
                                          />
                                        </div>
                                      </td>
                                      <td className="px-4 py-3 align-top text-right">
                                        <div className="flex flex-col items-end gap-1">
                                          <Link
                                            className="text-xs text-sky-700 underline-offset-2 hover:underline"
                                            href={`/admin/tests/${row.test_id}/items/${row.test_item_id}`}
                                          >
                                            Item history
                                          </Link>
                                          <Link
                                            className="text-xs text-sky-700 underline-offset-2 hover:underline"
                                            href={`/admin/tests/${row.test_id}/runs/${row.test_result_id}`}
                                          >
                                            Run
                                          </Link>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
            </CollapseExpandAll>
          )}
        </section>
      </main>
    </div>
  );
}
