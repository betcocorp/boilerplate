'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * B0-1108 — the run-progress poll that `RunExecutionProgress` (run page) and `SweepRunProgress`
 * (sweep detail cards) share. Polls `GET /api/admin/tests/runs/[runId]` every `intervalMs` until
 * the status is terminal, and never lets progress move backwards between polls (a hop that has
 * not yet flushed its counters must not make the bar jump back).
 */

export type RunProgressSnapshot = {
  status: string;
  completedItems: number;
  totalItems: number;
  elapsedMs: number;
  progressPercent: number;
};

type RunStatusResponse = {
  ok: boolean;
  runId: string;
  status: string;
  completedItems: number;
  totalItems: number;
  progressPercent: number;
  elapsedMs: number;
};

export function isTerminalStatus(status: string) {
  return (
    status === 'completed' ||
    status === 'completed_with_failures' ||
    status === 'failed' ||
    status === 'technical_error' ||
    status === 'cancelled'
  );
}

function percentOf(completedItems: number, totalItems: number) {
  return totalItems > 0
    ? Number(((completedItems / totalItems) * 100).toFixed(2))
    : 0;
}

export type UseRunProgressOptions = {
  /** Called after every successful poll with the merged snapshot. */
  onPoll?: (
    snapshot: RunProgressSnapshot,
    meta: { hasChanged: boolean; isTerminal: boolean },
  ) => void;
  intervalMs?: number;
};

export function useRunProgress(
  runId: string,
  initial: {
    status: string;
    completedItems: number;
    totalItems: number;
    elapsedMs: number;
  },
  options: UseRunProgressOptions = {},
) {
  const { intervalMs = 10000 } = options;
  const [status, setStatus] = useState(initial.status);
  const [completedItems, setCompletedItems] = useState(initial.completedItems);
  const [totalItems, setTotalItems] = useState(initial.totalItems);
  const [elapsedMs, setElapsedMs] = useState(initial.elapsedMs);
  const [progressPercent, setProgressPercent] = useState(
    percentOf(initial.completedItems, initial.totalItems),
  );
  const latestSnapshot = useRef<RunProgressSnapshot>({
    status: initial.status,
    completedItems: initial.completedItems,
    totalItems: initial.totalItems,
    elapsedMs: initial.elapsedMs,
    progressPercent: percentOf(initial.completedItems, initial.totalItems),
  });
  // Held in a ref so a caller's inline callback does not restart the interval on every render.
  const onPollRef = useRef(options.onPoll);
  useEffect(() => {
    onPollRef.current = options.onPoll;
  });

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
        const nextTotalItems = Math.max(
          latestSnapshot.current.totalItems,
          data.totalItems,
        );
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
            : Math.max(
                latestSnapshot.current.progressPercent,
                data.progressPercent,
              );
        const nextElapsedMs = isTerminalStatus(data.status)
          ? data.elapsedMs
          : Math.max(latestSnapshot.current.elapsedMs, data.elapsedMs);
        const hasChanged =
          data.status !== latestSnapshot.current.status ||
          nextCompletedItems !== latestSnapshot.current.completedItems ||
          nextTotalItems !== latestSnapshot.current.totalItems ||
          nextElapsedMs !== latestSnapshot.current.elapsedMs ||
          nextProgressPercent !== latestSnapshot.current.progressPercent;

        setStatus(data.status);
        setCompletedItems(nextCompletedItems);
        setTotalItems(nextTotalItems);
        setElapsedMs(nextElapsedMs);
        setProgressPercent(nextProgressPercent);
        latestSnapshot.current = {
          status: data.status,
          completedItems: nextCompletedItems,
          totalItems: nextTotalItems,
          elapsedMs: nextElapsedMs,
          progressPercent: nextProgressPercent,
        };

        onPollRef.current?.(latestSnapshot.current, {
          hasChanged,
          isTerminal: isTerminalStatus(data.status),
        });
      } catch {
        // Keep polling; transient failures are expected in long runs.
      }
    };

    void poll();
    const intervalId = window.setInterval(() => {
      void poll();
    }, intervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [intervalMs, runId, status]);

  return {
    status,
    completedItems,
    totalItems,
    elapsedMs,
    progressPercent,
    setStatus,
  };
}
