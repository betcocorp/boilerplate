'use client';

import { Download } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';

import { CreateTestFromPromptsDialog } from '~/components/admin/tests/CreateTestFromPromptsDialog';
import { DeleteTestPromptDialog } from '~/components/admin/tests/DeleteTestPromptDialog';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Checkbox } from '~/components/ui/checkbox';
import { Input } from '~/components/ui/input';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { formatDurationSeconds } from '~/lib/utils/time';
import {
  formatElapsed,
  formatPercent,
  formatShouldAnswerExport,
  formatSimilarityPercent,
} from '~/lib/tests/format';
import { escapeCsvCell, sanitizeCsvFilename } from '~/lib/utils/csv';
import type { Json } from '~/types/supabase.public';

export type TestPromptRow = {
  id: string;
  row_index: number;
  prompt: string;
  expected_should_answer: boolean | null;
  expected_result_type: string | null;
  expected_canonical_product: string | null;
  expected_reason_code: string | null;
  input_payload: Json;
};

/** Aggregated history for a single `test_item` across the recent runs surfaced on this page. */
export type TestPromptAggregation = {
  runCount: number;
  passCount: number;
  failCount: number;
  passRatePercent: number | null;
  avgSimilarity: number | null;
  avgElapsedMs: number | null;
  latestRun: {
    runId: string;
    passed: boolean;
  } | null;
};

function payloadString(payload: Json, key: string): string {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return '';
  }
  const raw = (payload as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw : '';
}

function expectedSummary(item: TestPromptRow): string {
  const mode =
    item.expected_should_answer === null
      ? 'n/a'
      : item.expected_should_answer
        ? 'should answer'
        : 'should decline';
  const type = item.expected_result_type
    ? ` (${item.expected_result_type})`
    : '';
  return `${mode}${type}`;
}

function rowMatchesQuery(item: TestPromptRow, raw: string): boolean {
  const q = raw.trim().toLowerCase();
  if (!q) {
    return true;
  }
  if (item.prompt.toLowerCase().includes(q)) {
    return true;
  }
  if (String(item.row_index).includes(q)) {
    return true;
  }
  if (expectedSummary(item).toLowerCase().includes(q)) {
    return true;
  }
  return false;
}

type TestPromptsSectionProps = {
  items: TestPromptRow[];
  returnPath: string;
  testId: string;
  /** Used for the downloaded CSV filename. */
  datasetName: string;
  /** Per-prompt aggregation keyed by `test_item.id`. Items without history are simply absent. */
  aggregationsByItemId: Record<string, TestPromptAggregation>;
  /** Total number of recent runs the aggregations were computed over (drives column tooltips). */
  aggregatedRunCount: number;
};

export function TestPromptsSection({
  items,
  returnPath,
  testId,
  datasetName,
  aggregationsByItemId,
  aggregatedRunCount,
}: TestPromptsSectionProps) {
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const filtered = useMemo(
    () => items.filter((item) => rowMatchesQuery(item, query)),
    [items, query],
  );

  const total = items.length;
  const showing = filtered.length;

  /** Header checkbox state — based on currently visible (filtered) rows. */
  const visibleSelectedCount = useMemo(
    () =>
      filtered.reduce((sum, row) => sum + (selectedIds.has(row.id) ? 1 : 0), 0),
    [filtered, selectedIds],
  );
  const allVisibleSelected =
    filtered.length > 0 && visibleSelectedCount === filtered.length;
  const someVisibleSelected =
    visibleSelectedCount > 0 && visibleSelectedCount < filtered.length;

  const orderedSelectedIds = useMemo(
    () =>
      [...items]
        .sort((a, b) => a.row_index - b.row_index)
        .filter((item) => selectedIds.has(item.id))
        .map((item) => item.id),
    [items, selectedIds],
  );

  const toggleRow = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const toggleAllVisible = useCallback(
    (checked: boolean) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const row of filtered) {
          if (checked) {
            next.add(row.id);
          } else {
            next.delete(row.id);
          }
        }
        return next;
      });
    },
    [filtered],
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const downloadCsv = useCallback(() => {
    if (items.length === 0) {
      return;
    }

    const sorted = [...items].sort((a, b) => a.row_index - b.row_index);
    const headers = [
      'question',
      'should_answer',
      'expected_result_type',
      'canonical_product',
      'reason_code',
      'product_mention',
      'question_category',
      'source_style',
    ];

    const lines = [
      headers.join(','),
      ...sorted.map((item) =>
        [
          item.prompt,
          formatShouldAnswerExport(item.expected_should_answer),
          item.expected_result_type ?? '',
          item.expected_canonical_product ?? '',
          item.expected_reason_code ?? '',
          payloadString(item.input_payload, 'product_mention'),
          payloadString(item.input_payload, 'question_category'),
          payloadString(item.input_payload, 'source_style'),
        ]
          .map(escapeCsvCell)
          .join(','),
      ),
    ];

    const blob = new Blob([`\ufeff${lines.join('\r\n')}`], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${sanitizeCsvFilename(datasetName)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [datasetName, items]);

  return (
    <>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-slate-900">
            Test prompts ({total})
          </h2>
          {query.trim() ? (
            <p className="mt-1 text-sm text-slate-500">
              Showing {showing} of {total} matching &ldquo;{query.trim()}&rdquo;
            </p>
          ) : null}
          {selectedIds.size > 0 ? (
            <p className="mt-1 text-sm text-slate-500">
              {selectedIds.size} selected ·{' '}
              <button
                className="text-sky-700 underline-offset-2 hover:underline"
                onClick={clearSelection}
                type="button"
              >
                Clear selection
              </button>
            </p>
          ) : null}
        </div>
        <div className="flex w-full items-center gap-2 lg:max-w-2xl lg:flex-[0_1_44rem]">
          <Input
            autoComplete="off"
            className="min-w-0 flex-1 rounded-2xl"
            id="test-prompts-filter"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by prompt text, row number, or expected…"
            type="search"
            value={query}
          />
          <CreateTestFromPromptsDialog
            returnPath={returnPath}
            selectedTestItemIds={orderedSelectedIds}
            sourceTestId={testId}
            sourceTestName={datasetName}
          />
          <Button
            aria-label="Download all test prompts as CSV"
            className="size-9 shrink-0 rounded-2xl"
            disabled={total === 0}
            onClick={downloadCsv}
            size="icon"
            type="button"
            variant="outline"
          >
            <Download className="size-4" />
          </Button>
        </div>
      </div>

      {aggregatedRunCount > 0 ? (
        <p className="mt-2 text-xs text-slate-500">
          Historical metrics aggregate up to the last {aggregatedRunCount} run
          {aggregatedRunCount === 1 ? '' : 's'} for this dataset.
        </p>
      ) : null}

      <div className="relative mt-4 max-h-[min(48vh,32rem)] overflow-auto overscroll-contain rounded-2xl border border-slate-200">
        <table className="w-full min-w-6xl caption-bottom text-sm">
          <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226_232_240)] [&_tr]:border-b-0">
            <TableRow>
              <TableHead className="w-[1%] whitespace-nowrap">
                <Checkbox
                  aria-label={
                    allVisibleSelected
                      ? 'Deselect all visible prompts'
                      : 'Select all visible prompts'
                  }
                  checked={
                    allVisibleSelected
                      ? true
                      : someVisibleSelected
                        ? 'indeterminate'
                        : false
                  }
                  disabled={filtered.length === 0}
                  onCheckedChange={(value) => toggleAllVisible(value === true)}
                />
              </TableHead>
              <TableHead>Row</TableHead>
              <TableHead>Prompt</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead title="Number of recent runs that included this prompt (and the passed/failed counts).">
                Pass/Total
              </TableHead>
              <TableHead
                className="whitespace-nowrap"
                title="Share of recent runs in which this prompt passed."
              >
                Pass %
              </TableHead>
              <TableHead
                className="whitespace-nowrap"
                title="Average of the max per-source retrieval similarity across recent runs (same basis as the trend chart)."
              >
                Sim avg
              </TableHead>
              <TableHead
                className="whitespace-nowrap"
                title="Mean wall-clock prompt elapsed time across recent runs."
              >
                Avg elapsed
              </TableHead>
              <TableHead
                className="whitespace-nowrap"
                title="Pass/fail outcome from the most recent run that included this prompt."
              >
                Last run
              </TableHead>
              <TableHead className="w-[1%] whitespace-nowrap">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell className="text-slate-500" colSpan={10}>
                  {total === 0
                    ? 'No prompts in this dataset yet.'
                    : 'No prompts match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((item) => {
                const isSelected = selectedIds.has(item.id);
                const stats = aggregationsByItemId[item.id];
                const hasHistory = !!stats && stats.runCount > 0;
                return (
                  <TableRow
                    key={item.id}
                    data-state={isSelected ? 'selected' : undefined}
                  >
                    <TableCell>
                      <Checkbox
                        aria-label={`Select prompt row ${item.row_index}`}
                        checked={isSelected}
                        onCheckedChange={(value) =>
                          toggleRow(item.id, value === true)
                        }
                      />
                    </TableCell>
                    <TableCell>{item.row_index}</TableCell>
                    <TableCell className="max-w-[420px] whitespace-normal">
                      {item.prompt}
                    </TableCell>
                    <TableCell>{expectedSummary(item)}</TableCell>
                    <TableCell
                      className="whitespace-nowrap tabular-nums text-slate-700"
                      title={
                        hasHistory
                          ? `${stats!.runCount} run${stats!.runCount === 1 ? '' : 's'} aggregated`
                          : 'No historical runs yet for this prompt.'
                      }
                    >
                      {hasHistory ? (
                        <span>
                          {stats!.passCount}/{stats!.runCount}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                      {formatPercent(stats?.passRatePercent ?? null)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                      {formatSimilarityPercent(stats?.avgSimilarity ?? null)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                      {formatElapsed(stats?.avgElapsedMs ?? null)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {stats?.latestRun ? (
                        <Link
                          className="inline-block"
                          href={`/admin/tests/${testId}/runs/${stats.latestRun.runId}#item-level-results`}
                          title={`View run ${stats.latestRun.runId}`}
                        >
                          <Badge
                            className={
                              stats.latestRun.passed
                                ? 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900 hover:bg-emerald-600/20 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-50'
                                : undefined
                            }
                            variant={
                              stats.latestRun.passed ? 'outline' : 'destructive'
                            }
                          >
                            {stats.latestRun.passed ? 'Pass' : 'Fail'}
                          </Badge>
                        </Link>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <DeleteTestPromptDialog
                        promptPreview={item.prompt}
                        returnPath={returnPath}
                        rowIndex={item.row_index}
                        testId={testId}
                        testItemId={item.id}
                      />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </table>
      </div>
    </>
  );
}
