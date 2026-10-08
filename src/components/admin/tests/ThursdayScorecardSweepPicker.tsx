'use client';

/**
 * B0-1164 — which Thursday-night sweep the scorecard shows. Same shape as `ReportModelFilter`:
 * options come from the server (the loader's `sweeps`, newest first), the selection lives entirely
 * in the `?scorecardSweep=` URL param via `router.push`, and other params are preserved.
 * Selecting the newest sweep clears the param, since that is the page's default.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { FormSelectField } from '~/components/admin/FormSelectField';
import { Label } from '~/components/ui/label';
import {
  SCORECARD_SWEEP_PARAM,
  type ThursdayScorecardList,
  type ThursdayScorecardSweepOption,
} from '~/lib/tests/thursday-scorecard-schemas';
import { formatEasternSweepLabel } from '~/lib/utils/time';

const SWEEP_STATUS_WORDS: Record<ThursdayScorecardSweepOption['status'], string> = {
  completed: 'Completed',
  failed: 'Failed',
  in_progress: 'In progress',
  queued: 'Queued',
};

export function ThursdayScorecardSweepPicker({
  sweeps,
  selectedSweepId,
}: {
  /** Newest first. */
  sweeps: ThursdayScorecardList;
  /** The sweep the page rendered — always one of `sweeps`. */
  selectedSweepId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function selectSweep(sweepId: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (sweepId && sweepId !== sweeps[0]?.sweepId) {
      params.set(SCORECARD_SWEEP_PARAM, sweepId);
    } else {
      params.delete(SCORECARD_SWEEP_PARAM);
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
        htmlFor="thursday-scorecard-sweep"
      >
        Sweep
      </Label>
      <FormSelectField
        className="h-8 w-auto max-w-[22rem] bg-slate-50"
        id="thursday-scorecard-sweep"
        onValueChange={selectSweep}
        options={sweeps.map((sweep) => ({
          value: sweep.sweepId,
          label: `${formatEasternSweepLabel(sweep.sweepTriggeredAt)} · ${SWEEP_STATUS_WORDS[sweep.status]}`,
        }))}
        value={selectedSweepId}
      />
    </div>
  );
}
