import { describe, expect, it, vi } from 'vitest';

/**
 * B0-492 — `computeAvgJudgmentConfidenceForResult` must average ONLY `validator_judged` items,
 * excluding decline-gate constants, bypass heuristics, agent self-scores, and gate-capped values
 * — the whole point being CI's `avg_confidence` gate stops mixing a regex constant with a model
 * judgment.
 *
 * B0-495 — the exclusion is now done SERVER-SIDE via `.in('confidence_provenance', [...])` against
 * the generated `confidence_provenance` column (proven indexed by a live `EXPLAIN` during that
 * ticket's work — see the migration/PR notes), not by fetching every row's `response_payload` and
 * filtering in JS. This test therefore exercises the query-building (the right filters are chained
 * in the right order) and the pagination/averaging logic; it does not re-prove the exclusion
 * itself, since these `mockRows` stand in for what Postgres would already have filtered down to.
 */

type Row = { confidence: number | null };

type ChainCall = { method: string; args: unknown[] };

function fakeSupabaseReturning(rows: Row[], calls: ChainCall[]) {
  function chain(): Record<string, (...args: unknown[]) => unknown> {
    const node = {
      eq: (...args: unknown[]) => {
        calls.push({ method: 'eq', args });
        return chain();
      },
      in: (...args: unknown[]) => {
        calls.push({ method: 'in', args });
        return chain();
      },
      not: (...args: unknown[]) => {
        calls.push({ method: 'not', args });
        return chain();
      },
      range: async (...args: unknown[]) => {
        calls.push({ method: 'range', args });
        return { data: rows, error: null };
      },
    };
    return node;
  }

  return {
    from: () => ({
      select: (...args: unknown[]) => {
        calls.push({ method: 'select', args });
        return chain();
      },
    }),
  };
}

let mockRows: Row[] = [];
let mockCalls: ChainCall[] = [];

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => fakeSupabaseReturning(mockRows, mockCalls),
}));

import { computeAvgJudgmentConfidenceForResult } from '~/lib/tests/repository';

describe('computeAvgJudgmentConfidenceForResult (B0-492 / B0-495)', () => {
  it('averages the (already server-filtered) confidence values and reports the item count', async () => {
    mockRows = [{ confidence: 0.9 }, { confidence: 0.6 }];
    mockCalls = [];

    const result = await computeAvgJudgmentConfidenceForResult('result-1');

    expect(result.itemCount).toBe(2);
    expect(result.avg).toBeCloseTo((0.9 + 0.6) / 2, 10);
  });

  it('filters on the generated confidence_provenance column, only the judgment set, selecting only `confidence`', async () => {
    mockRows = [{ confidence: 0.9 }];
    mockCalls = [];

    await computeAvgJudgmentConfidenceForResult('result-1');

    expect(mockCalls[0]).toEqual({ method: 'select', args: ['confidence'] });
    expect(mockCalls.some((c) => c.method === 'eq' && c.args[0] === 'test_result_id')).toBe(true);
    expect(
      mockCalls.some(
        (c) =>
          c.method === 'in' &&
          c.args[0] === 'confidence_provenance' &&
          Array.isArray(c.args[1]) &&
          (c.args[1] as string[]).includes('validator_judged'),
      ),
    ).toBe(true);
    expect(mockCalls.some((c) => c.method === 'not' && c.args[0] === 'confidence')).toBe(true);
  });

  it('returns null/0 for an empty (already-filtered) result set', async () => {
    mockRows = [];
    mockCalls = [];
    const result = await computeAvgJudgmentConfidenceForResult('result-2');
    expect(result).toEqual({ avg: null, itemCount: 0 });
  });

  it('ignores a row whose confidence somehow came back null despite the not-null filter', async () => {
    mockRows = [{ confidence: 0.8 }, { confidence: null }];
    mockCalls = [];
    const result = await computeAvgJudgmentConfidenceForResult('result-3');
    expect(result).toEqual({ avg: 0.8, itemCount: 1 });
  });
});
