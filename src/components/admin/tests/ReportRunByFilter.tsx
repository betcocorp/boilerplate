'use client';

/**
 * Run-by picker for the cross-dataset report index (`/admin/tests/reports`), sibling to
 * `ReportDatasetFilter`. Same shape: options derived server-side from the already-fetched rows,
 * selection lives entirely in a URL param (`runBy`) via `router.push`, no client filter state.
 *
 * Runs before B0-687 never recorded who triggered them, so `triggeredBy` is `null` for a real
 * chunk of history — that bucket gets its own explicit option rather than being dropped or
 * lumped in with "All".
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { FormSelectField } from '~/components/admin/FormSelectField';
import { Label } from '~/components/ui/label';

/** Sentinel for "runs with no recorded triggeredBy" — distinct from `''` (All). */
export const UNATTRIBUTED_RUN_BY = '__unattributed__';

export type ReportRunByOption = {
  /** `triggeredBy` value, or `UNATTRIBUTED_RUN_BY` for the null bucket. */
  value: string;
  reportCount: number;
};

export function ReportRunByFilter({
  options,
  selectedRunBy,
}: {
  /** One entry per distinct `triggeredBy` (plus the unattributed bucket, if any), name A→Z. */
  options: ReportRunByOption[];
  /** `''` = all runs; otherwise the validated `?runBy=` in force. */
  selectedRunBy: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function selectRunBy(value: string) {
    // Other params are preserved rather than clobbered — this control owns `runBy` only.
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set('runBy', value);
    } else {
      params.delete('runBy');
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
        htmlFor="reports-run-by"
      >
        Run by
      </Label>
      <FormSelectField
        className="h-8 w-auto max-w-[22rem] bg-slate-50"
        id="reports-run-by"
        onValueChange={selectRunBy}
        options={[
          { value: '', label: 'Anyone' },
          ...options.map((option) => ({
            value: option.value,
            label:
              option.value === UNATTRIBUTED_RUN_BY
                ? `Not recorded (${option.reportCount})`
                : `${option.value} (${option.reportCount})`,
          })),
        ]}
        value={selectedRunBy}
      />
    </div>
  );
}
