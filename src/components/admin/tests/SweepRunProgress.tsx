'use client';

import { useRouter } from 'next/navigation';

import { getStatusBadgeColor } from '~/components/admin/tests/sweep-status';
import { useRunProgress } from '~/components/admin/tests/useRunProgress';
import { Badge } from '~/components/ui/badge';

type SweepRunProgressProps = {
  runId: string;
  initialStatus: string;
  initialCompletedItems: number;
  initialTotalItems: number;
  initialElapsedMs: number;
};

/**
 * B0-1108 — the live strip on a sweep-detail card: the run's status badge and a `completed/total`
 * bar that polls `GET /api/admin/tests/runs/[runId]` until the run is terminal, then stops. The
 * server-rendered stats beneath it (score, pass/fail) are refreshed once, on the poll that first
 * reports a terminal status, so the card fills in without a manual reload.
 */
export function SweepRunProgress({
  runId,
  initialStatus,
  initialCompletedItems,
  initialTotalItems,
  initialElapsedMs,
}: SweepRunProgressProps) {
  const router = useRouter();
  const { status, completedItems, totalItems, progressPercent } =
    useRunProgress(
      runId,
      {
        status: initialStatus,
        completedItems: initialCompletedItems,
        totalItems: initialTotalItems,
        elapsedMs: initialElapsedMs,
      },
      {
        onPoll: (_snapshot, meta) => {
          if (meta.isTerminal) {
            router.refresh();
          }
        },
      },
    );
  const clampedPercent = Number.isNaN(progressPercent)
    ? 0
    : Math.min(100, Math.max(0, progressPercent));

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <Badge
          className={`border ${getStatusBadgeColor(status)}`}
          title="Live run status (test_results.status)"
        >
          {status}
        </Badge>
        <span className="text-xs tabular-nums text-slate-500">
          {completedItems} of {totalItems} · {clampedPercent.toFixed(0)}%
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-sky-600 transition-[width] duration-300"
          style={{ width: `${clampedPercent}%` }}
        />
      </div>
    </div>
  );
}
