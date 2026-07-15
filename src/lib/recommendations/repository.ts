import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import {
  createRecommendationInputSchema,
  listRecommendationsInputSchema,
  recommendationCandidateSchema,
  recommendationSchema,
  recommendationWithCandidatesSchema,
  updateRecommendationStatusInputSchema,
  type CreateRecommendationInput,
  type ListRecommendationsInput,
  type Recommendation,
  type RecommendationCandidate,
  type RecommendationWithCandidates,
  type UpdateRecommendationStatusInput,
} from '~/lib/recommendations/recommendation-schemas';

/**
 * B0-83 — typed data-access layer for cross-reference recommendations (rag.* tables from B0-82).
 * Mirrors the `src/lib/conversations/*` repository pattern: plain async functions over the
 * service-role client, Zod-validated at every boundary. The snake_case↔camelCase mappers are pure
 * and unit-tested.
 */

type Json = Record<string, unknown>;
type LooseRow = Record<string, unknown>;

/** Loose accessor for the rag tables (mappers + Zod provide the real type safety). */
function ragTable(table: string) {
  const sb = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: string) => {
      from: (t: string) => {
        insert: (rows: LooseRow | LooseRow[]) => {
          select: (cols?: string) => {
            single: () => Promise<{ data: LooseRow | null; error: { message: string } | null }>;
          } & PromiseLike<{ data: LooseRow[] | null; error: { message: string } | null }>;
        };
        select: (cols?: string) => {
          eq: (c: string, v: unknown) => {
            order: (
              c: string,
              o: { ascending: boolean },
            ) => PromiseLike<{ data: LooseRow[] | null; error: { message: string } | null }>;
            maybeSingle: () => Promise<{ data: LooseRow | null; error: { message: string } | null }>;
          } & PromiseLike<{ data: LooseRow[] | null; error: { message: string } | null }>;
          gte: (c: string, v: unknown) => LooseChain;
          order: (c: string, o: { ascending: boolean }) => LooseChain;
        };
        update: (row: LooseRow) => {
          eq: (c: string, v: unknown) => {
            select: (cols?: string) => {
              single: () => Promise<{ data: LooseRow | null; error: { message: string } | null }>;
            };
          };
        };
      };
    };
  };
  return sb.schema('rag').from(table);
}

type LooseChain = {
  eq: (c: string, v: unknown) => LooseChain;
  gte: (c: string, v: unknown) => LooseChain;
  order: (c: string, o: { ascending: boolean }) => LooseChain;
  range: (from: number, to: number) => LooseChain;
} & PromiseLike<{ data: LooseRow[] | null; error: { message: string } | null }>;

function asJson(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' ? v : v == null ? null : Number(v);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// --- pure mappers (unit-tested) ---

export function toRecommendationInsertRow(input: CreateRecommendationInput): LooseRow {
  return {
    competitor_brand: input.competitorBrand ?? null,
    competitor_product: input.competitorProduct,
    normalized_input: input.normalizedInput ?? {},
    status: input.status,
    overall_confidence: input.overallConfidence ?? null,
    threshold_used: input.thresholdUsed ?? null,
    answer_given: input.answerGiven,
    decline_reason: input.declineReason ?? null,
    evidence: input.evidence ?? {},
    created_by: input.createdBy ?? null,
  };
}

export function toCandidateInsertRows(
  recommendationId: string,
  candidates: CreateRecommendationInput['candidates'],
): LooseRow[] {
  return candidates.map((c, index) => ({
    recommendation_id: recommendationId,
    betco_product_key: c.betcoProductKey ?? null,
    betco_prod_id: c.betcoProdId ?? null,
    betco_title: c.betcoTitle ?? null,
    candidate_confidence: c.candidateConfidence ?? null,
    rank: c.rank ?? index + 1,
    rationale: c.rationale ?? null,
    source: c.source ?? {},
  }));
}

export function fromRecommendationRow(row: LooseRow): Recommendation {
  return recommendationSchema.parse({
    id: row.id,
    competitorBrand: strOrNull(row.competitor_brand),
    competitorProduct: String(row.competitor_product ?? ''),
    normalizedInput: asJson(row.normalized_input),
    status: row.status,
    overallConfidence: numOrNull(row.overall_confidence),
    thresholdUsed: numOrNull(row.threshold_used),
    answerGiven: Boolean(row.answer_given),
    declineReason: strOrNull(row.decline_reason),
    evidence: asJson(row.evidence),
    createdBy: strOrNull(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
}

export function fromCandidateRow(row: LooseRow): RecommendationCandidate {
  return recommendationCandidateSchema.parse({
    id: row.id,
    recommendationId: row.recommendation_id,
    betcoProductKey: strOrNull(row.betco_product_key),
    betcoProdId: strOrNull(row.betco_prod_id),
    betcoTitle: strOrNull(row.betco_title),
    candidateConfidence: numOrNull(row.candidate_confidence),
    rank: row.rank == null ? null : Number(row.rank),
    rationale: strOrNull(row.rationale),
    source: asJson(row.source),
    createdAt: String(row.created_at),
  });
}

// --- async repository ---

export async function createRecommendation(
  rawInput: CreateRecommendationInput,
): Promise<RecommendationWithCandidates> {
  const input = createRecommendationInputSchema.parse(rawInput);

  const recRes = await ragTable('cross_reference_recommendations')
    .insert(toRecommendationInsertRow(input))
    .select('*')
    .single();
  if (recRes.error || !recRes.data) {
    throw new Error(`createRecommendation failed: ${recRes.error?.message ?? 'no row returned'}`);
  }
  const recommendation = fromRecommendationRow(recRes.data);

  let candidates: RecommendationCandidate[] = [];
  if (input.candidates.length > 0) {
    const candRes = await ragTable('cross_reference_recommendation_candidates')
      .insert(toCandidateInsertRows(recommendation.id, input.candidates))
      .select('*');
    if (candRes.error) {
      throw new Error(`createRecommendation candidates failed: ${candRes.error.message}`);
    }
    candidates = (candRes.data ?? [])
      .map(fromCandidateRow)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  }

  return recommendationWithCandidatesSchema.parse({ ...recommendation, candidates });
}

export async function getRecommendation(id: string): Promise<RecommendationWithCandidates | null> {
  const recRes = await ragTable('cross_reference_recommendations')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (recRes.error) throw new Error(`getRecommendation failed: ${recRes.error.message}`);
  if (!recRes.data) return null;

  const candRes = await ragTable('cross_reference_recommendation_candidates')
    .select('*')
    .eq('recommendation_id', id)
    .order('rank', { ascending: true });
  if (candRes.error) throw new Error(`getRecommendation candidates failed: ${candRes.error.message}`);

  return recommendationWithCandidatesSchema.parse({
    ...fromRecommendationRow(recRes.data),
    candidates: (candRes.data ?? []).map(fromCandidateRow),
  });
}

export async function listRecommendations(
  rawInput: ListRecommendationsInput = { page: 1, pageSize: 50 },
): Promise<{ items: Recommendation[]; page: number; pageSize: number }> {
  const input = listRecommendationsInputSchema.parse(rawInput);
  let query = ragTable('cross_reference_recommendations').select('*') as unknown as LooseChain;
  if (input.status) query = query.eq('status', input.status);
  if (input.minConfidence != null) query = query.gte('overall_confidence', input.minConfidence);
  const from = (input.page - 1) * input.pageSize;
  const res = await query.order('created_at', { ascending: false }).range(from, from + input.pageSize - 1);
  if (res.error) throw new Error(`listRecommendations failed: ${res.error.message}`);
  return {
    items: (res.data ?? []).map(fromRecommendationRow),
    page: input.page,
    pageSize: input.pageSize,
  };
}

export async function updateRecommendationStatus(
  id: string,
  rawInput: UpdateRecommendationStatusInput,
): Promise<Recommendation> {
  const input = updateRecommendationStatusInputSchema.parse(rawInput);

  // Record the human verifier + note in evidence.verification (no dedicated columns).
  const existing = await getRecommendation(id);
  if (!existing) throw new Error(`updateRecommendationStatus: recommendation ${id} not found`);
  const evidence: Json = {
    ...existing.evidence,
    verification: {
      verifier: input.verifier ?? null,
      note: input.note ?? null,
      status: input.status,
      at: new Date().toISOString(),
    },
  };

  const res = await ragTable('cross_reference_recommendations')
    .update({ status: input.status, evidence, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (res.error || !res.data) {
    throw new Error(`updateRecommendationStatus failed: ${res.error?.message ?? 'no row'}`);
  }
  return fromRecommendationRow(res.data);
}
