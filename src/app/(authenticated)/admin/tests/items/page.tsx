/**
 * B0-762 — browse every test item across every test set.
 *
 * Server component; all filters are searchParams-driven (see `~/lib/tests/items-browser`) so the
 * page is linkable and the filter bar is a plain GET form, as on `/admin/observability`.
 */

import Link from 'next/link';
import { connection } from 'next/server';

import { AllTestItemsFilters } from '~/components/admin/tests/AllTestItemsFilters';
import { AllTestItemsTable } from '~/components/admin/tests/AllTestItemsTable';
import { Button } from '~/components/ui/button';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import {
  listQuestionCategoryOptions,
  listTestFilterOptions,
  listTestItemsAcrossTests,
  readTestItemsBrowserFilters,
  TEST_ITEMS_BROWSER_PAGE_SIZE,
  type TestFilterOption,
  type TestItemsBrowserPage,
} from '~/lib/tests/items-browser';

export const metadata = {
  title: 'All test items | Betco BEX',
  description: 'Browse and filter every test item across all test sets.',
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminAllTestItemsPage({ searchParams }: PageProps) {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_TESTS,
    'GET /admin/tests/items',
  );
  await connection();
  const params = await searchParams;
  const { filters: requested, page } = readTestItemsBrowserFilters(params);

  let loadError: string | null = null;
  let testOptions: TestFilterOption[] = [];
  let questionCategoryOptions: string[] = [];
  let filters = requested;
  let result: TestItemsBrowserPage = {
    rows: [],
    total: 0,
    page,
    pageSize: TEST_ITEMS_BROWSER_PAGE_SIZE,
  };

  try {
    // The set dropdown doubles as the validator for `?test=`: a set outside the current scope
    // (e.g. a non-golden set while golden-only is on) is dropped rather than silently yielding an
    // empty page with a filter the form cannot display.
    [testOptions, questionCategoryOptions] = await Promise.all([
      listTestFilterOptions(requested),
      listQuestionCategoryOptions(requested),
    ]);
    if (requested.testId && !testOptions.some((test) => test.id === requested.testId)) {
      filters = { ...requested, testId: undefined };
    }
    result = await listTestItemsAcrossTests(filters, {
      page,
      pageSize: TEST_ITEMS_BROWSER_PAGE_SIZE,
    });
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : 'Unable to load test items. If this persists, check the Supabase service-role configuration.';
  }

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex-1">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                Quality test runner
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                All test items
              </h1>
              <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
                Every prompt in every test set, in one filterable list. Narrow by set, intended
                agent, category or prompt text, then open the item&apos;s history or jump to its
                set.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button asChild variant="outline">
                <Link href="/admin/tests">Test sets</Link>
              </Button>
            </div>
          </div>
        </section>

        <AllTestItemsFilters
          filters={filters}
          questionCategoryOptions={questionCategoryOptions}
          testOptions={testOptions}
        />

        {loadError ? (
          <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
            {loadError}
          </section>
        ) : null}

        <AllTestItemsTable filters={filters} result={result} />
      </main>
    </div>
  );
}
