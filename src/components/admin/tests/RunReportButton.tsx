'use client';

import { FileText, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '~/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip';
import type { ReportStatus } from '~/lib/tests/report/schemas';

/** How often the report status endpoint is polled while generation is still in flight. */
const REPORT_POLL_INTERVAL_MS = 10_000;

const RUN_NOT_FINISHED_TOOLTIP =
  'Reports can only be generated once this run has finished.';

/**
 * The serializable slice of `report_state` the server hands down for the first paint.
 *
 * Deliberately *not* the whole `report_state` blob: that carries every case's full grading
 * narrative and would bloat the RSC payload by megabytes on a large gold set.
 */
export type RunReportProgress = {
  status: ReportStatus;
  completedCases: number;
  totalCases: number;
  completedPasses: number;
  totalPasses: number;
  error?: string | null;
};

/** Shape of `GET /api/admin/tests/runs/[runId]/report` (that route is unchanged). */
type ReportStatusResponse = {
  ok: boolean;
  runId: string;
  status: ReportStatus;
  totalCases: number;
  completedCases: number;
  passes: number;
  completedPasses: number;
  totalPasses: number;
  generatedAt: string | null;
  error: string | null;
};

type RunReportButtonProps = {
  testId: string;
  runId: string;
  /** Reports can only be generated once the run has finished executing. */
  enabled: boolean;
  hasExistingReport: boolean;
  /** Server-rendered report snapshot so the first paint is right before any fetch lands. */
  initialReport?: RunReportProgress | null;
};

export type RunReportButtonView = {
  label: string;
  disabled: boolean;
  /** Report generation failed — render the outline button with destructive colouring. */
  destructive: boolean;
  tooltip: string | null;
};

export function isTerminalReportStatus(status: ReportStatus | undefined) {
  return status === 'completed' || status === 'failed';
}

/**
 * `n/m` progress for the "Generating report…" label.
 *
 * Pass units are preferred: with `REPORT_GRADING_PASSES = 3` the *case* counter sits at 0 for two
 * thirds of the work and reads as frozen. Case counts are the fallback for legacy `report_state`
 * rows persisted before B0-719 added pass tracking. `0/0` is never rendered — no counter at all is
 * more honest than a counter that says nothing.
 */
export function formatReportProgressCounter(
  report: RunReportProgress | null | undefined,
): string | null {
  if (!report) {
    return null;
  }
  if (report.totalPasses > 0) {
    const done = Math.min(
      Math.max(report.completedPasses, 0),
      report.totalPasses,
    );
    return `${done}/${report.totalPasses}`;
  }
  if (report.totalCases > 0) {
    const done = Math.min(
      Math.max(report.completedCases, 0),
      report.totalCases,
    );
    return `${done}/${report.totalCases}`;
  }
  return null;
}

/**
 * The whole label/variant/disabled decision, kept pure so it can be unit tested without mounting
 * the polling effect.
 */
export function resolveRunReportButtonView({
  enabled,
  hasExistingReport,
  report,
}: {
  enabled: boolean;
  hasExistingReport: boolean;
  report: RunReportProgress | null | undefined;
}): RunReportButtonView {
  if (!enabled && !hasExistingReport) {
    return {
      label: 'Generating report…',
      disabled: true,
      destructive: false,
      tooltip: RUN_NOT_FINISHED_TOOLTIP,
    };
  }

  const status: ReportStatus =
    report?.status ?? (hasExistingReport ? 'completed' : 'idle');

  if (hasExistingReport || status === 'completed') {
    return {
      label: 'View report',
      disabled: false,
      destructive: false,
      tooltip: null,
    };
  }

  if (status === 'failed') {
    const error = report?.error?.trim();
    return {
      label: 'Report failed',
      disabled: false,
      destructive: true,
      tooltip: error ? error : null,
    };
  }

  const counter = formatReportProgressCounter(report);
  return {
    label: counter ? `Generating report… ${counter}` : 'Generating report…',
    disabled: false,
    destructive: false,
    tooltip: null,
  };
}

/**
 * Links into `/admin/tests/[testId]/runs/[runId]/report`, which owns triggering generation.
 *
 * B0-608 — report generation is now automatic (kicked off by `executeTestRun` on run completion),
 * so there is no manual "Generate report" affordance any more: once a report exists we link to it
 * as "View report". The `/report` route itself is unchanged — it still safely no-ops/continues if
 * hit while scoring, which is what powers the report page's own auto-continue behavior.
 *
 * B0-611 — while a report is generating (`enabled && !hasExistingReport`), "Generating report…"
 * is now clickable too, linking to that same route so the user can watch the in-progress/loading
 * state `RunReportView` already renders instead of staring at a disabled button. Only the run's
 * not-yet-finished state (`!enabled`) has nowhere to send anyone, so it stays disabled.
 *
 * B0-943 — this is now a client component that polls `GET /api/admin/tests/runs/[runId]/report`.
 * Previously the label was a server-render snapshot: the only thing refreshing the run page is
 * `RunExecutionProgress`, and that stops polling the instant the run hits a terminal status, so the
 * button froze on whatever the report state happened to be at that moment and read "Generating
 * report…" forever — identically whether generation was progressing, stalled or failed. Polling is
 * scoped tightly (run finished, no report yet, report status not terminal) and stops as soon as the
 * report completes or fails; on completion it fires a single `router.refresh()` so the rest of the
 * server-rendered page, which reads `result.report`, catches up too.
 *
 * A failed report (`destructive`) does not link — it POSTs the same regeneration endpoint the
 * report page's own "Retry" button calls, then navigates to `/report` so the (now non-terminal)
 * state can drive itself forward there. Just linking would land on the report page still showing
 * `status: 'failed'`, which its mount effect treats as terminal and does not auto-retry — the user
 * would have had to click "Retry" a second time.
 */
export function RunReportButton({
  testId,
  runId,
  enabled,
  hasExistingReport,
  initialReport = null,
}: RunReportButtonProps) {
  const router = useRouter();
  const [report, setReport] = useState<RunReportProgress | null>(initialReport);
  const [retrying, setRetrying] = useState(false);
  const hasRefreshedRef = useRef(false);

  const reportStatus = report?.status;
  const shouldPoll =
    enabled && !hasExistingReport && !isTerminalReportStatus(reportStatus);

  useEffect(() => {
    if (!shouldPoll) {
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const response = await fetch(
          `/api/admin/tests/runs/${runId}/report`,
          { method: 'GET', cache: 'no-store' },
        );
        if (!response.ok || cancelled) {
          return;
        }

        const data = (await response.json()) as ReportStatusResponse;
        if (cancelled) {
          return;
        }

        setReport({
          status: data.status,
          completedCases: data.completedCases,
          totalCases: data.totalCases,
          completedPasses: data.completedPasses,
          totalPasses: data.totalPasses,
          error: data.error,
        });

        if (data.status === 'completed' && !hasRefreshedRef.current) {
          hasRefreshedRef.current = true;
          router.refresh();
        }
      } catch {
        // Keep polling; transient failures are expected while scoring hammers the DB.
      }
    };

    void poll();
    const intervalId = window.setInterval(() => {
      void poll();
    }, REPORT_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [router, runId, shouldPoll]);

  const retryReport = useCallback(async () => {
    setRetrying(true);
    try {
      await fetch(`/api/admin/tests/runs/${runId}/report`, { method: 'POST' });
    } catch {
      // Navigate regardless — the report page will show whatever state resulted (including the
      // same failure re-surfacing), and it can keep polling/retrying from there.
    } finally {
      router.push(`/admin/tests/${testId}/runs/${runId}/report`);
    }
  }, [router, runId, testId]);

  const view = resolveRunReportButtonView({
    enabled,
    hasExistingReport,
    report,
  });

  const button = view.disabled ? (
    <Button disabled size="sm" variant="outline">
      <FileText className="size-4" />
      {view.label}
    </Button>
  ) : view.destructive ? (
    <Button
      className="border-destructive/40 text-destructive hover:bg-destructive/10"
      disabled={retrying}
      onClick={() => void retryReport()}
      size="sm"
      variant="outline"
    >
      {retrying ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <FileText className="size-4" />
      )}
      {retrying ? 'Retrying…' : view.label}
    </Button>
  ) : (
    <Button asChild size="sm" variant="outline">
      <Link href={`/admin/tests/${testId}/runs/${runId}/report`}>
        <FileText className="size-4" />
        {view.label}
      </Link>
    </Button>
  );

  if (!view.tooltip) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{button}</span>
      </TooltipTrigger>
      <TooltipContent>{view.tooltip}</TooltipContent>
    </Tooltip>
  );
}
