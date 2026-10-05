/**
 * B0-762 — the paginated cross-set item table for `/admin/tests/items`.
 *
 * Server component: rows arrive already filtered and counted by `listTestItemsAcrossTests`, so
 * this only renders them and the prev/next links. Prompts are truncated for display only; the
 * full text is in the `title` and on the linked item page (regulated figures are never reflowed).
 */

import Link from 'next/link';

import { Badge } from '~/components/ui/badge';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import { getAgentBadgeClassName } from '~/lib/bex/agent-badge';
import {
  PROMPT_CATEGORY_BY_SLUG,
  PROMPT_CATEGORY_GROUP_COLORS,
  type PromptCategorySlug,
} from '~/lib/constants/prompt-categories';
import {
  buildTestItemsBrowserHref,
  type TestItemsBrowserFilters,
  type TestItemsBrowserPage,
} from '~/lib/tests/items-browser';

const PROMPT_PREVIEW_CHARS = 110;

const AGENT_LABEL_BY_ID = new Map<string, string>(
  V1_AGENT_REGISTRY.map((agent) => [agent.id, agent.label]),
);

function truncateChars(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function PromptCategoryChip({ slug }: { slug: string | null }) {
  const category = slug ? PROMPT_CATEGORY_BY_SLUG[slug as PromptCategorySlug] : undefined;
  if (!slug) {
    return <span className="text-xs text-slate-400">Uncategorized</span>;
  }
  const dotColor = category ? PROMPT_CATEGORY_GROUP_COLORS[category.group] : 'bg-slate-300';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-700"
      title={category?.description ?? `Unknown category slug "${slug}"`}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${dotColor}`} />
      {category?.label ?? slug}
    </span>
  );
}

export function AllTestItemsTable({
  result,
  filters,
}: {
  result: TestItemsBrowserPage;
  filters: TestItemsBrowserFilters;
}) {
  const { rows, total, page, pageSize } = result;
  const firstIndex = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastIndex = Math.min(page * pageSize, total);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hasPrevious = page > 1;
  const hasNext = page < pageCount;

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-slate-900">Test items</h2>
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-sm font-medium tabular-nums text-slate-500">
            {total.toLocaleString()}
          </span>
        </div>
        <span className="text-xs tabular-nums text-slate-500">
          {total === 0
            ? 'No items'
            : `Showing ${firstIndex.toLocaleString()}–${lastIndex.toLocaleString()} of ${total.toLocaleString()} · Page ${page} of ${pageCount}`}
        </span>
      </div>

      <div className="max-h-[min(72vh,52rem)] overflow-auto overscroll-contain rounded-xl border border-slate-100">
        <table className="w-full caption-bottom text-sm">
          <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226,232,240)] [&_tr]:border-b-0">
            <TableRow>
              <TableHead>Test set</TableHead>
              <TableHead className="text-right">Row</TableHead>
              <TableHead>Prompt</TableHead>
              <TableHead>Golden</TableHead>
              <TableHead>Intended agent</TableHead>
              <TableHead title="Classifier slug on test_items.prompt_category">Prompt category</TableHead>
              <TableHead title="Human category from the CSV (input_payload.question_category)">
                Question category
              </TableHead>
              <TableHead
                className="text-right"
                title="Mandatory (minimum_concepts) / expected (expected_concepts) phrase counts"
              >
                Concepts
              </TableHead>
              <TableHead>Expected tool</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell className="text-slate-500" colSpan={9}>
                  {filters.search
                    ? `No test items match “${filters.search}” with these filters.`
                    : 'No test items match these filters.'}
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((row) => {
              const itemHref = `/admin/tests/${row.testId}/items/${row.id}`;
              const conceptsMissing =
                row.minimumConceptCount === 0 && row.expectedConceptCount === 0;
              return (
                <TableRow className="hover:bg-slate-50/60" key={row.id}>
                  <TableCell className="max-w-[12rem] align-top">
                    <Link
                      className="block truncate font-medium text-sky-700 underline-offset-2 hover:underline"
                      href={`/admin/tests/${row.testId}`}
                      title={row.testName}
                    >
                      {row.testName}
                    </Link>
                    {row.testIsArchived ? (
                      <span className="text-xs text-slate-400">archived</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right align-top tabular-nums text-slate-600">
                    {row.rowIndex}
                  </TableCell>
                  <TableCell className="min-w-[18rem] max-w-md whitespace-normal align-top text-slate-800">
                    <Link
                      className="text-slate-800 underline-offset-2 hover:text-sky-700 hover:underline"
                      href={itemHref}
                      title={row.prompt}
                    >
                      {truncateChars(row.prompt, PROMPT_PREVIEW_CHARS)}
                    </Link>
                  </TableCell>
                  <TableCell className="align-top">
                    {row.testIsGolden ? (
                      <Badge
                        className="border-amber-300 bg-amber-100 text-amber-800"
                        title="This item's set is in the gating golden set"
                        variant="outline"
                      >
                        Golden
                      </Badge>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    {row.intendedAgent ? (
                      <Badge
                        className={getAgentBadgeClassName(row.intendedAgent)}
                        title={row.intendedAgent}
                        variant="outline"
                      >
                        {AGENT_LABEL_BY_ID.get(row.intendedAgent) ?? row.intendedAgent}
                      </Badge>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <PromptCategoryChip slug={row.promptCategory} />
                  </TableCell>
                  <TableCell
                    className="max-w-[12rem] truncate align-top text-sm text-slate-600"
                    title={row.questionCategory ?? undefined}
                  >
                    {row.questionCategory ?? <span className="text-xs text-slate-400">—</span>}
                  </TableCell>
                  <TableCell
                    className={`whitespace-nowrap text-right align-top tabular-nums ${
                      conceptsMissing ? 'font-medium text-rose-700' : 'text-slate-700'
                    }`}
                    title={
                      conceptsMissing
                        ? 'No mandatory or expected concepts — the grader cannot score this item (B0-826)'
                        : `${row.minimumConceptCount} mandatory / ${row.expectedConceptCount} expected`
                    }
                  >
                    {conceptsMissing ? 'none' : `${row.minimumConceptCount} / ${row.expectedConceptCount}`}
                  </TableCell>
                  <TableCell className="align-top">
                    {row.expectedTool ? (
                      <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                        {row.expectedTool}
                      </code>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </table>
      </div>

      {hasPrevious || hasNext ? (
        <nav
          aria-label="Test items pagination"
          className="mt-8 flex flex-wrap items-center justify-center gap-2"
        >
          <Link
            aria-disabled={!hasPrevious}
            className={`rounded-xl px-4 py-2 text-sm font-medium ${
              hasPrevious
                ? 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'
                : 'pointer-events-none bg-slate-100 text-slate-400'
            }`}
            href={buildTestItemsBrowserHref(filters, Math.max(1, page - 1))}
          >
            Previous
          </Link>
          <span className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-medium tabular-nums text-white">
            {page} / {pageCount}
          </span>
          <Link
            aria-disabled={!hasNext}
            className={`rounded-xl px-4 py-2 text-sm font-medium ${
              hasNext
                ? 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'
                : 'pointer-events-none bg-slate-100 text-slate-400'
            }`}
            href={buildTestItemsBrowserHref(filters, page + 1)}
          >
            Next
          </Link>
        </nav>
      ) : null}
    </section>
  );
}
