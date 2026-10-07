'use client';

/**
 * B0-690 — dataset picker for the cross-dataset report index (`/admin/tests/reports`).
 *
 * The index is one row per RUN, so a handful of datasets with near-identical names (four VCT
 * sets today) read as though the page contains test sets that are not in "Test sets". The
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

import { FormSelectField } from '~/components/admin/FormSelectField';
import { Label } from '~/components/ui/label';

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
      className={`flex shrink-0 items-center gap-2 transition-opacity ${
        isPending ? 'opacity-60' : ''
      }`}
    >
      <Label
        className="whitespace-nowrap text-sm text-slate-600"
        htmlFor="reports-dataset"
      >
        Dataset
      </Label>
      <FormSelectField
        className="h-8 w-auto max-w-[22rem] bg-slate-50"
        id="reports-dataset"
        onValueChange={selectDataset}
        options={[
          { value: '', label: 'All datasets' },
          ...options.map((option) => ({
            value: option.testId,
            label: `${option.testName} (${option.reportCount})`,
          })),
        ]}
        value={selectedTestId}
      />
    </div>
  );
}
