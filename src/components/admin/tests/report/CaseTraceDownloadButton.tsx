'use client';

import { Download, Eye, Loader2 } from 'lucide-react';
import { type MouseEvent, useState } from 'react';
import { toast } from 'sonner';

import { cn } from '~/lib/utils';

/**
 * B0-707 — the per-case trace download that sits at the right-hand end of a ledger row.
 *
 * Reuses the observability export route verbatim
 * (`GET /api/admin/observability/runs/[runId]/export`, `bex.observability.run-trace.v1`): the raw
 * `workflow_runs` / `workflow_steps` / `audit_logs` rows plus the assembled timeline for the one
 * workflow run that answered this prompt. Fetched on click, never on render — the report already
 * carries a large RSC payload and most rows are never traced.
 *
 * `~/components/admin/observability/RunTraceExportButton` is the sibling of this button on the
 * trace page; it cannot be reused here because it reads that page's `useRunInsights` context. This
 * one therefore ships `promptInsights: null` exactly as the route returns it.
 */

/**
 * `case-<short id>-run-trace-<workflow run id>.json`. Both halves are sanitized and capped, so a
 * hostile or absurdly long id cannot produce a path or an unusable filename.
 */
export function traceExportFilename(caseId: string, workflowRunId: string): string {
  const clean = (value: string) => value.replace(/[/\\?%*:|"<>\s]/g, '-').slice(0, 60);
  const caseShort = clean(caseId.slice(0, 8)) || 'case';
  const run = clean(workflowRunId) || 'run';
  return `case-${caseShort}-run-trace-${run}.json`;
}

export const BUTTON_CLASS =
  'inline-flex size-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:border-slate-100 disabled:text-slate-300 disabled:hover:bg-white print:hidden';

export type CaseTraceDownloadButtonProps = {
  /** The test item id, used only to name the file. */
  caseId: string;
  /** The workflow run that answered this prompt; null when none was recorded. */
  workflowRunId: string | null;
  className?: string;
};

export function CaseTraceDownloadButton({
  caseId,
  workflowRunId,
  className,
}: CaseTraceDownloadButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleClick(event: MouseEvent<HTMLButtonElement>) {
    // The button lives inside a <summary>: cancelling the click keeps a download from also
    // toggling the disclosure it sits in.
    event.preventDefault();
    event.stopPropagation();
    if (!workflowRunId || loading) return;

    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/observability/runs/${encodeURIComponent(workflowRunId)}/export`,
      );
      const data = (await res.json()) as Record<string, unknown> & { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'Trace download failed.');
        return;
      }

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = traceExportFilename(caseId, workflowRunId);
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (!workflowRunId) {
    return (
      <button
        aria-label="Trace report unavailable"
        className={cn(BUTTON_CLASS, className)}
        disabled
        title="No workflow run was recorded for this case"
        type="button"
      >
        <Download aria-hidden className="size-3.5" />
      </button>
    );
  }

  return (
    <button
      aria-label="Download trace report"
      className={cn(BUTTON_CLASS, className)}
      disabled={loading}
      onClick={handleClick}
      title={loading ? 'Preparing trace report...' : 'Download this case\'s trace report (JSON)'}
      type="button"
    >
      {loading ? (
        <Loader2 aria-hidden className="size-3.5 animate-spin" />
      ) : (
        <Download aria-hidden className="size-3.5" />
      )}
    </button>
  );
}

export type CaseTraceViewButtonProps = {
  /** The workflow run id; null when none was recorded. */
  workflowRunId: string | null;
  className?: string;
};

export function CaseTraceViewButton({
  workflowRunId,
  className,
}: CaseTraceViewButtonProps) {
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!workflowRunId) return;

    window.open(
      `/admin/observability/${encodeURIComponent(workflowRunId)}`,
      '_blank',
    );
  }

  if (!workflowRunId) {
    return (
      <button
        aria-label="Trace report unavailable"
        className={cn(BUTTON_CLASS, className)}
        disabled
        title="No workflow run was recorded for this case"
        type="button"
      >
        <Eye aria-hidden className="size-3.5" />
      </button>
    );
  }

  return (
    <button
      aria-label="View trace report"
      className={cn(BUTTON_CLASS, className)}
      onClick={handleClick}
      title="View this case\'s trace report in a new tab"
      type="button"
    >
      <Eye aria-hidden className="size-3.5" />
    </button>
  );
}
