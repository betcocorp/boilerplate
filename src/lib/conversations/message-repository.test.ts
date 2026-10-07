import { beforeEach, describe, expect, it, vi } from 'vitest';

import { insertMessage } from '~/lib/conversations/message-repository';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

type StubOptions = {
  /** The row the insert resolves with (Postgres-stamped `created_at` comes back on it). */
  insertedRow: Record<string, unknown>;
  /** Result of the prior-message lookup; `error` simulates a failed lookup. */
  priorLookup?: { data: unknown; error: { message: string } | null };
  /** Error for the metric UPDATE, when simulating a failed stamp. */
  updateError?: { message: string } | null;
};

/**
 * Records the three shapes `insertMessage` drives:
 *   insert(...).select().single()
 *   select(...).eq().eq().lte().order().limit().maybeSingle()
 *   update(...).eq()
 */
function useClient(options: StubOptions) {
  const calls = {
    updates: [] as Array<{ patch: Record<string, unknown>; id: unknown }>,
    lookupFilters: [] as Array<Record<string, unknown>>,
  };

  const from = () => ({
    insert: () => ({
      select: () => ({
        single: () => Promise.resolve({ data: options.insertedRow, error: null }),
      }),
    }),
    select: () => {
      const filters: Record<string, unknown> = {};
      const builder = {
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        lte: (column: string, value: unknown) => {
          filters[`lte:${column}`] = value;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => {
          calls.lookupFilters.push(filters);
          return Promise.resolve(options.priorLookup ?? { data: null, error: null });
        },
      };
      return builder;
    },
    update: (patch: Record<string, unknown>) => ({
      eq: (_column: string, id: unknown) => {
        calls.updates.push({ patch, id });
        return Promise.resolve({ error: options.updateError ?? null });
      },
    }),
  });

  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    from,
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);

  return calls;
}

function insertedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-2',
    conversation_id: 'conv-1',
    role: 'user',
    content: {},
    plain_text: 'follow-up',
    openai_response_id: null,
    tool_name: null,
    created_at: '2026-08-17T12:00:30.000Z',
    user_pause_ms: null,
    processing_ms: null,
    pause_tier: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * B0-532 — the repository is the single funnel for both message roles, so the split is stamped
 * here: user rows get `user_pause_ms` (back to the previous assistant message), assistant rows get
 * `processing_ms` (back to the triggering user message). Metrics are best-effort — no failure in
 * the stamping path may fail the message write.
 */
describe('insertMessage turn metrics', () => {
  it('stamps user_pause_ms on a user message from the previous assistant message', async () => {
    const calls = useClient({
      insertedRow: insertedRow(),
      priorLookup: { data: { created_at: '2026-08-17T12:00:23.000Z' }, error: null },
    });

    const row = await insertMessage({
      conversation_id: 'conv-1',
      role: 'user',
      plain_text: 'follow-up',
    });

    expect(calls.lookupFilters).toEqual([
      {
        conversation_id: 'conv-1',
        role: 'assistant',
        'lte:created_at': '2026-08-17T12:00:30.000Z',
      },
    ]);
    expect(calls.updates).toEqual([{ patch: { user_pause_ms: 7_000 }, id: 'msg-2' }]);
    expect(row.user_pause_ms).toBe(7_000);
    expect(row.processing_ms).toBeNull();
  });

  it('stamps processing_ms on an assistant message from the triggering user message', async () => {
    const calls = useClient({
      insertedRow: insertedRow({
        role: 'assistant',
        created_at: '2026-08-17T12:00:41.500Z',
      }),
      priorLookup: { data: { created_at: '2026-08-17T12:00:30.000Z' }, error: null },
    });

    const row = await insertMessage({ conversation_id: 'conv-1', role: 'assistant' });

    expect(calls.lookupFilters[0]?.role).toBe('user');
    expect(calls.updates).toEqual([{ patch: { processing_ms: 11_500 }, id: 'msg-2' }]);
    expect(row.processing_ms).toBe(11_500);
  });

  it('clamps a skewed negative span to 0 rather than skipping the stamp', async () => {
    const calls = useClient({
      insertedRow: insertedRow({
        role: 'assistant',
        created_at: '2026-08-17T12:00:29.900Z',
      }),
      // Prior user message stamped 100ms *after* the assistant row — clock skew shape.
      priorLookup: { data: { created_at: '2026-08-17T12:00:30.000Z' }, error: null },
    });

    const row = await insertMessage({ conversation_id: 'conv-1', role: 'assistant' });

    expect(calls.updates).toEqual([{ patch: { processing_ms: 0 }, id: 'msg-2' }]);
    expect(row.processing_ms).toBe(0);
  });

  it('leaves user_pause_ms null on the first turn of a conversation', async () => {
    const calls = useClient({
      insertedRow: insertedRow(),
      priorLookup: { data: null, error: null },
    });

    const row = await insertMessage({ conversation_id: 'conv-1', role: 'user' });

    expect(calls.updates).toEqual([]);
    expect(row.user_pause_ms).toBeNull();
  });

  it('does not meter tool messages', async () => {
    const calls = useClient({
      insertedRow: insertedRow({ role: 'tool', tool_name: 'search_products' }),
    });

    const row = await insertMessage({
      conversation_id: 'conv-1',
      role: 'tool',
      tool_name: 'search_products',
    });

    expect(calls.lookupFilters).toEqual([]);
    expect(calls.updates).toEqual([]);
    expect(row.user_pause_ms).toBeNull();
    expect(row.processing_ms).toBeNull();
  });

  it('respects a caller-supplied metric instead of recomputing it', async () => {
    const calls = useClient({
      insertedRow: insertedRow({ user_pause_ms: 1_234 }),
    });

    const row = await insertMessage({
      conversation_id: 'conv-1',
      role: 'user',
      user_pause_ms: 1_234,
    });

    expect(calls.lookupFilters).toEqual([]);
    expect(calls.updates).toEqual([]);
    expect(row.user_pause_ms).toBe(1_234);
  });

  it('still returns the inserted message when the metric lookup fails', async () => {
    useClient({
      insertedRow: insertedRow(),
      priorLookup: { data: null, error: { message: 'lookup boom' } },
    });

    const row = await insertMessage({ conversation_id: 'conv-1', role: 'user' });

    expect(row.id).toBe('msg-2');
    expect(row.user_pause_ms).toBeNull();
  });

  it('still returns the inserted message when the metric update fails', async () => {
    useClient({
      insertedRow: insertedRow(),
      priorLookup: { data: { created_at: '2026-08-17T12:00:23.000Z' }, error: null },
      updateError: { message: 'update boom' },
    });

    const row = await insertMessage({ conversation_id: 'conv-1', role: 'user' });

    expect(row.id).toBe('msg-2');
    expect(row.user_pause_ms).toBeNull();
  });
});
