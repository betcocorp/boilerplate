/**
 * B0-762 — filter bar for `/admin/tests/items`.
 *
 * Server component on purpose: a plain GET form against the route (same approach as
 * `/admin/observability`), so every filter lives in the URL, is linkable, and survives a reload
 * with no client state. `FormSelectField` is the one client leaf, used for its real-`''` "All"
 * semantics.
 */

import Link from 'next/link';

import { FormSelectField } from '~/components/admin/FormSelectField';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import {
  PROMPT_CATEGORIES_BY_GROUP,
} from '~/lib/constants/prompt-categories';
import {
  TEST_ITEMS_BROWSER_ROUTE,
  type TestFilterOption,
  type TestItemsBrowserFilters,
} from '~/lib/tests/items-browser';

type AllTestItemsFiltersProps = {
  filters: TestItemsBrowserFilters;
  testOptions: TestFilterOption[];
  /** Distinct `question_category` values within the current golden/all scope. */
  questionCategoryOptions: string[];
};

export function AllTestItemsFilters({
  filters,
  testOptions,
  questionCategoryOptions,
}: AllTestItemsFiltersProps) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">Filters</h2>
      <form
        action={TEST_ITEMS_BROWSER_ROUTE}
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
        method="get"
      >
        <div className="flex min-w-0 flex-col gap-2 sm:col-span-2 lg:col-span-4">
          <Label className="text-sm text-slate-700" htmlFor="items-search">
            Prompt contains
          </Label>
          <Input
            defaultValue={filters.search ?? ''}
            id="items-search"
            name="q"
            placeholder="Words from the prompt"
            type="search"
          />
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <Label className="text-sm text-slate-700" htmlFor="items-golden">
            Scope
          </Label>
          <FormSelectField
            defaultValue={filters.goldenOnly ? '' : 'false'}
            id="items-golden"
            name="golden"
            options={[
              { value: '', label: 'Golden sets only' },
              { value: 'false', label: 'All test sets (incl. archived)' },
            ]}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <Label className="text-sm text-slate-700" htmlFor="items-test">
            Test set
          </Label>
          <FormSelectField
            defaultValue={filters.testId ?? ''}
            id="items-test"
            name="test"
            options={[
              { value: '', label: 'All sets' },
              ...testOptions.map((test) => ({
                value: test.id,
                label: test.isArchived ? `${test.name} (archived)` : test.name,
              })),
            ]}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <Label className="text-sm text-slate-700" htmlFor="items-agent">
            Intended agent
          </Label>
          <FormSelectField
            defaultValue={filters.intendedAgent ?? ''}
            id="items-agent"
            name="agent"
            options={[
              { value: '', label: 'All agents' },
              ...V1_AGENT_REGISTRY.map((agent) => ({
                value: agent.id,
                label: agent.label,
              })),
            ]}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <Label className="text-sm text-slate-700" htmlFor="items-category">
            Prompt category
          </Label>
          <FormSelectField
            defaultValue={filters.promptCategory ?? ''}
            id="items-category"
            name="category"
            options={[
              { value: '', label: 'All categories' },
              ...PROMPT_CATEGORIES_BY_GROUP.flatMap((group) =>
                group.items.map((category) => ({
                  value: category.slug,
                  label: `${group.label} · ${category.label}`,
                })),
              ),
            ]}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <Label className="text-sm text-slate-700" htmlFor="items-qcat">
            Question category
          </Label>
          <FormSelectField
            defaultValue={filters.questionCategory ?? ''}
            id="items-qcat"
            name="qcat"
            options={[
              { value: '', label: 'All question categories' },
              ...questionCategoryOptions.map((value) => ({ value, label: value })),
            ]}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <Label className="text-sm text-slate-700" htmlFor="items-concepts">
            Concepts
          </Label>
          <FormSelectField
            defaultValue={filters.concepts === 'all' ? '' : filters.concepts}
            id="items-concepts"
            name="concepts"
            options={[
              { value: '', label: 'All items' },
              { value: 'missing', label: 'Missing concepts (ungradeable)' },
            ]}
          />
        </div>

        <div className="flex items-end gap-2 sm:col-span-2">
          <Button type="submit">Apply filters</Button>
          <Button asChild type="button" variant="outline">
            <Link href={TEST_ITEMS_BROWSER_ROUTE}>Reset</Link>
          </Button>
        </div>
      </form>
      <p className="mt-4 text-xs text-slate-500">
        Defaults to items on non-archived golden sets. &ldquo;Prompt contains&rdquo; is a
        case-insensitive match across every page, not just the rows on screen. &ldquo;Question
        category&rdquo; lists the human categories present in the current scope. &ldquo;Missing
        concepts&rdquo; shows items with neither mandatory nor expected concepts, which the grader
        cannot score (B0-826).
      </p>
    </section>
  );
}
