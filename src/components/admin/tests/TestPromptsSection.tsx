'use client';

import { useMemo, useState } from 'react';

import { DeleteTestPromptDialog } from '~/components/admin/tests/DeleteTestPromptDialog';
import { Input } from '~/components/ui/input';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';

export type TestPromptRow = {
  id: string;
  row_index: number;
  prompt: string;
  expected_should_answer: boolean | null;
  expected_result_type: string | null;
};

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
};

export function TestPromptsSection({
  items,
  returnPath,
  testId,
}: TestPromptsSectionProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(
    () => items.filter((item) => rowMatchesQuery(item, query)),
    [items, query],
  );

  const total = items.length;
  const showing = filtered.length;

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
        </div>
        <div className="grid w-full gap-2 lg:max-w-md lg:flex-[0_1_24rem]">
          <Input
            autoComplete="off"
            className="rounded-2xl"
            id="test-prompts-filter"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by prompt text, row number, or expected…"
            type="search"
            value={query}
          />
        </div>
      </div>

      <div className="relative mt-4 max-h-[min(48vh,32rem)] overflow-auto overscroll-contain rounded-2xl border border-slate-200">
        <table className="w-full min-w-[56rem] caption-bottom text-sm">
          <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226_232_240)] [&_tr]:border-b-0">
            <TableRow>
              <TableHead>Row</TableHead>
              <TableHead>Prompt</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead className="w-[1%] whitespace-nowrap">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell className="text-slate-500" colSpan={4}>
                  {total === 0
                    ? 'No prompts in this dataset yet.'
                    : 'No prompts match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.row_index}</TableCell>
                  <TableCell className="max-w-[480px] whitespace-normal">
                    {item.prompt}
                  </TableCell>
                  <TableCell>{expectedSummary(item)}</TableCell>
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
              ))
            )}
          </TableBody>
        </table>
      </div>
    </>
  );
}
