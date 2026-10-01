import { beforeEach, describe, expect, it, vi } from 'vitest';

import { promoteRecommendationToOverride } from '~/lib/recommendations/promote-recommendation';
import type { RecommendationWithCandidates } from '~/lib/recommendations/recommendation-schemas';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-442 regression (AC): "Approving a freshly generated recommendation promotes into
 * public.cross_reference_override with no manual key entry." Before the fix, every web-sourced
 * candidate persisted with a null betco_product_key and `promoteRecommendationToOverride` refused
 * to promote it (see the `betcoProductKey`/`betcoTitle` guard below, unchanged by this ticket).
 * This confirms a line-representative candidate — the shape B0-442 now produces for a line-level
 * match — clears that guard and actually inserts a row, with no reviewer-typed key involved.
 */

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

function mockOverrideTable(insertedId: string) {
  const insertedRow = { id: insertedId };
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          ilike: () => ({
            ilike: () => ({
              limit: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          }),
        }),
      }),
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: insertedRow, error: null }),
        }),
      }),
    }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
}

function recommendation(
  candidateOverrides: Partial<RecommendationWithCandidates['candidates'][number]>,
): RecommendationWithCandidates {
  return {
    id: 'rec-1',
    competitorBrand: 'Acme',
    competitorProduct: 'Acme Cleaner X',
    normalizedInput: {},
    status: 'pending',
    overallConfidence: 0.9,
    thresholdUsed: 0.8,
    answerGiven: true,
    declineReason: null,
    evidence: {},
    createdBy: 'system',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    candidates: [
      {
        id: 'cand-1',
        recommendationId: 'rec-1',
        betcoProductKey: null,
        betcoProdId: null,
        betcoTitle: null,
        candidateConfidence: 0.9,
        rank: 1,
        rationale: null,
        source: {},
        createdAt: new Date().toISOString(),
        ...candidateOverrides,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('promoteRecommendationToOverride — B0-442 line-representative candidates', () => {
  it('promotes a freshly generated line-representative candidate with no manual key entry', async () => {
    mockOverrideTable('override-1');
    const rec = recommendation({
      betcoProductKey: 'REP-PK-1',
      betcoTitle: 'Green Earth Peroxide Cleaner',
      source: { via: 'web', keySource: 'line_representative', productLineKey: 'L1' },
    });

    const result = await promoteRecommendationToOverride(rec, 'cand-1', 'reviewer@betco.com');

    expect(result).toMatchObject({ promoted: true, overrideId: 'override-1', mode: 'inserted' });
  });

  it('still refuses to promote a line_only candidate with no resolvable key (unchanged guard)', async () => {
    const rec = recommendation({
      betcoProductKey: null,
      betcoTitle: 'Some Line Only Match',
      source: { via: 'web', keySource: 'line_only', productLineKey: 'L-NO-REP' },
    });

    const result = await promoteRecommendationToOverride(rec, 'cand-1', 'reviewer@betco.com');

    expect(result.promoted).toBe(false);
  });
});
