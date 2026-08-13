'use client';

/**
 * B0-333 — collapsed-by-default vertical trace timeline for a single workflow run.
 *
 * Every confidence-affecting gate is its own point on the rail (never folded into
 * one opaque confidence number), failures are red-flagged with their inline error,
 * and steps the run never reached render muted/dashed.
 */

import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  Flag,
  Gauge,
  Layers,
  Loader,
  ScrollText,
  UserRoundCheck,
  Wrench,
} from 'lucide-react';
import { useState } from 'react';

import { ToolCallDetail } from '~/components/admin/observability/ToolCallDetail';
import { TraceJsonBlock } from '~/components/admin/observability/TraceJsonBlock';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '~/components/ui/collapsible';
import { cn } from '~/lib/utils';
import { formatDurationMs, formatEasternTime } from '~/lib/utils/time';

import type { RunEmptyState } from '~/lib/observability/timeline';
import type { TimelineEvent, TimelineEventStatus } from '~/types/observability';

/**
 * B0-399 — the four empty/degraded-state banners. Order matters only for display: multiple can
 * legitimately be true at once in principle (though in practice `predatesCapture` and
 * `declinedWithoutModelCall` are mutually exclusive, since the decline gate is itself a
 * `workflow_steps` row).
 */
function EmptyStateBanners({ emptyState }: { emptyState: RunEmptyState | undefined }) {
  if (!emptyState) {
    return null;
  }

  const banners: { key: string; text: string }[] = [];
  if (emptyState.predatesCapture) {
    banners.push({
      key: 'predates-capture',
      text: 'Not captured — this run predates prompt capture.',
    });
  }
  if (emptyState.runFailed) {
    banners.push({
      key: 'run-failed',
      text: 'Run failed before completing. Partial timeline below.',
    });
  }
  if (emptyState.declinedWithoutModelCall) {
    banners.push({
      key: 'decline-gate-only',
      text: 'No model call — answer produced by the decline gate.',
    });
  }

  if (banners.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {banners.map((banner) => (
        <p
          className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-900"
          key={banner.key}
        >
          {banner.text}
        </p>
      ))}
    </div>
  );
}

const NODE_STYLES: Record<TimelineEventStatus, string> = {
  ok: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700',
  failed: 'border-destructive/50 bg-destructive/10 text-destructive',
  not_reached: 'border-dashed border-slate-300 bg-white text-slate-400',
  running: 'border-amber-500/50 bg-amber-500/10 text-amber-700',
};

const ROW_STYLES: Record<TimelineEventStatus, string> = {
  ok: 'border-slate-200 bg-white',
  failed: 'border-destructive/30 bg-destructive/5',
  not_reached: 'border-dashed border-slate-200 bg-slate-50/70',
  running: 'border-amber-300/60 bg-amber-50/60',
};

const KIND_LABELS: Record<TimelineEvent['kind'], string> = {
  lifecycle: 'lifecycle',
  step: 'step',
  tool_call: 'tool call',
  confidence_gate: 'confidence gate',
  review: 'review',
  audit: 'audit',
};

function EventIcon({ event }: { event: TimelineEvent }) {
  const className = 'size-4';
  switch (event.kind) {
    case 'lifecycle':
      if (event.phase === 'workflow_failed') return <CircleX className={className} />;
      if (event.phase === 'workflow_completed') return <CircleCheck className={className} />;
      return <Flag className={className} />;
    case 'step':
      if (event.status === 'not_reached') return <CircleDashed className={className} />;
      if (event.status === 'running') return <Loader className={className} />;
      return <Layers className={className} />;
    case 'tool_call':
      return <Wrench className={className} />;
    case 'confidence_gate':
      return <Gauge className={className} />;
    case 'review':
      return <UserRoundCheck className={className} />;
    default:
      return <ScrollText className={className} />;
  }
}

/** `workflow_steps.error` is a `Json` column; pull a human message out of it. */
function readErrorMessage(error: unknown): string | null {
  if (!error) {
    return null;
  }
  if (typeof error === 'string') {
    return error.trim() || null;
  }
  if (typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }
  return JSON.stringify(error);
}

function formatConfidence(value: number | null): string {
  return typeof value === 'number' ? value.toFixed(2) : '—';
}

function TimelineEventRow({
  event,
  open,
  onOpenChange,
}: {
  event: TimelineEvent;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const isNotReached = event.status === 'not_reached';
  const isFailed = event.status === 'failed';
  // B0-363 — a failed tool call now carries its cause on the `tool_failed` audit
  // row, so it can be red-flagged inline exactly like a failed step.
  const inlineError =
    event.kind === 'step'
      ? readErrorMessage(event.error)
      : event.kind === 'tool_call'
        ? event.errorMessage
        : null;

  return (
    <li className="relative pl-12">
      <span
        aria-hidden
        className={cn(
          'absolute left-0 top-2 flex size-9 items-center justify-center rounded-full border',
          NODE_STYLES[event.status],
        )}
      >
        <EventIcon event={event} />
      </span>

      <Collapsible onOpenChange={onOpenChange} open={open}>
        <div
          className={cn(
            'overflow-hidden rounded-2xl border shadow-sm ring-1 ring-transparent transition-colors',
            ROW_STYLES[event.status],
          )}
        >
          <CollapsibleTrigger asChild>
            <button
              className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left hover:bg-slate-50/80"
              type="button"
            >
              {open ? (
                <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-slate-400" aria-hidden />
              ) : (
                <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-slate-400" aria-hidden />
              )}

              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className={cn(
                      'text-sm font-medium',
                      isFailed
                        ? 'text-destructive'
                        : isNotReached
                          ? 'text-slate-500'
                          : 'text-slate-900',
                    )}
                  >
                    {event.label}
                  </span>
                  <Badge className="rounded-full text-[0.62rem]" variant="secondary">
                    {KIND_LABELS[event.kind]}
                  </Badge>
                  {typeof event.durationMs === 'number' ? (
                    <Badge className="rounded-full tabular-nums text-[0.62rem]" variant="outline">
                      {formatDurationMs(event.durationMs)}
                    </Badge>
                  ) : null}
                  {isNotReached ? (
                    <Badge
                      className="rounded-full border-dashed text-[0.62rem] text-slate-500"
                      variant="outline"
                    >
                      not reached
                    </Badge>
                  ) : null}
                  {isFailed ? (
                    <Badge className="rounded-full text-[0.62rem]" variant="destructive">
                      failed
                    </Badge>
                  ) : null}
                  {event.inferred ? (
                    <Badge
                      className="rounded-full border-amber-500/50 bg-amber-500/10 text-[0.62rem] text-amber-800"
                      variant="outline"
                    >
                      inferred, no direct log entry
                    </Badge>
                  ) : null}
                  {/* B0-417 — mirrors the `inferred` badge above: this tool call was
                      rebuilt from audit rows because the run predates `toolTrace`. */}
                  {event.kind === 'tool_call' && event.reconstructed ? (
                    <Badge
                      className="rounded-full border-amber-500/50 bg-amber-500/10 text-[0.62rem] text-amber-800"
                      variant="outline"
                    >
                      reconstructed, previews not captured
                    </Badge>
                  ) : null}
                  {event.kind === 'confidence_gate' && event.requiresHumanReview ? (
                    <Badge className="rounded-full text-[0.62rem]" variant="outline">
                      human review
                    </Badge>
                  ) : null}
                </span>

                {event.kind === 'confidence_gate' ? (
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                    <span className="font-mono tabular-nums">
                      confidence {formatConfidence(event.confidenceBefore)} →{' '}
                      {formatConfidence(event.confidenceAfter)}
                    </span>
                    {typeof event.cap === 'number' ? (
                      <span className="font-mono tabular-nums text-amber-800">
                        cap {event.cap}
                      </span>
                    ) : null}
                    <span className="font-mono text-slate-400">{event.gate}</span>
                  </span>
                ) : null}

                {/* Red-flagged failure surfaces its error at the point of failure,
                    without needing to expand the row. */}
                {inlineError ? (
                  <span className="block break-words text-xs font-medium text-destructive">
                    {inlineError}
                  </span>
                ) : null}

                {isNotReached ? (
                  <span className="block text-xs text-slate-500">
                    Not reached — the run ended before this step.
                  </span>
                ) : null}
              </span>

              <span className="shrink-0 whitespace-nowrap pt-0.5 font-mono text-[0.65rem] text-slate-400">
                {formatEasternTime(event.at)}
              </span>
            </button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div className="min-w-0 space-y-3 border-t border-slate-100 px-4 py-3">
              {event.kind === 'tool_call' ? (
                <ToolCallDetail event={event} />
              ) : null}

              {/* B0-363 — failure diagnostics persisted on the `tool_failed` audit
                  row. Present only for runs logged after B0-363 landed. */}
              {event.kind === 'tool_call' &&
              (event.errorMessage || event.auditArgumentsPreview) ? (
                <div className="min-w-0 space-y-2">
                  <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-destructive">
                    Failure detail (tool_failed audit row)
                  </p>
                  {event.errorMessage ? (
                    <TraceJsonBlock label="Error message" value={event.errorMessage} />
                  ) : null}
                  {event.auditArgumentsPreview ? (
                    <TraceJsonBlock
                      label="Arguments preview (audit, 512 chars)"
                      value={event.auditArgumentsPreview}
                    />
                  ) : null}
                </div>
              ) : null}

              {event.kind === 'confidence_gate' ? (
                <div className="space-y-2 text-xs text-slate-700">
                  <dl className="grid gap-1 sm:grid-cols-2">
                    <div className="flex gap-2">
                      <dt className="text-muted-foreground">Gate</dt>
                      <dd className="font-mono">{event.gate}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-muted-foreground">Approved</dt>
                      <dd className="font-mono">
                        {event.approved === null ? '—' : String(event.approved)}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-muted-foreground">Confidence before → after</dt>
                      <dd className="font-mono tabular-nums">
                        {formatConfidence(event.confidenceBefore)} →{' '}
                        {formatConfidence(event.confidenceAfter)}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-muted-foreground">Cap</dt>
                      <dd className="font-mono tabular-nums">
                        {typeof event.cap === 'number' ? event.cap : '—'}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-muted-foreground">Requires human review</dt>
                      <dd className="font-mono">{String(event.requiresHumanReview)}</dd>
                    </div>
                  </dl>
                  {event.inferred ? (
                    <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-900">
                      Inferred, no direct log entry — this gate writes no audit row, so
                      the event is reconstructed from the workflow&apos;s persisted output.
                    </p>
                  ) : null}
                  {event.issues.length > 0 ? (
                    <div>
                      <p className="font-medium text-slate-900">Issues</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">
                        {event.issues.map((issue) => (
                          <li className="break-words" key={`${event.id}-${issue}`}>
                            {issue}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {event.kind === 'review' ? (
                <div className="space-y-2 text-xs text-slate-700">
                  <p>
                    <span className="text-muted-foreground">Reason: </span>
                    <span className="font-mono">{event.reason ?? '—'}</span>
                  </p>
                  {event.issues.length > 0 ? (
                    <ul className="list-disc space-y-0.5 pl-4">
                      {event.issues.map((issue) => (
                        <li className="break-words" key={`${event.id}-${issue}`}>
                          {issue}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {event.kind === 'step' ? (
                <dl className="grid gap-1 text-xs text-slate-700 sm:grid-cols-3">
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Step name</dt>
                    <dd className="font-mono break-all">{event.stepName}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Raw status</dt>
                    <dd className="font-mono">{event.rawStatus ?? '—'}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Step id</dt>
                    <dd className="font-mono break-all">{event.stepId ?? '—'}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Started</dt>
                    <dd className="font-mono">
                      {event.startedAt ? formatEasternTime(event.startedAt) : '—'}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Completed</dt>
                    <dd className="font-mono">
                      {event.completedAt ? formatEasternTime(event.completedAt) : '—'}
                    </dd>
                  </div>
                </dl>
              ) : null}

              {event.kind === 'step' && event.error ? (
                <TraceJsonBlock label="Error" value={event.error} />
              ) : null}

              {event.kind === 'audit' ? (
                <p className="text-xs text-slate-700">
                  <span className="text-muted-foreground">Event type: </span>
                  <span className="font-mono">{event.eventType}</span>
                </p>
              ) : null}

              {event.kind === 'tool_call' ? null : (
                <TraceJsonBlock label="Detail" value={event.detail} />
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </li>
  );
}

export function RunTraceTimeline({
  events,
  emptyState,
}: {
  events: TimelineEvent[];
  /** B0-399 — undefined when the caller has no `emptyState` to offer (e.g. a stale caller/test). */
  emptyState?: RunEmptyState;
}) {
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  if (events.length === 0) {
    return (
      <div className="space-y-3">
        <EmptyStateBanners emptyState={emptyState} />
        <p className="text-sm text-slate-500">
          No timeline events were recorded for this run.
        </p>
      </div>
    );
  }

  const setOpen = (id: string, next: boolean) => {
    setOpenIds((current) => {
      const updated = new Set(current);
      if (next) {
        updated.add(id);
      } else {
        updated.delete(id);
      }
      return updated;
    });
  };

  return (
    <div className="space-y-4">
      <EmptyStateBanners emptyState={emptyState} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          {events.length} event{events.length === 1 ? '' : 's'} — collapsed by
          default; expand any point for its full detail.
        </p>
        <div className="flex gap-2">
          <Button
            onClick={() => setOpenIds(new Set(events.map((event) => event.id)))}
            size="sm"
            type="button"
            variant="outline"
          >
            Expand all
          </Button>
          <Button
            onClick={() => setOpenIds(new Set<string>())}
            size="sm"
            type="button"
            variant="outline"
          >
            Collapse all
          </Button>
        </div>
      </div>

      <div className="relative">
        <span
          aria-hidden
          className="absolute bottom-4 left-[1.0625rem] top-4 w-px bg-slate-200"
        />
        <ol className="space-y-3">
          {events.map((event) => (
            <TimelineEventRow
              event={event}
              key={event.id}
              onOpenChange={(next) => setOpen(event.id, next)}
              open={openIds.has(event.id)}
            />
          ))}
        </ol>
      </div>
    </div>
  );
}
