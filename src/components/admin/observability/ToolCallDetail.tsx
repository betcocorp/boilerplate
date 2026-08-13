'use client';

/**
 * B0-333 — expanded detail for a `tool_call` timeline event.
 *
 * The RAG drill-down reuses `RetrievedChunksPreview` /
 * `RagDocumentChunkInspectButtons` unchanged: chunk refs are recovered from the
 * persisted `outputPreview` (RAG tool payloads carry `documentId` / `chunkId`
 * per source — see `~/lib/tools/product-tools.ts`).
 */

import { RetrievedChunksPreview } from '~/components/admin/tests/RetrievedChunksPreview';
import { TraceJsonBlock } from '~/components/admin/observability/TraceJsonBlock';
import { Badge } from '~/components/ui/badge';
import { formatDurationMs } from '~/lib/utils/time';

import type { ToolCallOrigin } from '~/lib/audit/trace';
import type { RetrievedDocumentChunkRef } from '~/lib/workflows/product-support/product-support-schemas';
import type { ToolCallTimelineEvent } from '~/types/observability';

/**
 * B0-390 — a forced or injected call is not a call the model chose, and reading it as one looks
 * like a bug. `model_chosen` needs no badge; the other three do.
 */
const ORIGIN_LABELS: Record<ToolCallOrigin, string | null> = {
  model_chosen: null,
  tool_choice_forced: 'forced by tool_choice',
  workflow_injected: 'injected by workflow',
  safety_net_override: 'cross-reference safety net',
};

/**
 * Tolerant scan rather than `JSON.parse`: `outputPreview` is capped at 4000
 * chars at write time, so a long RAG payload is usually invalid JSON. Handles
 * both the camelCase tool payload shape and snake_case variants.
 */
const CHUNK_REF_PATTERN =
  /"document_?[Ii]d"\s*:\s*"([^"]+)"(?:\s*,\s*"chunk_?[Ii]d"\s*:\s*(?:"([^"]*)"|null))?(?:\s*,\s*"title"\s*:\s*"((?:[^"\\]|\\.)*)")?/g;

function extractChunkRefsFromPreview(outputPreview: string): RetrievedDocumentChunkRef[] {
  const seen = new Set<string>();
  const refs: RetrievedDocumentChunkRef[] = [];

  for (const match of outputPreview.matchAll(CHUNK_REF_PATTERN)) {
    const documentId = match[1];
    if (!documentId) {
      continue;
    }
    const chunkId = match[2] ?? null;
    const key = `${documentId}:${chunkId ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push({
      document_id: documentId,
      chunk_id: chunkId,
      document_kind: null,
      document_title: match[3] ?? null,
    });
  }

  return refs;
}

/**
 * B0-417 — `argumentsPreview` / `outputPreview` are null on reconstructed events:
 * they only ever existed on the agent step's `toolTrace` and were never written to
 * `audit_logs`, so they are unrecoverable for pre-B0-331 runs. Render that as an
 * explicit statement rather than an empty code block, which would read as "the tool
 * was called with nothing" / "the tool returned nothing".
 */
function NotCapturedBlock({ label }: { label: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      <p className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-900">
        Not captured for this run.
      </p>
    </div>
  );
}

export function ToolCallDetail({ event }: { event: ToolCallTimelineEvent }) {
  // `?? ''` because a reconstructed event has no preview to scan (B0-417).
  const chunks = extractChunkRefsFromPreview(event.outputPreview ?? '');
  const originLabel = event.origin ? ORIGIN_LABELS[event.origin] : null;

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge className="rounded-full font-mono text-[0.65rem]" variant="outline">
          {event.toolName}
        </Badge>
        {originLabel ? (
          <Badge
            className="rounded-full border-sky-500/50 bg-sky-500/10 text-[0.65rem] text-sky-800"
            variant="outline"
          >
            {originLabel}
          </Badge>
        ) : null}
        {/* `ok === null` is an unsettled reconstructed call — unknown, not failed. */}
        <Badge
          className="rounded-full"
          variant={event.ok === null ? 'outline' : event.ok ? 'secondary' : 'destructive'}
        >
          {event.ok === null ? 'outcome unknown' : event.ok ? 'ok' : 'failed'}
        </Badge>
        {typeof event.durationMs === 'number' ? (
          <Badge className="rounded-full tabular-nums" variant="outline">
            {formatDurationMs(event.durationMs)}
          </Badge>
        ) : null}
        <span className="font-mono text-[0.65rem] text-muted-foreground">
          call_id {event.callId}
        </span>
      </div>

      {/* Merge of B0-417 and B0-390: a null preview is unrecoverable and gets the explicit
          "not captured" state, while a preview that IS present may still have been cut, so it
          keeps the TRUNCATED label. The two cases are independent. */}
      {event.argumentsPreview === null ? (
        <NotCapturedBlock label="Arguments" />
      ) : (
        <TraceJsonBlock
          label={event.argumentsTruncated ? 'Arguments (TRUNCATED)' : 'Arguments'}
          value={event.argumentsPreview}
        />
      )}
      {event.outputPreview === null ? (
        <NotCapturedBlock label="Output" />
      ) : (
        <TraceJsonBlock
          label={event.outputTruncated ? 'Output (TRUNCATED)' : 'Output'}
          value={event.outputPreview}
        />
      )}
      {/* B0-390 — tool payloads carry label/SDS values (dilution ratios, EPA reg numbers, ppm,
          contact times). A cut preview is called out explicitly so no one reads a truncated
          regulated value as the complete one. The reconstructed case comes first: those events
          have no previews at all, so neither a truncation warning nor an all-clear applies. */}
      {event.reconstructed ? (
        <p className="text-[0.65rem] text-muted-foreground">
          Rebuilt from this run&apos;s <code className="font-mono">tool_called</code> /{' '}
          <code className="font-mono">tool_succeeded</code> /{' '}
          <code className="font-mono">tool_failed</code> audit rows. The tool name,
          timestamps, duration and outcome are recorded; the argument and output
          previews were never written for this run.
        </p>
      ) : event.argumentsTruncated || event.outputTruncated ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[0.7rem] text-amber-900">
          Truncated at write time —{' '}
          {[
            event.argumentsTruncated ? 'arguments (1,800 chars)' : null,
            event.outputTruncated ? 'output (4,000 chars)' : null,
          ]
            .filter(Boolean)
            .join(' and ')}
          . Values shown may be cut mid-figure; do not treat a regulated value here as complete.
        </p>
      ) : (
        <p className="text-[0.65rem] text-muted-foreground">
          Previews are captured truncated at write time (1,800 chars for arguments,
          4,000 for output).
          {event.argumentsTruncated === null
            ? ' This run predates per-call truncation flags, so whether these previews were cut is unknown.'
            : ' Neither preview was cut for this call.'}
        </p>
      )}

      {chunks.length > 0 ? (
        <div className="min-w-0 space-y-1">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Retrieved chunks — view full source
          </p>
          <RetrievedChunksPreview chunks={chunks} />
        </div>
      ) : null}
    </div>
  );
}
