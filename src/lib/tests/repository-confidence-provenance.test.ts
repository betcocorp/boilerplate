import { describe, expect, it, vi } from 'vitest';

/**
 * B0-492 — `computeAvgJudgmentConfidenceForResult` must average ONLY `validator_judged` items,
 * excluding decline-gate constants, bypass heuristics, agent self-scores, and gate-capped values
 * — the whole point being CI's `avg_confidence` gate stops mixing a regex constant with a model
 * judgment. A minimal chainable Supabase fake (select/eq/in/range) is enough to exercise the real
 * pagination + filtering logic without a live database.
 */

type Row = { response_payload: unknown };

function fakeSupabaseReturning(rows: Row[]) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => ({
            range: async () => ({ data: rows, error: null }),
          }),
        }),
      }),
    }),
  };
}

let mockRows: Row[] = [];

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => fakeSupabaseReturning(mockRows),
}));

import { computeAvgJudgmentConfidenceForResult } from '~/lib/tests/repository';

describe('computeAvgJudgmentConfidenceForResult (B0-492)', () => {
  it('averages only validator_judged items, ignoring every other provenance', () => {
    mockRows = [
      { response_payload: { confidence: 0.9, confidenceProvenance: 'validator_judged' } },
      { response_payload: { confidence: 0.6, confidenceProvenance: 'validator_judged' } },
      // These must NOT count toward the average or the item count:
      { response_payload: { confidence: 0.92, confidenceProvenance: 'decline_gate_constant' } },
      { response_payload: { confidence: 0.9, confidenceProvenance: 'validator_bypassed_heuristic' } },
      { response_payload: { confidence: 0.62, confidenceProvenance: 'agent_self_scored' } },
      { response_payload: { confidence: 0.2, confidenceProvenance: 'gate_capped' } },
    ];

    return computeAvgJudgmentConfidenceForResult('result-1').then((result) => {
      expect(result.itemCount).toBe(2);
      expect(result.avg).toBeCloseTo((0.9 + 0.6) / 2, 10);
    });
  });

  it('returns null/0 when no item has judgment provenance', async () => {
    mockRows = [
      { response_payload: { confidence: 0.9, confidenceProvenance: 'validator_bypassed_heuristic' } },
      { response_payload: { confidence: 0.92, confidenceProvenance: 'decline_gate_constant' } },
    ];

    const result = await computeAvgJudgmentConfidenceForResult('result-2');
    expect(result).toEqual({ avg: null, itemCount: 0 });
  });

  it('treats a missing/legacy provenance as unknown, never counted as judgment', async () => {
    mockRows = [
      { response_payload: { confidence: 0.85 } }, // no confidenceProvenance at all
    ];

    const result = await computeAvgJudgmentConfidenceForResult('result-3');
    expect(result).toEqual({ avg: null, itemCount: 0 });
  });

  it('returns null/0 for an empty result set', async () => {
    mockRows = [];
    const result = await computeAvgJudgmentConfidenceForResult('result-4');
    expect(result).toEqual({ avg: null, itemCount: 0 });
  });
});
