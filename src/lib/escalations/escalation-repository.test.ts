import { beforeEach, describe, expect, it, vi } from 'vitest';

const fromMock = vi.hoisted(() => vi.fn());

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => ({ from: fromMock }),
}));

import {
  escalationRowSchema,
  listEscalations,
  updateEscalationStatus,
} from '~/lib/escalations/escalation-repository';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    created_at: '2026-10-05T19:00:00.000Z',
    updated_at: '2026-10-05T19:00:00.000Z',
    status: 'open',
    reference: 'ESC-0001',
    source: 'harness',
    workflow_run_id: null,
    conversation_id: null,
    user_id: null,
    acted_by_user_id: null,
    specialist: null,
    reason: 'no_evidence',
    question: 'q',
    summary: 's',
    retrieved_sources: [],
    external_ticket_ref: null,
    resolved_at: null,
    resolution_notes: null,
    ...overrides,
  };
}

/** Records the builder calls so the test can assert filter/range/order without a real client. */
function mockList(data: unknown[]) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'order', 'eq']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return builder;
    };
  }
  builder.range = (...args: unknown[]) => {
    calls.push(['range', args]);
    return Promise.resolve({ data, error: null });
  };
  fromMock.mockReturnValue(builder);
  return calls;
}

beforeEach(() => {
  fromMock.mockReset();
});

describe('escalationRowSchema (B0-528)', () => {
  it('parses a well-formed row and tolerates an unexpected retrieved_sources shape', () => {
    expect(escalationRowSchema.parse(row()).reference).toBe('ESC-0001');
    expect(escalationRowSchema.parse(row({ retrieved_sources: 'oops' })).retrieved_sources).toEqual(
      [],
    );
  });

  it('rejects a status or reason outside the table CHECK vocabulary', () => {
    expect(escalationRowSchema.safeParse(row({ status: 'closed' })).success).toBe(false);
    expect(escalationRowSchema.safeParse(row({ reason: 'hubspot' })).success).toBe(false);
  });
});

describe('listEscalations (B0-528)', () => {
  it('maps rows newest-first, over-fetches one to compute hasMore, and applies the status filter', async () => {
    const calls = mockList([
      row({ reference: 'ESC-0003' }),
      row({ reference: 'ESC-0002' }),
      row({ reference: 'ESC-0001' }),
    ]);

    const result = await listEscalations({ status: 'open', limit: 2, offset: 0 });

    expect(fromMock).toHaveBeenCalledWith('escalations');
    expect(result.hasMore).toBe(true);
    expect(result.rows.map((r) => r.reference)).toEqual(['ESC-0003', 'ESC-0002']);
    expect(calls).toContainEqual(['order', ['created_at', { ascending: false }]]);
    expect(calls).toContainEqual(['eq', ['status', 'open']]);
    expect(calls).toContainEqual(['range', [0, 2]]);
  });

  it('omits the status filter and reports hasMore=false on a short page', async () => {
    const calls = mockList([row()]);

    const result = await listEscalations({ limit: 50, offset: 100 });

    expect(result.hasMore).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(calls.some(([method]) => method === 'eq')).toBe(false);
    expect(calls).toContainEqual(['range', [100, 150]]);
  });

  it('throws on a database error instead of rendering an empty page', async () => {
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.order = () => builder;
    builder.range = () => Promise.resolve({ data: null, error: { message: 'relation missing' } });
    fromMock.mockReturnValue(builder);

    await expect(listEscalations({ limit: 50, offset: 0 })).rejects.toThrow('relation missing');
  });
});

describe('updateEscalationStatus (B0-528)', () => {
  function mockUpdate(returned: Record<string, unknown>) {
    const update = vi.fn();
    fromMock.mockReturnValue({
      update: (patch: Record<string, unknown>) => {
        update(patch);
        return {
          eq: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { ...returned, ...patch }, error: null }),
            }),
          }),
        };
      },
    });
    return update;
  }

  it('stamps resolved_at on a terminal status and stores the notes', async () => {
    const update = mockUpdate(row());

    const result = await updateEscalationStatus({
      id: row().id as string,
      status: 'resolved',
      resolutionNotes: 'Answered by phone.',
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved', resolution_notes: 'Answered by phone.' }),
    );
    expect(typeof update.mock.calls[0]?.[0]?.resolved_at).toBe('string');
    expect(result.status).toBe('resolved');
  });

  it('clears resolved_at when reopened', async () => {
    const update = mockUpdate(row({ status: 'resolved', resolved_at: '2026-10-05T19:00:00.000Z' }));

    await updateEscalationStatus({ id: row().id as string, status: 'in_review', resolutionNotes: null });

    expect(update).toHaveBeenCalledWith({
      status: 'in_review',
      resolution_notes: null,
      resolved_at: null,
    });
  });
});
