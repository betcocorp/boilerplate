/**
 * B0-439 — deferred, batched `audit_logs` writer (epic B0-434, response latency).
 *
 * ## Why
 * A product-support run wrote ~13 audit rows one awaited round trip at a time. Measured from
 * `audit_logs` inter-row gaps (rows written back-to-back with no work between them) a single insert
 * costs ~45-90ms, so the bookkeeping alone was ~0.6-1.0s of the run — and five of those writes
 * happened before the first model call, i.e. directly on TTFT.
 *
 * This queue takes those inserts off the critical path without changing what gets written: the same
 * rows, the same payloads, the same order, the same per-run event-type set.
 *
 * ## `created_at` is stamped here, not by the database
 * `public.audit_logs.created_at` is a plain settable column (`default now()`), so a batched writer
 * MUST stamp the event's own time at ENQUEUE and pass it on the insert. `buildRunTimeline`
 * (`~/lib/observability/timeline.ts`) orders audit rows by `created_at` and derives every tool-call
 * duration by diffing `tool_called` against `tool_succeeded` / `tool_failed` per `call_id`; rows
 * landing with flush-time timestamps would silently corrupt both.
 *
 * The stamp comes from the Node clock, where the immediate writer got the Postgres clock. Measured
 * divergence between the two on this project (`workflow_steps` where `completed_at` is stamped in
 * Node immediately before the insert whose `started_at` is Postgres `now()`, 243 rows on
 * 2026-08-11): p50 36ms, max 130ms — dominated by the insert round trip itself, not by clock drift.
 * That is far below the spacing of the events involved, and `timeline.ts` deliberately avoids
 * step-window containment (its one Postgres-vs-audit comparison, the reconstructed-tool-call
 * fallback, resolves to the same step either way), so no new mixed-clock comparison is created.
 * Stamps are additionally kept non-decreasing within a queue so enqueue order survives a clock that
 * jumps backwards.
 *
 * ## Detach discipline (Vercel Fluid Compute)
 * A promise still in flight when the response finishes can be killed, so nothing here is truly
 * fire-and-forget: `flushDetached()` only overlaps a batch with an await the caller is ALREADY
 * paying for (the retrieval, the model call), and `settle()` must be awaited before the caller
 * returns. Every write path swallows its own error exactly like `writeAuditLog` does, and the
 * internal chain can never reject, so a detached batch cannot become an unhandled rejection.
 */

import { buildAuditLogRow, type AuditContext } from '~/lib/audit/audit-log';
import { getErrorMessage } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { TablesInsert } from '~/types/supabase.public';

/** An `audit_logs` insert with the event's true time already stamped on it. */
export type QueuedAuditLogRow = TablesInsert<'audit_logs'> & { created_at: string };

export type AuditLogBatchWriter = (rows: QueuedAuditLogRow[]) => Promise<void>;

export type AuditLogQueueOptions = {
  /** Injected for tests; defaults to a single batched Supabase insert. */
  writeBatch?: AuditLogBatchWriter;
  /** Injected clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
  /** Structured error sink; defaults to the same `console.error` shape `writeAuditLog` uses. */
  onError?: (event: string, fields: Record<string, unknown>) => void;
};

export type AuditLogQueue = {
  /** Record an event now, write it later. Never throws, never awaits. */
  enqueue(eventType: string, payload: Record<string, unknown>, ctx: AuditContext): void;
  /**
   * Start writing everything queued so far and return immediately. Call this right before an await
   * the run is already paying for, so the insert overlaps it instead of adding to the run.
   */
  flushDetached(): void;
  /** Await every write, including rows enqueued while an earlier batch was in flight. */
  settle(): Promise<void>;
  /** Rows recorded but not yet handed to the writer (diagnostics / tests). */
  pendingCount(): number;
};

async function insertAuditLogBatch(rows: QueuedAuditLogRow[]): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase.from('audit_logs').insert(rows);
  if (error) {
    throw new Error(error.message);
  }
}

function logToConsole(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: 'error', event, ...fields }));
}

export function createAuditLogQueue(options: AuditLogQueueOptions = {}): AuditLogQueue {
  const now = options.now ?? Date.now;
  const writeBatch = options.writeBatch ?? insertAuditLogBatch;
  const onError = options.onError ?? logToConsole;

  const pending: QueuedAuditLogRow[] = [];
  /** Serialized so batches reach the table in enqueue order even while one is in flight. */
  let chain: Promise<void> = Promise.resolve();
  let lastStampMs = 0;

  const stamp = (): string => {
    lastStampMs = Math.max(now(), lastStampMs);
    return new Date(lastStampMs).toISOString();
  };

  const write = async (rows: QueuedAuditLogRow[]): Promise<void> => {
    try {
      await writeBatch(rows);
      return;
    } catch (err) {
      onError('audit_log_batch_write_failed', {
        count: rows.length,
        eventTypes: rows.map((row) => row.event_type),
        message: getErrorMessage(err),
      });
    }

    if (rows.length < 2) {
      return;
    }

    // A batch insert is one statement, so one rejected row would cost the whole batch. Retry the
    // rows singly to keep the blast radius of a bad row at that row, as it was per-write before.
    for (const row of rows) {
      try {
        await writeBatch([row]);
      } catch (err) {
        onError('audit_log_write_failed', {
          eventType: row.event_type,
          message: getErrorMessage(err),
        });
      }
    }
  };

  const flushDetached = (): void => {
    if (pending.length === 0) {
      return;
    }
    const batch = pending.splice(0, pending.length);
    // `write` swallows everything; the extra `.catch` is a hard guarantee that a detached batch can
    // never surface as an unhandled rejection (which on Node would take the process down).
    chain = chain.then(() => write(batch)).catch(() => undefined);
  };

  return {
    enqueue(eventType, payload, ctx) {
      pending.push({ ...buildAuditLogRow(eventType, payload, ctx), created_at: stamp() });
    },
    flushDetached,
    async settle() {
      for (;;) {
        flushDetached();
        const inFlight = chain;
        await inFlight;
        // A row enqueued while that batch was writing must still go out before we report settled.
        if (pending.length === 0 && chain === inFlight) {
          return;
        }
      }
    },
    pendingCount: () => pending.length,
  };
}
