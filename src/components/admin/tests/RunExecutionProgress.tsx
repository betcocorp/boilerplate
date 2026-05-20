'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import { formatDate, formatDurationSeconds } from '~/lib/utils/time';

type RunExecutionProgressProps = {
  runId: string;
  initialStatus: string;
  initialCompletedItems: number;
  initialTotalItems: number;
  initialElapsedMs: number;
  stats: {
    passCount: number;
    failCount: number;
    incompleteCount: number;
    started_at: string;
  };
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
  stats,
}: RunExecutionProgressProps) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [completedItems, setCompletedItems] = useState(initialCompletedItems);
  const [totalItems, setTotalItems] = useState(initialTotalItems);
  const [elapsedMs, setElapsedMs] = useState(initialElapsedMs);
  const [progressPercent, setProgressPercent] = useState(
    initialTotalItems > 0
      ? Number(((initialCompletedItems / initialTotalItems) * 100).toFixed(2))
      : 0,
  );
  const [actionPending, setActionPending] = useState<
    null | 'pause' | 'resume' | 'cancel' | 'restart'
  >(null);
  const latestSnapshot = useRef({
    status: initialStatus,
    completedItems: initialCompletedItems,
    totalItems: initialTotalItems,
    elapsedMs: initialElapsedMs,
    progressPercent:
      initialTotalItems > 0
        ? Number(((initialCompletedItems / initialTotalItems) * 100).toFixed(2))
        : 0,
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
    }, 10000);

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

  /** Among items with a definitive pass/fail outcome (excludes incomplete). */
  const runningPassPercentLabel = useMemo(() => {
    const decided = stats.passCount + stats.failCount;
    if (decided <= 0) {
      return null;
    }
    return Number(((stats.passCount / decided) * 100).toFixed(1));
  }, [stats.passCount, stats.failCount]);
  const elapsedLabel = useMemo(
    () => formatDurationSeconds(elapsedMs),
    [elapsedMs],
  );

  /** Mean wall time per completed prompt so far (updates with poll while run is active). */
  const avgPromptLabel = useMemo(() => {
    if (completedItems <= 0) {
      return 'n/a';
    }
    return formatDurationSeconds(elapsedMs / completedItems);
  }, [elapsedMs, completedItems]);
  const canPause = status === 'running' && completedItems > 0;
  const canResume = status === 'paused';
  const canCancel = !isTerminalStatus(status) && status !== 'cancelled';
  const isStalled = status === 'running' && completedItems === 0 && totalItems > 0;

  const handleRunAction = async (action: 'pause' | 'resume' | 'cancel' | 'restart') => {
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
      if (payload.state === 'restarted' || payload.state === 'queued_for_restart') {
        setStatus('running');
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
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Run progress</h2>
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-900">Started:</span>{' '}
          {formatDate(stats.started_at)}
        </p>
      </div>
      <p className="mt-2 text-sm text-slate-600">
        Current prompt: {completedItems} of {totalItems} completed
      </p>
      <div className="mt-4 h-3 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-sky-600 transition-[width] duration-300"
          style={{ width: `${clampedPercent}%` }}
        />
      </div>
      <div className="mt-2 grid grid-cols-4 items-center text-xs text-slate-500">
        <span>Status: {status}</span>
        <span className="text-center leading-snug">
          <span className="block">
            Elapsed / avg: {elapsedLabel} / {avgPromptLabel}
          </span>
        </span>
        <span className="text-center">
          <p>
            <span className="mr-2">Pass/fail/incomplete · Pass %:</span>{' '}
            {stats.passCount}/{stats.failCount}/{stats.incompleteCount}
            {runningPassPercentLabel != null ? (
              <> · {runningPassPercentLabel}%</>
            ) : null}
          </p>
        </span>
        <span className="text-right">{clampedPercent.toFixed(2)}% done</span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {isStalled && (
          <Button
            disabled={actionPending !== null}
            onClick={() => {
              void handleRunAction('restart');
            }}
            size="sm"
            variant="outline"
          >
            Restart stalled run
          </Button>
        )}
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
