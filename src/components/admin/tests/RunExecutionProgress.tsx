'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

type RunExecutionProgressProps = {
  runId: string;
  initialStatus: string;
  initialCompletedItems: number;
  initialTotalItems: number;
};

type RunStatusResponse = {
  ok: boolean;
  runId: string;
  status: string;
  completedItems: number;
  totalItems: number;
  progressPercent: number;
};

function isTerminalStatus(status: string) {
  return status === 'completed' || status === 'completed_with_failures' || status === 'failed';
}

export function RunExecutionProgress({
  runId,
  initialStatus,
  initialCompletedItems,
  initialTotalItems,
}: RunExecutionProgressProps) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [completedItems, setCompletedItems] = useState(initialCompletedItems);
  const [totalItems, setTotalItems] = useState(initialTotalItems);
  const [progressPercent, setProgressPercent] = useState(
    initialTotalItems > 0 ? Number(((initialCompletedItems / initialTotalItems) * 100).toFixed(2)) : 0,
  );
  const latestSnapshot = useRef({
    status: initialStatus,
    completedItems: initialCompletedItems,
    totalItems: initialTotalItems,
    progressPercent:
      initialTotalItems > 0 ? Number(((initialCompletedItems / initialTotalItems) * 100).toFixed(2)) : 0,
  });

  useEffect(() => {
    if (initialStatus !== 'queued') {
      return;
    }

    const startRun = async () => {
      await fetch(`/api/admin/tests/runs/${runId}`, {
        method: 'POST',
      }).catch(() => null);
    };

    void startRun();
  }, [initialStatus, runId]);

  useEffect(() => {
    if (isTerminalStatus(status)) {
      return;
    }

    const poll = async () => {
      try {
        const response = await fetch(`/api/admin/tests/runs/${runId}`, {
          method: 'GET',
          cache: 'no-store',
        });
        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as RunStatusResponse;
        const nextTotalItems = Math.max(latestSnapshot.current.totalItems, data.totalItems);
        const nextCompletedItemsRaw = Math.max(
          latestSnapshot.current.completedItems,
          data.completedItems,
        );
        const nextCompletedItems =
          nextTotalItems > 0
            ? Math.min(nextTotalItems, nextCompletedItemsRaw)
            : nextCompletedItemsRaw;
        const nextProgressPercent =
          nextTotalItems > 0
            ? Number(((nextCompletedItems / nextTotalItems) * 100).toFixed(2))
            : Math.max(latestSnapshot.current.progressPercent, data.progressPercent);
        const hasChanged =
          data.status !== latestSnapshot.current.status ||
          nextCompletedItems !== latestSnapshot.current.completedItems ||
          nextTotalItems !== latestSnapshot.current.totalItems ||
          nextProgressPercent !== latestSnapshot.current.progressPercent;

        setStatus(data.status);
        setCompletedItems(nextCompletedItems);
        setTotalItems(nextTotalItems);
        setProgressPercent(nextProgressPercent);
        latestSnapshot.current = {
          status: data.status,
          completedItems: nextCompletedItems,
          totalItems: nextTotalItems,
          progressPercent: nextProgressPercent,
        };

        if (hasChanged) {
          router.refresh();
        }

        if (isTerminalStatus(data.status)) {
          router.refresh();
        }
      } catch {
        // Keep polling; transient failures are expected in long runs.
      }
    };

    void poll();
    const intervalId = window.setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [runId, router, status]);

  const clampedPercent = useMemo(() => {
    if (Number.isNaN(progressPercent)) {
      return 0;
    }
    return Math.min(100, Math.max(0, progressPercent));
  }, [progressPercent]);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">Run progress</h2>
      <p className="mt-2 text-sm text-slate-600">
        Current prompt: {completedItems} of {totalItems} completed
      </p>
      <div className="mt-4 h-3 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-sky-600 transition-[width] duration-300"
          style={{ width: `${clampedPercent}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <span>Status: {status}</span>
        <span>{clampedPercent.toFixed(2)}%</span>
      </div>
    </section>
  );
}
