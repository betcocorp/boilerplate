'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  isTerminalStatus,
  useRunProgress,
} from '~/components/admin/tests/useRunProgress';
import { formatDate, formatDurationSeconds } from '~/lib/utils/time';

type RunExecutionProgressProps = {
  runId: string;
  initialStatus: string;
  initialCompletedItems: number;
  initialTotalItems: number;
  initialElapsedMs: number;
  stats: {
    erroredCount: number;
    started_at: string;
  };
};

export function RunExecutionProgress({
  runId,
  initialStatus,
  initialCompletedItems,
  initialTotalItems,
  initialElapsedMs,
  stats,
}: RunExecutionProgressProps) {
  const router = useRouter();
  const {
    status,
    completedItems,
    totalItems,
    elapsedMs,
    progressPercent,
    setStatus,
  } = useRunProgress(
    runId,
    {
      status: initialStatus,
      completedItems: initialCompletedItems,
      totalItems: initialTotalItems,
      elapsedMs: initialElapsedMs,
    },
    {
      onPoll: (_snapshot, meta) => {
        if (meta.hasChanged) {
          router.refresh();
        }
        if (meta.isTerminal) {
          router.refresh();
        }
      },
    },
  );
  const [actionPending, setActionPending] = useState<
    null | 'pause' | 'resume' | 'cancel' | 'restart' | 'retry_failed'
  >(null);
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

  const clampedPercent = useMemo(() => {
    if (Number.isNaN(progressPercent)) {
      return 0;
    }
    return Math.min(100, Math.max(0, progressPercent));
  }, [progressPercent]);

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
  const isActivelyRunning = status === 'running' || status === 'queued';
  const canRetryFailed = !isActivelyRunning && stats.erroredCount > 0;

  const handleRunAction = async (action: 'pause' | 'resume' | 'cancel' | 'restart' | 'retry_failed') => {
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
      if (payload.state === 'retrying_failed' || payload.state === 'queued_for_retry') {
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
      <div className="mt-2 grid grid-cols-3 items-center text-xs text-slate-500">
        <span>Status: {status}</span>
        <span className="text-center leading-snug">
          <span className="block">
            Elapsed / avg: {elapsedLabel} / {avgPromptLabel}
          </span>
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
        {canRetryFailed && (
          <Button
            disabled={actionPending !== null}
            onClick={() => {
              void handleRunAction('retry_failed');
            }}
            size="sm"
            variant="outline"
          >
            {actionPending === 'retry_failed' ? 'Retrying…' : `Retry failed (${stats.erroredCount})`}
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
