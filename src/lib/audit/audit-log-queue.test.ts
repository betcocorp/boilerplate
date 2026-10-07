import { describe, expect, it, vi } from 'vitest';

import { buildAuditLogRow, type AuditContext } from '~/lib/audit/audit-log';
import {
  createAuditLogQueue,
  type QueuedAuditLogRow,
} from '~/lib/audit/audit-log-queue';

/**
 * B0-439 — the deferred/batched `audit_logs` writer.
 *
 * What must hold, because `~/lib/observability/timeline.ts` depends on all of it:
 * every row keeps the `created_at` of the moment its event happened (not the flush), rows reach the
 * table in enqueue order, the row/event-type/payload set is exactly what the inline writer produced,
 * and a failing write can never throw into the run.
 */

const CTX: AuditContext = {
  traceId: 'trace-1',
  conversationId: 'conv-1',
  workflowRunId: 'run-1',
};

/** Collects the batches handed to the writer, in the order it was called. */
function recordingWriter() {
  const batches: QueuedAuditLogRow[][] = [];
  const writeBatch = vi.fn(async (rows: QueuedAuditLogRow[]) => {
    batches.push(rows);
  });
  return { batches, writeBatch, rows: () => batches.flat() };
}

/** A clock the test advances explicitly, so "event time" is unambiguous. */
function fakeClock(startMs: number) {
  let ms = startMs;
  return {
    now: () => ms,
    advance: (by: number) => {
      ms += by;
    },
    set: (to: number) => {
      ms = to;
    },
  };
}

describe('createAuditLogQueue — created_at', () => {
  it('stamps each row at enqueue time, not at flush time', async () => {
    const clock = fakeClock(Date.parse('2026-08-11T12:00:00.000Z'));
    const writer = recordingWriter();
    const queue = createAuditLogQueue({ writeBatch: writer.writeBatch, now: clock.now });

    queue.enqueue('tool_called', { call_id: 'c1' }, CTX);
    clock.advance(1_500);
    queue.enqueue('tool_succeeded', { call_id: 'c1' }, CTX);

    // Flush happens a further 10s later; the rows must not inherit that instant.
    clock.advance(10_000);
    await queue.settle();

    expect(writer.rows().map((row) => row.created_at)).toEqual([
      '2026-08-11T12:00:00.000Z',
      '2026-08-11T12:00:01.500Z',
    ]);
  });

  it('keeps a tool call duration diffable from its two rows', async () => {
    const clock = fakeClock(Date.parse('2026-08-11T12:00:00.000Z'));
    const writer = recordingWriter();
    const queue = createAuditLogQueue({ writeBatch: writer.writeBatch, now: clock.now });

    queue.enqueue('tool_called', { call_id: 'c1' }, CTX);
    clock.advance(842);
    queue.enqueue('tool_succeeded', { call_id: 'c1' }, CTX);
    await queue.settle();

    const [called, succeeded] = writer.rows();
    expect(Date.parse(succeeded!.created_at) - Date.parse(called!.created_at)).toBe(842);
  });

  it('never lets a stamp go backwards, so enqueue order survives a clock jump', async () => {
    const clock = fakeClock(Date.parse('2026-08-11T12:00:05.000Z'));
    const writer = recordingWriter();
    const queue = createAuditLogQueue({ writeBatch: writer.writeBatch, now: clock.now });

    queue.enqueue('first', {}, CTX);
    clock.set(Date.parse('2026-08-11T12:00:02.000Z'));
    queue.enqueue('second', {}, CTX);
    await queue.settle();

    const stamps = writer.rows().map((row) => Date.parse(row.created_at));
    expect(stamps[1]).toBeGreaterThanOrEqual(stamps[0]!);
  });
});

describe('createAuditLogQueue — ordering and batching', () => {
  it('writes queued rows as one batch, in enqueue order', async () => {
    const writer = recordingWriter();
    const queue = createAuditLogQueue({ writeBatch: writer.writeBatch });

    queue.enqueue('workflow_started', {}, { ...CTX, workflowRunId: null });
    queue.enqueue('step_started', { step: 'orchestration_planner' }, CTX);
    queue.enqueue('openai_response_requested', { step: 'agent' }, CTX);
    await queue.settle();

    expect(writer.writeBatch).toHaveBeenCalledTimes(1);
    expect(writer.batches[0]!.map((row) => row.event_type)).toEqual([
      'workflow_started',
      'step_started',
      'openai_response_requested',
    ]);
  });

  it('keeps batches in order even when a later batch is queued mid-write', async () => {
    const batches: string[][] = [];
    let releaseFirst!: () => void;
    // The first batch is held open, so a writer that ran batches concurrently would record the
    // second one first.
    const firstBatchGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writeBatch = vi.fn(async (rows: QueuedAuditLogRow[]) => {
      if (batches.length === 0) {
        await firstBatchGate;
      }
      batches.push(rows.map((row) => row.event_type));
    });
    const queue = createAuditLogQueue({ writeBatch });

    queue.enqueue('tool_called', {}, CTX);
    queue.flushDetached();
    queue.enqueue('tool_succeeded', {}, CTX);
    queue.flushDetached();

    const settled = queue.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirst();
    await settled;

    expect(batches).toEqual([['tool_called'], ['tool_succeeded']]);
  });

  it('writes rows enqueued while an earlier batch was still in flight', async () => {
    const writer = recordingWriter();
    let seen = 0;
    const queue = createAuditLogQueue({
      writeBatch: async (rows) => {
        seen += 1;
        if (seen === 1) {
          // Simulate the workflow recording another event during the first insert.
          queue.enqueue('validation_completed', {}, CTX);
        }
        await writer.writeBatch(rows);
      },
    });

    queue.enqueue('workflow_started', {}, CTX);
    await queue.settle();

    expect(writer.rows().map((row) => row.event_type)).toEqual([
      'workflow_started',
      'validation_completed',
    ]);
    expect(queue.pendingCount()).toBe(0);
  });

  it('writes nothing until the caller flushes or settles', async () => {
    const writer = recordingWriter();
    const queue = createAuditLogQueue({ writeBatch: writer.writeBatch });

    queue.enqueue('workflow_started', {}, CTX);
    queue.enqueue('step_started', {}, CTX);

    expect(writer.writeBatch).not.toHaveBeenCalled();
    expect(queue.pendingCount()).toBe(2);

    queue.flushDetached();
    await queue.settle();
    expect(writer.writeBatch).toHaveBeenCalledTimes(1);
  });
});

describe('createAuditLogQueue — rows match the inline writer', () => {
  it('produces the same row the immediate writeAuditLog path would, plus created_at', async () => {
    const clock = fakeClock(Date.parse('2026-08-11T12:00:00.000Z'));
    const writer = recordingWriter();
    const queue = createAuditLogQueue({ writeBatch: writer.writeBatch, now: clock.now });

    const ctx: AuditContext = {
      traceId: 'trace-9',
      conversationId: 'conv-9',
      workflowRunId: 'run-9',
      stepId: 'step-9',
      model: 'gpt-x',
      toolName: 'search_product_docs',
    };
    const payload = { tool_name: 'search_product_docs', call_id: 'call-9', speculative: true };

    queue.enqueue('tool_called', payload, ctx);
    await queue.settle();

    expect(writer.rows()[0]).toEqual({
      ...buildAuditLogRow('tool_called', payload, ctx),
      created_at: '2026-08-11T12:00:00.000Z',
    });
  });

  it('leaves a null workflow_run_id null (the workflow_started row)', async () => {
    const writer = recordingWriter();
    const queue = createAuditLogQueue({ writeBatch: writer.writeBatch });

    queue.enqueue('workflow_started', { workflow: 'product-support' }, {
      ...CTX,
      workflowRunId: null,
    });
    await queue.settle();

    const row = writer.rows()[0]!;
    expect(row.workflow_run_id).toBeNull();
    expect((row.payload as Record<string, unknown>).workflow_run_id).toBeNull();
  });

  it('changes neither the row count nor the event-type set of a run', async () => {
    const writer = recordingWriter();
    const queue = createAuditLogQueue({ writeBatch: writer.writeBatch });

    const events = [
      'workflow_started',
      'step_started',
      'openai_response_requested',
      'tool_called',
      'tool_succeeded',
      'speculative_retrieval',
      'validation_completed',
      'workflow_completed',
    ];
    for (const event of events) {
      queue.enqueue(event, {}, CTX);
    }
    await queue.settle();

    expect(writer.rows()).toHaveLength(events.length);
    expect(writer.rows().map((row) => row.event_type)).toEqual(events);
  });
});

describe('createAuditLogQueue — failures never reach the caller', () => {
  it('swallows a batch failure, retries the rows singly, and still resolves', async () => {
    const attempts: string[][] = [];
    const onError = vi.fn();
    const queue = createAuditLogQueue({
      writeBatch: async (rows) => {
        attempts.push(rows.map((row) => row.event_type));
        if (rows.length > 1) {
          throw new Error('batch rejected');
        }
        if (rows[0]!.event_type === 'tool_failed') {
          throw new Error('poison row');
        }
      },
      onError,
    });

    queue.enqueue('tool_called', {}, CTX);
    queue.enqueue('tool_failed', {}, CTX);
    queue.enqueue('tool_succeeded', {}, CTX);

    await expect(queue.settle()).resolves.toBeUndefined();

    // Batch first, then one insert per row so a single bad row costs only itself.
    expect(attempts).toEqual([
      ['tool_called', 'tool_failed', 'tool_succeeded'],
      ['tool_called'],
      ['tool_failed'],
      ['tool_succeeded'],
    ]);
    expect(onError.mock.calls.map((call) => call[0])).toEqual([
      'audit_log_batch_write_failed',
      'audit_log_write_failed',
    ]);
  });

  it('does not retry singly when the failed batch held a single row', async () => {
    const writeBatch = vi.fn(async () => {
      throw new Error('nope');
    });
    const queue = createAuditLogQueue({ writeBatch, onError: () => undefined });

    queue.enqueue('workflow_failed', {}, CTX);
    await expect(queue.settle()).resolves.toBeUndefined();
    expect(writeBatch).toHaveBeenCalledTimes(1);
  });

  it('a detached batch that fails does not reject anywhere', async () => {
    const onError = vi.fn();
    const queue = createAuditLogQueue({
      writeBatch: async () => {
        throw new Error('detached failure');
      },
      onError,
    });

    queue.enqueue('workflow_started', {}, CTX);
    // No await here on purpose: this is the fire-then-settle shape the workflow uses.
    expect(() => queue.flushDetached()).not.toThrow();
    // Give the detached write a turn; an unhandled rejection here would fail the suite.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledWith(
      'audit_log_batch_write_failed',
      expect.objectContaining({ message: 'detached failure' }),
    );
    await expect(queue.settle()).resolves.toBeUndefined();
  });

  it('survives a writer that throws synchronously', async () => {
    const queue = createAuditLogQueue({
      writeBatch: (() => {
        throw new Error('sync boom');
      }) as never,
      onError: () => undefined,
    });

    queue.enqueue('workflow_started', {}, CTX);
    await expect(queue.settle()).resolves.toBeUndefined();
  });
});
