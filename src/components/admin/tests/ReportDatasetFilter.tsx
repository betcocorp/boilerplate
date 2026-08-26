'use client';

/**
 * B0-690 — dataset picker for the cross-dataset report index (`/admin/tests/reports`).
 *
 * The index is one row per RUN, so a handful of datasets with near-identical names (four VCT
 * sets today) read as though the page contains test sets that are not in "Uploaded tests". The
 * fix is narrowing, not collapsing: the per-run history stays, and this control scopes it to one
 * dataset.
 *
 * The selection lives ENTIRELY in `?testId=` — this component holds no filter state of its own
 * beyond the router transition's pending flag — so the filtered view is shareable by URL and
 * survives a reload. Navigation is `push`, not `replace`, so browser back/forward step through
 * the filters the user actually chose.
 *
 * Options arrive as props from the server, derived from the rows themselves, so this client
 * bundle imports no data-layer module.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/native-select';

export type ReportDatasetOption = {
  testId: string;
  testName: string;
  /** How many report rows this dataset has — what tells the near-identical names apart. */
  reportCount: number;
};

export function ReportDatasetFilter({
  options,
  selectedTestId,
}: {
  /** One entry per dataset that actually has report rows, ordered by name A→Z. */
  options: ReportDatasetOption[];
  /** `''` = all datasets; otherwise the validated `?testId=` in force. */
  selectedTestId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function selectDataset(value: string) {
    // Other params are preserved rather than clobbered — this control owns `testId` only.
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set('testId', value);
    } else {
      // "All datasets" removes the param entirely; a trailing `?testId=` would read as a filter.
      params.delete('testId');
    }
    const query = params.toString();
    startTransition(() => {
      router.push(query ? `${pathname}?${query}` : pathname);
    });
  }

  return (
    <div
      className={`flex items-center gap-2 transition-opacity ${
        isPending ? 'opacity-60' : ''
      }`}
    >
      <Label className="text-sm text-slate-600" htmlFor="reports-dataset">
        Dataset
      </Label>
      <NativeSelect
        className="h-8 w-auto max-w-[22rem] bg-slate-50"
        id="reports-dataset"
        onChange={(event) => selectDataset(event.target.value)}
        value={selectedTestId}
      >
        <option value="">All datasets</option>
        {options.map((option) => (
          <option key={option.testId} value={option.testId}>
            {option.testName} ({option.reportCount})
          </option>
        ))}
      </NativeSelect>
      {selectedTestId ? (
        <button
          className="text-sm text-sky-700 underline-offset-2 hover:underline"
          onClick={() => selectDataset('')}
          type="button"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
