import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listGoldenTests } from './golden-set';

/**
 * B0-881 — `listGoldenTests` is the canonical golden-roster reader. Archiving a test never
 * clears `is_golden`, so the default must keep returning archived golden tests (every existing
 * caller depends on that), while `{ includeArchived: false }` must add exactly one extra
 * `is_archived = false` filter for bulk-run triggers (B0-883 "Run Golden").
 */

type ChainCall = { method: string; args: unknown[] };

function fakeSupabaseRecording(calls: ChainCall[]) {
  function chain(): Record<string, (...args: unknown[]) => unknown> {
    return {
      eq: (...args: unknown[]) => {
        calls.push({ method: 'eq', args });
        return chain();
      },
      order: (...args: unknown[]) => {
        calls.push({ method: 'order', args });
        return Promise.resolve({ data: [], error: null });
      },
    };
  }

  return {
    from: (...args: unknown[]) => {
      calls.push({ method: 'from', args });
      return {
        select: (...selectArgs: unknown[]) => {
          calls.push({ method: 'select', args: selectArgs });
          return chain();
        },
      };
    },
  };
}

let mockCalls: ChainCall[] = [];

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => fakeSupabaseRecording(mockCalls),
}));

const eqCalls = () => mockCalls.filter((c) => c.method === 'eq').map((c) => c.args);

describe('listGoldenTests (B0-881)', () => {
  beforeEach(() => {
    mockCalls = [];
  });

  it('by default filters on is_golden only and never touches is_archived', async () => {
    await listGoldenTests();

    expect(mockCalls[0]).toEqual({ method: 'from', args: ['tests'] });
    expect(eqCalls()).toEqual([['is_golden', true]]);
    expect(eqCalls().some(([column]) => column === 'is_archived')).toBe(false);
  });

  it('treats an explicit includeArchived: true exactly like the default', async () => {
    await listGoldenTests({ includeArchived: true });

    expect(eqCalls()).toEqual([['is_golden', true]]);
  });

  it('adds an is_archived = false filter when includeArchived is false', async () => {
    await listGoldenTests({ includeArchived: false });

    expect(eqCalls()).toEqual([
      ['is_golden', true],
      ['is_archived', false],
    ]);
  });
});
