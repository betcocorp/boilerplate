import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import {
  addRecommendationCandidateInputSchema,
  createRecommendationInputSchema,
  listRecommendationsInputSchema,
  recommendationCandidateSchema,
  recommendationSchema,
  recommendationWithCandidatesSchema,
  updateRecommendationCandidateInputSchema,
  updateRecommendationCompetitorInputSchema,
  updateRecommendationStatusInputSchema,
  type AddRecommendationCandidateInput,
  type CreateRecommendationInput,
  type ListRecommendationsInput,
  type Recommendation,
  type RecommendationCandidate,
  type RecommendationStatus,
  type RecommendationWithCandidates,
  type UpdateRecommendationCandidateInput,
  type UpdateRecommendationCompetitorInput,
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

type LooseCountChain = {
  eq: (c: string, v: unknown) => LooseCountChain;
  gte: (c: string, v: unknown) => LooseCountChain;
} & PromiseLike<{ count: number | null; error: { message: string } | null }>;

/** `select(cols, { count: 'exact', head: true })` accessor for cheap row counts (rag schema). */
function ragCountTable(table: string) {
  const sb = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: string) => {
      from: (t: string) => {
        select: (cols: string, opts: { count: 'exact'; head: true }) => LooseCountChain;
      };
    };
  };
  return sb.schema('rag').from(table).select('id', { count: 'exact', head: true });
}

type LooseErr = { message: string; code?: string };

type LooseIdentityChain = {
  eq: (c: string, v: unknown) => LooseIdentityChain;
  not: (c: string, op: string, v: unknown) => LooseIdentityChain;
  order: (c: string, o: { ascending: boolean }) => LooseIdentityChain;
  limit: (n: number) => {
    maybeSingle: () => Promise<{ data: LooseRow | null; error: LooseErr | null }>;
  };
};

/**
 * B0-1055 — loose accessor for the competitor-identity dedupe queries below (lookup/update/delete).
 * The generated `competitor_brand_norm` / `competitor_product_norm` columns (migration
 * `cross_reference_recommendations_dedupe`) aren't in the generated Supabase types yet — regenerating
 * needs CLI auth not available here (see AGENTS.md "Supabase types") — and these queries need
 * multi-column `.eq()` + `.not('status', 'in', …)` filtering and `.delete()`, which `ragTable()` above
 * doesn't expose. Same pattern as `ragTable`/`ragCountTable`, just shaped for these calls; the Zod
 * mappers still provide the real type safety on the way out.
 */
function ragIdentityTable(table: string) {
  const sb = getSupabaseServiceRoleClient() as unknown as {
    schema: (s: string) => {
      from: (t: string) => {
        select: (cols?: string) => LooseIdentityChain;
        update: (row: LooseRow) => {
          eq: (c: string, v: unknown) => {
            select: (cols?: string) => {
              single: () => Promise<{ data: LooseRow | null; error: LooseErr | null }>;
            };
          };
        };
        delete: () => {
          eq: (c: string, v: unknown) => Promise<{ error: LooseErr | null }>;
        };
      };
    };
  };
  return sb.schema('rag').from(table);
}

/** B0-1055 — mirrors the SQL generated columns exactly: lower(trim(coalesce(value, ''))). */
function normalizeIdentityPart(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** Statuses `cross_reference_recommendations_identity_unreviewed_uq` excludes — permanent human decisions. */
const REVIEWED_STATUSES: RecommendationStatus[] = ['verified', 'rejected'];

/**
 * B0-1055 — find an existing not-yet-reviewed row with the same normalized competitor identity, so
 * `createRecommendation` can upsert instead of always inserting. The nightly scheduled-test sweep
 * re-runs the same golden-set prompts (e.g. "Betco's version of BNC-15…") every night, and without
 * this check each run added a brand-new row for the same real-world competitor product. Mirrors the
 * partial unique index `cross_reference_recommendations_identity_unreviewed_uq`
 * (competitor_brand_norm, competitor_product_norm) WHERE status NOT IN ('verified', 'rejected').
 */
async function findExistingUnreviewedRecommendationId(
  brandNorm: string,
  productNorm: string,
): Promise<string | null> {
  const res = await ragIdentityTable('cross_reference_recommendations')
    .select('id')
    .eq('competitor_brand_norm', brandNorm)
    .eq('competitor_product_norm', productNorm)
    .not('status', 'in', `(${REVIEWED_STATUSES.join(',')})`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (res.error) {
    throw new Error(`createRecommendation identity lookup failed: ${res.error.message}`);
  }
  const id = res.data?.id;
  return typeof id === 'string' ? id : null;
}

/**
 * B0-1055 — update path for a repeat competitor identity: refreshes the recommendation's engine
 * output and bumps `created_at` (so it keeps sorting first under the review queue's existing
 * `ORDER BY created_at DESC`), then replaces its candidates wholesale — matching what a fresh insert
 * would have produced, rather than merging with the stale set from the prior run.
 */
async function updateExistingRecommendation(
  id: string,
  input: CreateRecommendationInput,
): Promise<RecommendationWithCandidates> {
  const now = new Date().toISOString();
  const recRes = await ragIdentityTable('cross_reference_recommendations')
    .update({
      status: input.status,
      overall_confidence: input.overallConfidence ?? null,
      threshold_used: input.thresholdUsed ?? null,
      answer_given: input.answerGiven,
      decline_reason: input.declineReason ?? null,
      evidence: input.evidence ?? {},
      normalized_input: input.normalizedInput ?? {},
      updated_at: now,
      created_at: now,
    })
    .eq('id', id)
    .select('*')
    .single();
  if (recRes.error || !recRes.data) {
    throw new Error(`createRecommendation update failed: ${recRes.error?.message ?? 'no row returned'}`);
  }
  const recommendation = fromRecommendationRow(recRes.data);

  const delRes = await ragIdentityTable('cross_reference_recommendation_candidates')
    .delete()
    .eq('recommendation_id', id);
  if (delRes.error) {
    throw new Error(`createRecommendation candidate replace failed: ${delRes.error.message}`);
  }

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

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

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

  // B0-1055 — dedupe by real-world competitor identity: the nightly scheduled-test sweep re-runs the
  // same golden-set prompts, so update the existing not-yet-reviewed row for this identity instead of
  // inserting a duplicate. A verified/rejected row is a permanent human decision and never matches
  // here, so it always falls through to a fresh insert below.
  const brandNorm = normalizeIdentityPart(input.competitorBrand);
  const productNorm = normalizeIdentityPart(input.competitorProduct);
  const existingId = await findExistingUnreviewedRecommendationId(brandNorm, productNorm);
  if (existingId) {
    return updateExistingRecommendation(existingId, input);
  }

  const recRes = await ragTable('cross_reference_recommendations')
    .insert(toRecommendationInsertRow(input))
    .select('*')
    .single();
  if (recRes.error || !recRes.data) {
    // Safety net for a concurrent race: two callers both miss the identity lookup above, then both
    // try to insert; the partial unique index (cross_reference_recommendations_dedupe_index) lets
    // exactly one insert win, and the loser hits 23505 here instead of surfacing a raw DB error.
    if ((recRes.error as unknown as LooseErr | null)?.code === '23505') {
      const raceId = await findExistingUnreviewedRecommendationId(brandNorm, productNorm);
      if (raceId) {
        return updateExistingRecommendation(raceId, input);
      }
    }
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

/** Row count for the recommendations table, honoring the same status/minConfidence filters as `listRecommendations`. */
export async function countRecommendations(
  filter: { status?: RecommendationStatus; minConfidence?: number } = {},
): Promise<number> {
  let query = ragCountTable('cross_reference_recommendations');
  if (filter.status) query = query.eq('status', filter.status);
  if (filter.minConfidence != null) query = query.gte('overall_confidence', filter.minConfidence);
  const res = await query;
  if (res.error) throw new Error(`countRecommendations failed: ${res.error.message}`);
  return res.count ?? 0;
}

/** Per-status counts across the whole table (unfiltered) — powers the "pending" badge on the review queue. */
export async function countRecommendationsByStatus(): Promise<Record<RecommendationStatus, number>> {
  const statuses: RecommendationStatus[] = [
    'pending',
    'escalated',
    'answered',
    'declined',
    'verified',
    'rejected',
  ];
  const counts = await Promise.all(statuses.map((status) => countRecommendations({ status })));
  return statuses.reduce(
    (acc, status, i) => {
      acc[status] = counts[i] ?? 0;
      return acc;
    },
    {} as Record<RecommendationStatus, number>,
  );
}

export async function listRecommendations(
  rawInput: ListRecommendationsInput = { page: 1, pageSize: 50 },
): Promise<{ items: Recommendation[]; page: number; pageSize: number; total: number }> {
  const input = listRecommendationsInputSchema.parse(rawInput);
  let query = ragTable('cross_reference_recommendations').select('*') as unknown as LooseChain;
  if (input.status) query = query.eq('status', input.status);
  if (input.minConfidence != null) query = query.gte('overall_confidence', input.minConfidence);
  const from = (input.page - 1) * input.pageSize;
  const [res, total] = await Promise.all([
    query.order('created_at', { ascending: false }).range(from, from + input.pageSize - 1),
    countRecommendations({ status: input.status, minConfidence: input.minConfidence }),
  ]);
  if (res.error) throw new Error(`listRecommendations failed: ${res.error.message}`);
  return {
    items: (res.data ?? []).map(fromRecommendationRow),
    page: input.page,
    pageSize: input.pageSize,
    total,
  };
}

/**
 * B0-95 — the review queue's list query: same page of recommendations as `listRecommendations`,
 * with each row's candidates attached in one follow-up query (avoids N+1 per row on the admin page).
 */
export async function listRecommendationsWithCandidates(
  rawInput: ListRecommendationsInput = { page: 1, pageSize: 50 },
): Promise<{
  items: RecommendationWithCandidates[];
  page: number;
  pageSize: number;
  total: number;
}> {
  const { items, page, pageSize, total } = await listRecommendations(rawInput);
  if (items.length === 0) {
    return { items: [], page, pageSize, total };
  }

  const supabase = getSupabaseServiceRoleClient();
  const ids = items.map((r) => r.id);
  const { data, error } = await supabase
    .schema('rag')
    .from('cross_reference_recommendation_candidates')
    .select('*')
    .in('recommendation_id', ids)
    .order('rank', { ascending: true });
  if (error) throw new Error(`listRecommendationsWithCandidates failed: ${error.message}`);

  const candidatesByRecommendation = new Map<string, RecommendationCandidate[]>();
  for (const row of data ?? []) {
    const candidate = fromCandidateRow(row as unknown as LooseRow);
    const list = candidatesByRecommendation.get(candidate.recommendationId) ?? [];
    list.push(candidate);
    candidatesByRecommendation.set(candidate.recommendationId, list);
  }

  return {
    items: items.map((rec) =>
      recommendationWithCandidatesSchema.parse({
        ...rec,
        candidates: candidatesByRecommendation.get(rec.id) ?? [],
      }),
    ),
    page,
    pageSize,
    total,
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

/**
 * B0-433 — append a reviewer-authored candidate to an existing recommendation.
 *
 * The engine writes its candidates up front via `createRecommendation`; this is the only path that
 * adds one afterwards, so a recommendation the engine returned nothing usable for can still be
 * approved. Ranked last (max existing rank + 1) so the engine's own ordering is preserved, and
 * tagged `source.origin = 'human_review'` to keep engine-generated and human-authored candidates
 * distinguishable in the metrics.
 */
export async function createRecommendationCandidate(
  recommendationId: string,
  rawInput: AddRecommendationCandidateInput,
  createdBy?: string | null,
): Promise<RecommendationCandidate> {
  const input = addRecommendationCandidateInputSchema.parse(rawInput);

  const existing = await getRecommendation(recommendationId);
  if (!existing) {
    throw new Error(`createRecommendationCandidate: recommendation ${recommendationId} not found`);
  }
  const nextRank =
    existing.candidates.reduce((max, c) => Math.max(max, c.rank ?? 0), 0) + 1;

  const res = await ragTable('cross_reference_recommendation_candidates')
    .insert({
      recommendation_id: recommendationId,
      betco_product_key: input.betcoProductKey,
      betco_prod_id: input.betcoProdId ?? null,
      betco_title: input.betcoTitle,
      // Human-entered, so not a model score. Left null rather than faked at 1.0, which would
      // distort the avg-confidence metric on the queue's "Engine performance" strip.
      candidate_confidence: null,
      rank: nextRank,
      rationale: input.rationale ?? null,
      source: { origin: 'human_review', addedBy: createdBy ?? null },
    })
    .select('*')
    .single();
  if (res.error || !res.data) {
    throw new Error(`createRecommendationCandidate failed: ${res.error?.message ?? 'no row'}`);
  }
  return fromCandidateRow(res.data);
}

/** B0-95 — reviewer correction of a single candidate (e.g. swapping in the right Betco product/SKU). */
export async function updateRecommendationCandidate(
  id: string,
  rawInput: UpdateRecommendationCandidateInput,
): Promise<RecommendationCandidate> {
  const input = updateRecommendationCandidateInputSchema.parse(rawInput);
  const patch: LooseRow = {};
  if (input.betcoProductKey !== undefined) patch.betco_product_key = input.betcoProductKey;
  if (input.betcoProdId !== undefined) patch.betco_prod_id = input.betcoProdId;
  if (input.betcoTitle !== undefined) patch.betco_title = input.betcoTitle;
  if (input.rationale !== undefined) patch.rationale = input.rationale;

  const res = await ragTable('cross_reference_recommendation_candidates')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (res.error || !res.data) {
    throw new Error(`updateRecommendationCandidate failed: ${res.error?.message ?? 'no row'}`);
  }
  return fromCandidateRow(res.data);
}

/**
 * B0-1072 — an expected, reviewer-facing failure of `updateRecommendationCompetitor`. Carries a
 * `code` so the server action can turn it into a return value (Next.js strips thrown error
 * messages from Server Functions in production) instead of a raw Postgres message.
 */
export class RecommendationCompetitorEditError extends Error {
  readonly code: 'not_found' | 'decided' | 'identity_conflict';

  constructor(code: RecommendationCompetitorEditError['code'], message: string) {
    super(message);
    this.name = 'RecommendationCompetitorEditError';
    this.code = code;
  }
}

/**
 * B0-1072 — reviewer edit of a recommendation's own competitor identity, so a row the engine
 * persisted with no brand (unbranded prompt, no grounded manufacturer) can still be approved:
 * `promoteRecommendationToOverride` needs both brand and product to write the fast-path mapping.
 *
 * Only not-yet-reviewed rows may change — a verified/rejected row is a permanent human decision and
 * the override it may already have produced carries the old identity. The new identity has to be
 * unique among open rows (partial unique index `cross_reference_recommendations_identity_unreviewed_uq`
 * on the generated `*_norm` columns), so the collision is checked up front and again on 23505 for
 * the concurrent case, and surfaced as a typed error rather than the constraint's message. The
 * previous identity is kept in `evidence.competitorEdit` (same convention as `evidence.verification`).
 */
export async function updateRecommendationCompetitor(
  id: string,
  rawInput: UpdateRecommendationCompetitorInput,
  editedBy?: string | null,
): Promise<Recommendation> {
  const input = updateRecommendationCompetitorInputSchema.parse(rawInput);

  const existing = await getRecommendation(id);
  if (!existing) {
    throw new RecommendationCompetitorEditError('not_found', 'Recommendation not found.');
  }
  if (REVIEWED_STATUSES.includes(existing.status)) {
    throw new RecommendationCompetitorEditError(
      'decided',
      `This recommendation has already been ${existing.status}; its competitor details are locked.`,
    );
  }

  const competitorBrand = input.competitorBrand;
  const competitorProduct = input.competitorProduct ?? existing.competitorProduct;
  const brandNorm = normalizeIdentityPart(competitorBrand);
  const productNorm = normalizeIdentityPart(competitorProduct);

  const conflict = (): RecommendationCompetitorEditError =>
    new RecommendationCompetitorEditError(
      'identity_conflict',
      `Another open recommendation already exists for ${competitorBrand} — ${competitorProduct}. Review that one instead, or reject this one.`,
    );
  const clashId = await findExistingUnreviewedRecommendationId(brandNorm, productNorm);
  if (clashId && clashId !== id) {
    throw conflict();
  }

  const evidence: Json = {
    ...existing.evidence,
    competitorEdit: {
      editor: editedBy ?? null,
      at: new Date().toISOString(),
      previousBrand: existing.competitorBrand,
      previousProduct: existing.competitorProduct,
    },
  };

  const res = await ragIdentityTable('cross_reference_recommendations')
    .update({
      competitor_brand: competitorBrand,
      competitor_product: competitorProduct,
      evidence,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (res.error || !res.data) {
    if (res.error?.code === '23505') {
      throw conflict();
    }
    throw new Error(`updateRecommendationCompetitor failed: ${res.error?.message ?? 'no row'}`);
  }
  return fromRecommendationRow(res.data);
}

export type RecommendationMetrics = {
  total: number;
  byStatus: Record<RecommendationStatus, number>;
  answeredCount: number;
  answerRate: number;
  declinedCount: number;
  declineRate: number;
  avgConfidence: number | null;
  verifiedCount: number;
  rejectedCount: number;
  /** verified / (verified + rejected); null when nothing has been reviewed yet. */
  verificationAccuracy: number | null;
};

/**
 * B0-96 — engine performance metrics for the admin review queue. Reads the full status/confidence/
 * answer_given projection once and aggregates client-side (row volume is admin-scale, not
 * user-facing traffic, so a single unfiltered read is the simplest correct implementation).
 */
export async function getRecommendationMetrics(): Promise<RecommendationMetrics> {
  const query = ragTable('cross_reference_recommendations').select(
    'status, overall_confidence, answer_given',
  ) as unknown as LooseChain;
  const res = await query;
  if (res.error) throw new Error(`getRecommendationMetrics failed: ${res.error.message}`);
  const rows = res.data ?? [];

  const byStatus: Record<RecommendationStatus, number> = {
    pending: 0,
    escalated: 0,
    answered: 0,
    declined: 0,
    verified: 0,
    rejected: 0,
  };
  let answeredCount = 0;
  let declinedCount = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const row of rows) {
    const status = row.status as RecommendationStatus;
    if (status in byStatus) byStatus[status] += 1;
    if (row.answer_given) answeredCount += 1;
    else declinedCount += 1;
    const confidence = numOrNull(row.overall_confidence);
    if (confidence != null) {
      confidenceSum += confidence;
      confidenceCount += 1;
    }
  }

  const total = rows.length;
  const verifiedCount = byStatus.verified;
  const rejectedCount = byStatus.rejected;
  const verificationDenominator = verifiedCount + rejectedCount;

  return {
    total,
    byStatus,
    answeredCount,
    answerRate: total > 0 ? round3(answeredCount / total) : 0,
    declinedCount,
    declineRate: total > 0 ? round3(declinedCount / total) : 0,
    avgConfidence: confidenceCount > 0 ? round3(confidenceSum / confidenceCount) : null,
    verifiedCount,
    rejectedCount,
    verificationAccuracy:
      verificationDenominator > 0 ? round3(verifiedCount / verificationDenominator) : null,
  };
}
