import { describe, expect, it, vi } from 'vitest';

import {
  mapResultToRecommendationInput,
  persistRecommendation,
  runCrossReferenceRecommendation,
} from '~/lib/recommendations/persist-recommendation';
import type { RecommendCrossReferenceResult } from '~/lib/recommendations/recommend-cross-reference';
import type { RecommendationWithCandidates } from '~/lib/recommendations/recommendation-schemas';

const answered: RecommendCrossReferenceResult = {
  source: 'web',
  answered: true,
  status: 'answered',
  overallConfidence: 0.86,
  thresholdUsed: 0.8,
  candidates: [
    { betcoProductKey: 'PK1', betcoProdId: null, betcoTitle: 'Triforce', confidence: 0.9, rank: 1, url: 'https://betco.com/x', rationale: null, source: { via: 'web' }, tier: 'primary' },
  ],
  evidence: { source: 'web', sources: [{ url: 'https://a' }] },
  declineReason: null,
};

const declined: RecommendCrossReferenceResult = {
  ...answered,
  answered: false,
  status: 'declined',
  overallConfidence: 0.6,
  declineReason: 'Not confident enough — contact a rep.',
  candidates: [],
};

const input = { competitorProduct: 'BNC-15', competitorBrand: 'Spartan' };

describe('mapResultToRecommendationInput (B0-89)', () => {
  it('maps an answered result to status=answered with mapped candidates + trace id', () => {
    const mapped = mapResultToRecommendationInput(input, answered, { traceId: 't-1', createdBy: 'system' });
    expect(mapped).toMatchObject({
      competitorBrand: 'Spartan',
      competitorProduct: 'BNC-15',
      status: 'answered',
      overallConfidence: 0.86,
      thresholdUsed: 0.8,
      answerGiven: true,
      declineReason: null,
    });
    expect(mapped.evidence).toMatchObject({ traceId: 't-1', source: 'web' });
    expect(mapped.candidates).toHaveLength(1);
    expect(mapped.candidates[0]).toMatchObject({ betcoProductKey: 'PK1', candidateConfidence: 0.9, rank: 1 });
  });

  it('maps a decline to status=declined with the decline reason (still persisted)', () => {
    const mapped = mapResultToRecommendationInput(input, declined, { traceId: 't-2', createdBy: 'system' });
    expect(mapped.status).toBe('declined');
    expect(mapped.answerGiven).toBe(false);
    expect(mapped.declineReason).toBe('Not confident enough — contact a rep.');
    expect(mapped.candidates).toEqual([]);
  });
});

describe('persistRecommendation is best-effort (B0-89)', () => {
  it('returns the new id on success', async () => {
    const create = vi.fn(async () => ({ id: 'rec-123' }) as unknown as RecommendationWithCandidates);
    const id = await persistRecommendation(input, answered, { traceId: 't' }, { createRecommendation: create });
    expect(id).toBe('rec-123');
    expect(create).toHaveBeenCalledOnce();
  });

  it('never throws and returns null when the write fails', async () => {
    const create = vi.fn(async () => {
      throw new Error('db down');
    });
    const id = await persistRecommendation(input, answered, { traceId: 't' }, { createRecommendation: create });
    expect(id).toBeNull();
  });
});

describe('runCrossReferenceRecommendation (B0-89)', () => {
  it('returns the result even when persistence fails, tagged with recommendationId', async () => {
    const legacyConfident = {
      ok: true,
      fallbackRecommended: false,
      normalizedInput: {},
      totalCandidates: 1,
      matches: [{ productKey: 'PK', betcoProduct: { title: 'T' }, confidence: 0.9, matchType: 'exact' }],
    } as never;
    const out = await runCrossReferenceRecommendation(
      input,
      { traceId: 't' },
      {
        recommend: {
          lookupInternal: async () => legacyConfident,
          searchWeb: async () => { throw new Error('no web'); },
          enrich: async () => { throw new Error('no enrich'); },
          retrieve: async () => [],
          filterGrounded: async (cands) => ({ grounded: cands, dropped: [] }),
          validate: async () => ({ approved: true, confidence: 1, issues: [], requires_human_review: false }),
        },
        persist: { createRecommendation: async () => { throw new Error('db down'); } },
        audit: async () => {},
      },
    );
    expect(out.source).toBe('legacy');
    expect(out.answered).toBe(true);
    expect(out.recommendationId).toBeNull(); // persistence failed but the call still returned
  });

  it('records a per-recommendation cost audit entry (B0-92)', async () => {
    const legacyConfident = {
      ok: true,
      fallbackRecommended: false,
      normalizedInput: {},
      totalCandidates: 1,
      matches: [{ productKey: 'PK', betcoProduct: { title: 'T' }, confidence: 0.9, matchType: 'exact' }],
    } as never;
    const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    await runCrossReferenceRecommendation(
      input,
      { traceId: 't' },
      {
        recommend: {
          lookupInternal: async () => legacyConfident,
          searchWeb: async () => { throw new Error('no web'); },
          enrich: async () => { throw new Error('no enrich'); },
          retrieve: async () => [],
          filterGrounded: async (cands) => ({ grounded: cands, dropped: [] }),
          validate: async () => ({ approved: true, confidence: 1, issues: [], requires_human_review: false }),
        },
        persist: { createRecommendation: async () => ({ id: 'rec-9' }) as unknown as RecommendationWithCandidates },
        audit: async (eventType, payload) => { events.push({ eventType, payload }); },
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('cross_reference_recommendation');
    expect(events[0].payload).toMatchObject({ recommendation_id: 'rec-9', source: 'legacy', status: 'answered' });
  });
});
