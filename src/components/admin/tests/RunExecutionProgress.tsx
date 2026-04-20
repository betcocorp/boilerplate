'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '~/components/ui/button';

type RunExecutionProgressProps = {
  runId: string;
  initialStatus: string;
  initialCompletedItems: number;
  initialTotalItems: number;
  initialElapsedMs: number;
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

function isTerminalStatus(status: string) {
  return (
    status === 'completed' ||
    status === 'completed_with_failures' ||
    status === 'failed' ||
    status === 'cancelled'
  );
}

export function RunExecutionProgress({
  runId,
  initialStatus,
  initialCompletedItems,
  initialTotalItems,
  initialElapsedMs,
}: RunExecutionProgressProps) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [completedItems, setCompletedItems] = useState(initialCompletedItems);
  const [totalItems, setTotalItems] = useState(initialTotalItems);
  const [elapsedMs, setElapsedMs] = useState(initialElapsedMs);
  const [progressPercent, setProgressPercent] = useState(
    initialTotalItems > 0 ? Number(((initialCompletedItems / initialTotalItems) * 100).toFixed(2)) : 0,
  );
  const [actionPending, setActionPending] = useState<null | 'pause' | 'resume' | 'cancel'>(null);
  const latestSnapshot = useRef({
    status: initialStatus,
    completedItems: initialCompletedItems,
    totalItems: initialTotalItems,
    elapsedMs: initialElapsedMs,
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
  const elapsedLabel = useMemo(() => {
    if (elapsedMs >= 3_600_000) {
      return `${(elapsedMs / 3_600_000).toFixed(2)} hr`;
    }
    if (elapsedMs >= 60_000) {
      return `${(elapsedMs / 60_000).toFixed(2)} min`;
    }
    return `${(elapsedMs / 1000).toFixed(2)} s`;
  }, [elapsedMs]);
  const canPause = status === 'running';
  const canResume = status === 'paused';
  const canCancel = !isTerminalStatus(status) && status !== 'cancelled';

  const handleRunAction = async (action: 'pause' | 'resume' | 'cancel') => {
    setActionPending(action);
    try {
      const response = await fetch(`/api/admin/tests/runs/${runId}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as { state?: string };
      if (payload.state === 'paused') {
        setStatus('paused');
      }
      if (payload.state === 'resumed') {
        setStatus('running');
      }
      if (payload.state === 'cancelled') {
        setStatus('cancelled');
      }
      router.refresh();
    } catch {
      // Keep UI responsive even if control action fails once.
    } finally {
      setActionPending(null);
    }
  };

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
      <div className="mt-2 grid grid-cols-3 items-center text-xs text-slate-500">
        <span>Status: {status}</span>
        <span className="text-center">Elapsed: {elapsedLabel}</span>
        <span className="text-right">{clampedPercent.toFixed(2)}%</span>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          disabled={!canPause || actionPending !== null}
          onClick={() => {
            void handleRunAction('pause');
          }}
          size="sm"
          variant="outline"
        >
          Pause run
        </Button>
        <Button
          disabled={!canResume || actionPending !== null}
          onClick={() => {
            void handleRunAction('resume');
          }}
          size="sm"
          variant="outline"
        >
          Resume run
        </Button>
        <Button
          disabled={!canCancel || actionPending !== null}
          onClick={() => {
            void handleRunAction('cancel');
          }}
          size="sm"
          variant="destructive"
        >
          Cancel run
        </Button>
      </div>
    </section>
  );
}
