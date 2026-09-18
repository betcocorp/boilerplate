import { describe, expect, it, vi } from 'vitest';

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import {
  createRecommendation,
  fromCandidateRow,
  fromRecommendationRow,
  toCandidateInsertRows,
  toRecommendationInsertRow,
} from '~/lib/recommendations/repository';
import {
  addRecommendationCandidateInputSchema,
  createRecommendationInputSchema,
  updateRecommendationStatusInputSchema,
} from '~/lib/recommendations/recommendation-schemas';

describe('recommendation repository mappers (B0-83)', () => {
  it('maps a create input to a snake_case insert row with null/{} defaults', () => {
    const row = toRecommendationInsertRow(
      createRecommendationInputSchema.parse({
        competitorProduct: 'BNC-15',
        overallConfidence: 0.82,
        thresholdUsed: 0.8,
        answerGiven: true,
        evidence: { sources: [{ url: 'https://x' }] },
      }),
    );
    expect(row).toMatchObject({
      competitor_brand: null,
      competitor_product: 'BNC-15',
      normalized_input: {},
      status: 'pending',
      overall_confidence: 0.82,
      threshold_used: 0.8,
      answer_given: true,
      decline_reason: null,
      evidence: { sources: [{ url: 'https://x' }] },
      created_by: null,
    });
  });

  it('assigns rank by position when omitted but preserves an explicit rank', () => {
    const rows = toCandidateInsertRows('rec-1', [
      { betcoProductKey: 'A' },
      { betcoProductKey: 'B', rank: 7 },
    ]);
    expect(rows[0]).toMatchObject({ recommendation_id: 'rec-1', betco_product_key: 'A', rank: 1, source: {} });
    expect(rows[1]).toMatchObject({ betco_product_key: 'B', rank: 7 });
  });

  it('coerces PostgREST numeric-as-string + jsonb back to the domain shape', () => {
    const rec = fromRecommendationRow({
      id: '11111111-1111-4111-8111-111111111111',
      competitor_brand: null,
      competitor_product: 'BNC-15',
      normalized_input: { brand: null, productName: 'bnc 15' },
      status: 'answered',
      overall_confidence: '0.820', // numeric comes back as a string over PostgREST
      threshold_used: '0.80',
      answer_given: true,
      decline_reason: null,
      evidence: { spec: { chemistryClass: 'quat' } },
      created_by: 'system',
      created_at: '2026-07-14T00:00:00Z',
      updated_at: '2026-07-14T00:00:00Z',
    });
    expect(rec.overallConfidence).toBe(0.82);
    expect(rec.thresholdUsed).toBe(0.8);
    expect(rec.answerGiven).toBe(true);
    expect(rec.normalizedInput).toEqual({ brand: null, productName: 'bnc 15' });
    expect(rec.evidence).toEqual({ spec: { chemistryClass: 'quat' } });
  });

  it('maps a candidate row, coercing numeric confidence + rank', () => {
    const cand = fromCandidateRow({
      id: '22222222-2222-4222-8222-222222222222',
      recommendation_id: '11111111-1111-4111-8111-111111111111',
      betco_product_key: '333B5-00',
      betco_prod_id: '333',
      betco_title: 'Triforce',
      candidate_confidence: '0.910',
      rank: '1',
      rationale: 'shared EPA registrant',
      source: { via: 'web' },
      created_at: '2026-07-14T00:00:00Z',
    });
    expect(cand.candidateConfidence).toBe(0.91);
    expect(cand.rank).toBe(1);
    expect(cand.source).toEqual({ via: 'web' });
  });

  it('rejects an empty competitor product and defaults status/answerGiven', () => {
    expect(createRecommendationInputSchema.safeParse({ competitorProduct: '' }).success).toBe(false);
    const ok = createRecommendationInputSchema.parse({ competitorProduct: 'X' });
    expect(ok.status).toBe('pending');
    expect(ok.answerGiven).toBe(false);
    expect(ok.candidates).toEqual([]);
  });

  it('validates the status-update input enum', () => {
    expect(updateRecommendationStatusInputSchema.safeParse({ status: 'verified', verifier: 'tb' }).success).toBe(true);
    expect(updateRecommendationStatusInputSchema.safeParse({ status: 'nope' }).success).toBe(false);
  });
});

/**
 * B0-433 — a reviewer-added candidate exists to make an un-approvable recommendation approvable,
 * so the schema has to guarantee the two fields `promoteRecommendationToOverride` requires. Every
 * one of the 220 candidates the engine had written was missing `betcoProductKey`, which is exactly
 * how the queue ended up unable to promote anything.
 */
describe('addRecommendationCandidateInputSchema (B0-433)', () => {
  it('accepts a candidate carrying both fields promotion requires', () => {
    const parsed = addRecommendationCandidateInputSchema.parse({
      betcoTitle: 'Green Earth Peroxide Cleaner',
      betcoProductKey: '3355',
      rationale: 'Same peroxide chemistry and dilution class.',
    });
    expect(parsed.betcoTitle).toBe('Green Earth Peroxide Cleaner');
    expect(parsed.betcoProductKey).toBe('3355');
  });

  it('trims surrounding whitespace so a padded key still promotes', () => {
    const parsed = addRecommendationCandidateInputSchema.parse({
      betcoTitle: '  Green Earth Peroxide Cleaner  ',
      betcoProductKey: '  3355  ',
    });
    expect(parsed.betcoTitle).toBe('Green Earth Peroxide Cleaner');
    expect(parsed.betcoProductKey).toBe('3355');
  });

  it('rejects a missing or blank product key', () => {
    expect(() =>
      addRecommendationCandidateInputSchema.parse({ betcoTitle: 'Green Earth' }),
    ).toThrow();
    expect(() =>
      addRecommendationCandidateInputSchema.parse({
        betcoTitle: 'Green Earth',
        betcoProductKey: '   ',
      }),
    ).toThrow();
  });

  it('rejects a missing or blank title', () => {
    expect(() =>
      addRecommendationCandidateInputSchema.parse({ betcoProductKey: '3355' }),
    ).toThrow();
    expect(() =>
      addRecommendationCandidateInputSchema.parse({ betcoTitle: '  ', betcoProductKey: '3355' }),
    ).toThrow();
  });

  it('treats rationale as optional', () => {
    const parsed = addRecommendationCandidateInputSchema.parse({
      betcoTitle: 'Green Earth',
      betcoProductKey: '3355',
    });
    expect(parsed.rationale).toBeUndefined();
  });
});

/**
 * B0-1055 — dedupe by real-world competitor identity. `createRecommendation` used to always INSERT,
 * so the nightly scheduled-test sweep re-running the same golden-set prompts (e.g. "Betco's version
 * of BNC-15…") piled up duplicate rows for the same competitor product (bnc/bnc-15 x53 live). These
 * exercise the three branches against a minimal in-memory fake of the two `rag.*` tables, shaped like
 * the chains `ragTable()`/`ragIdentityTable()` build in repository.ts — including the partial unique
 * index's 23505 behavior on a duplicate not-yet-reviewed identity — so no real Supabase connection is
 * needed.
 */
describe('createRecommendation dedupe (B0-1055)', () => {
  type Row = Record<string, unknown>;

  const REVIEWED = new Set(['verified', 'rejected']);
  const normPart = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const fakeUuid = (n: number): string =>
    `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

  function withNormColumns(row: Row): Row {
    return {
      ...row,
      competitor_brand_norm: normPart((row.competitor_brand as string | null) ?? ''),
      competitor_product_norm: normPart(row.competitor_product as string),
    };
  }

  function createFakeSupabase(seedRecommendations: Row[] = [], seedCandidates: Row[] = []) {
    let recIdCounter = 1000;
    let candIdCounter = 2000;
    const recommendations: Row[] = seedRecommendations.map((r) => withNormColumns({ ...r }));
    const candidates: Row[] = seedCandidates.map((c) => ({ ...c }));

    function fromRecommendations() {
      return {
        insert(row: Row) {
          const inserted = withNormColumns({
            id: fakeUuid(++recIdCounter),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...row,
          });
          const isUnreviewed = !REVIEWED.has(String(inserted.status));
          const dup = isUnreviewed
            ? recommendations.find(
                (r) =>
                  !REVIEWED.has(String(r.status)) &&
                  r.competitor_brand_norm === inserted.competitor_brand_norm &&
                  r.competitor_product_norm === inserted.competitor_product_norm,
              )
            : undefined;
          return {
            select: () => ({
              async single() {
                if (dup) {
                  return {
                    data: null,
                    error: {
                      message: 'duplicate key value violates unique constraint "cross_reference_recommendations_identity_unreviewed_uq"',
                      code: '23505',
                    },
                  };
                }
                recommendations.push(inserted);
                return { data: { ...inserted }, error: null };
              },
            }),
          };
        },
        select: () => {
          let filtered = [...recommendations];
          const chain = {
            eq(col: string, val: unknown) {
              filtered = filtered.filter((r) => r[col] === val);
              return chain;
            },
            not(col: string, _op: string, val: string) {
              const excluded = val.replace(/^\(|\)$/, '').replace(/\)$/, '').split(',');
              filtered = filtered.filter((r) => !excluded.includes(String(r[col])));
              return chain;
            },
            order() {
              filtered = [...filtered].sort((a, b) =>
                String(b.created_at).localeCompare(String(a.created_at)),
              );
              return chain;
            },
            limit(n: number) {
              filtered = filtered.slice(0, n);
              return {
                async maybeSingle() {
                  return { data: filtered[0] ? { ...filtered[0] } : null, error: null };
                },
              };
            },
          };
          return chain;
        },
        update: (patch: Row) => ({
          eq: (col: string, val: unknown) => ({
            select: () => ({
              async single() {
                const row = recommendations.find((r) => r[col] === val);
                if (!row) return { data: null, error: { message: 'not found' } };
                Object.assign(row, patch);
                Object.assign(row, withNormColumns(row));
                return { data: { ...row }, error: null };
              },
            }),
          }),
        }),
      };
    }

    function fromCandidates() {
      return {
        insert(rows: Row | Row[]) {
          const arr = Array.isArray(rows) ? rows : [rows];
          const inserted = arr.map((r) => {
            const row = { id: fakeUuid(++candIdCounter), created_at: new Date().toISOString(), ...r };
            candidates.push(row);
            return row;
          });
          return {
            select: () => ({
              then(resolve: (v: { data: Row[]; error: null }) => void) {
                resolve({ data: inserted, error: null });
              },
            }),
          };
        },
        delete: () => ({
          eq(col: string, val: unknown) {
            for (let i = candidates.length - 1; i >= 0; i -= 1) {
              if (candidates[i]?.[col] === val) candidates.splice(i, 1);
            }
            return Promise.resolve({ error: null });
          },
        }),
      };
    }

    const client = {
      schema() {
        return {
          from(table: string) {
            if (table === 'cross_reference_recommendations') return fromRecommendations();
            if (table === 'cross_reference_recommendation_candidates') return fromCandidates();
            throw new Error(`unexpected table ${table}`);
          },
        };
      },
    };

    return { client, recommendations, candidates };
  }

  it('inserts a new row for a fresh competitor identity', async () => {
    const fake = createFakeSupabase();
    vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(fake.client as never);

    const result = await createRecommendation(
      createRecommendationInputSchema.parse({
        competitorBrand: 'BNC',
        competitorProduct: 'BNC-15',
        status: 'answered',
        answerGiven: true,
        overallConfidence: 0.9,
        candidates: [{ betcoProductKey: 'X1', rank: 1 }],
      }),
    );

    expect(fake.recommendations).toHaveLength(1);
    expect(fake.candidates).toHaveLength(1);
    expect(result.id).toBe(fake.recommendations[0]?.id);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.betcoProductKey).toBe('X1');
  });

  it('updates the existing not-yet-reviewed row for a repeat identity and replaces its candidates', async () => {
    const existingId = fakeUuid(1);
    const fake = createFakeSupabase(
      [
        {
          id: existingId,
          competitor_brand: 'BNC',
          competitor_product: 'BNC-15',
          status: 'pending',
          overall_confidence: null,
          threshold_used: null,
          answer_given: false,
          decline_reason: null,
          evidence: {},
          normalized_input: {},
          created_by: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      [
        {
          id: fakeUuid(2),
          recommendation_id: existingId,
          betco_product_key: 'OLD',
          betco_prod_id: null,
          betco_title: 'Old candidate',
          candidate_confidence: null,
          rank: 1,
          rationale: null,
          source: {},
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    );
    vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(fake.client as never);

    const result = await createRecommendation(
      createRecommendationInputSchema.parse({
        // Different case/whitespace than the seeded row — must still match the same normalized identity.
        competitorBrand: ' bnc ',
        competitorProduct: 'bnc-15',
        status: 'answered',
        answerGiven: true,
        overallConfidence: 0.95,
        candidates: [{ betcoProductKey: 'NEW', rank: 1 }],
      }),
    );

    // No new row — the seeded row was updated in place.
    expect(fake.recommendations).toHaveLength(1);
    expect(result.id).toBe(existingId);
    expect(result.status).toBe('answered');
    expect(result.overallConfidence).toBe(0.95);
    // created_at bumped so the row keeps sorting first under ORDER BY created_at DESC.
    expect(result.createdAt).not.toBe('2026-01-01T00:00:00.000Z');

    // Candidates replaced wholesale, not merged.
    expect(fake.candidates).toHaveLength(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.betcoProductKey).toBe('NEW');
  });

  it('never overwrites a verified/rejected row — a repeat identity there still inserts a new row', async () => {
    const verifiedId = fakeUuid(1);
    const fake = createFakeSupabase([
      {
        id: verifiedId,
        competitor_brand: 'BNC',
        competitor_product: 'BNC-15',
        status: 'verified',
        overall_confidence: 0.9,
        threshold_used: 0.8,
        answer_given: true,
        decline_reason: null,
        evidence: {},
        normalized_input: {},
        created_by: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(fake.client as never);

    const result = await createRecommendation(
      createRecommendationInputSchema.parse({
        competitorBrand: 'BNC',
        competitorProduct: 'BNC-15',
        status: 'answered',
        answerGiven: true,
        candidates: [{ betcoProductKey: 'X2', rank: 1 }],
      }),
    );

    // A second row now exists alongside the untouched verified one.
    expect(fake.recommendations).toHaveLength(2);
    expect(result.id).not.toBe(verifiedId);
    const verifiedRow = fake.recommendations.find((r) => r.id === verifiedId);
    expect(verifiedRow?.status).toBe('verified');
    expect(verifiedRow?.overall_confidence).toBe(0.9);
  });
});
