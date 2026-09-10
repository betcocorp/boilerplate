'use client';

/**
 * Model picker for the cross-dataset report index (`/admin/tests/reports`), sibling to
 * `ReportDatasetFilter` and `ReportRunByFilter`. Same shape: options derived server-side from the
 * already-fetched rows, selection lives entirely in a URL param (`model`) via `router.push`, no
 * client filter state.
 *
 * Runs that recorded no `run_options.modelTag` get their own explicit "Not recorded" bucket rather
 * than being dropped or lumped in with "All".
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { FormSelectField } from '~/components/admin/FormSelectField';
import { Label } from '~/components/ui/label';

/** Sentinel for "runs with no recorded modelTag" — distinct from `''` (All). */
export const UNRECORDED_MODEL = '__unrecorded__';

export type ReportModelOption = {
  /** `modelTag` value, or `UNRECORDED_MODEL` for the null bucket. */
  value: string;
  reportCount: number;
};

export function ReportModelFilter({
  options,
  selectedModel,
}: {
  /** One entry per distinct `modelTag` (plus the unrecorded bucket, if any), name A→Z. */
  options: ReportModelOption[];
  /** `''` = all models; otherwise the validated `?model=` in force. */
  selectedModel: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function selectModel(value: string) {
    // Other params are preserved rather than clobbered — this control owns `model` only.
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set('model', value);
    } else {
      params.delete('model');
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
        htmlFor="reports-model"
      >
        Model
      </Label>
      <FormSelectField
        className="h-8 w-auto max-w-[22rem] bg-slate-50"
        id="reports-model"
        onValueChange={selectModel}
        options={[
          { value: '', label: 'All models' },
          ...options.map((option) => ({
            value: option.value,
            label:
              option.value === UNRECORDED_MODEL
                ? `Not recorded (${option.reportCount})`
                : `${option.value} (${option.reportCount})`,
          })),
        ]}
        value={selectedModel}
      />
    </div>
  );
}
