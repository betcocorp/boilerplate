import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { RecommendationWithCandidates } from '~/lib/recommendations/recommendation-schemas';

/**
 * B0-96 — promote a human-verified recommendation into the fast-path cross-reference surface.
 *
 * `lookupCrossReference()` (~/lib/tools/cross-reference-lookup.ts) already consults
 * `public.cross_reference_override` FIRST, before the legacy `legacy.competitor_products` mapping —
 * that table is the curated, app-owned "verified mapping" surface (REC-3 / B0-76), designed exactly
 * for this purpose (survives legacy MSSQL re-syncs, authoritative, no fallback needed). Writing a
 * verified recommendation there — rather than a new `rag`-schema table or `legacy.*` — means the very
 * next identical lookup short-circuits both the legacy join and the web-search/`recommend_cross_reference`
 * path with zero changes to the lookup pipeline itself.
 *
 * Traceability back to the source recommendation is carried in `rationale` (no new column/migration
 * needed) rather than a dedicated FK column, keeping this change additive-only against a table another
 * effort (REC-3) already owns.
 */

export type PromoteRecommendationResult =
  | { promoted: true; overrideId: string; mode: 'inserted' | 'updated' }
  | { promoted: false; overrideId: null; reason: string };

export async function promoteRecommendationToOverride(
  recommendation: RecommendationWithCandidates,
  chosenCandidateId: string | null,
  verifiedBy: string | null,
): Promise<PromoteRecommendationResult> {
  const chosen =
    (chosenCandidateId
      ? recommendation.candidates.find((c) => c.id === chosenCandidateId)
      : null) ?? recommendation.candidates[0] ?? null;

  if (!chosen?.betcoProductKey || !chosen.betcoTitle) {
    return {
      promoted: false,
      overrideId: null,
      reason:
        'Chosen candidate is missing a Betco product key/title — cannot promote to the fast-path override table.',
    };
  }

  const brand = (recommendation.competitorBrand ?? '').trim();
  const product = recommendation.competitorProduct.trim();
  if (!brand || !product) {
    return {
      promoted: false,
      overrideId: null,
      reason: 'Competitor brand and product name are both required to promote a durable mapping.',
    };
  }

  const supabase = getSupabaseServiceRoleClient();
  const rationale = [
    `Verified via recommendation review queue (recommendation ${recommendation.id})`,
    verifiedBy ? `by ${verifiedBy}` : null,
    chosen.rationale ? `— ${chosen.rationale}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  // Reuse an existing active override for the same competitor product instead of duplicating it —
  // repeat approvals (e.g. re-verifying after an edit) update the fast-path row in place.
  const { data: existing, error: findError } = await supabase
    .from('cross_reference_override')
    .select('id')
    .eq('is_active', true)
    .ilike('competitor_brand', brand)
    .ilike('competitor_product', product)
    .limit(1)
    .maybeSingle();
  if (findError) {
    throw new Error(`promoteRecommendationToOverride lookup failed: ${findError.message}`);
  }

  const row = {
    competitor_brand: brand,
    competitor_product: product,
    betco_product_key: chosen.betcoProductKey,
    betco_title: chosen.betcoTitle,
    confidence: 1,
    rationale,
    is_active: true,
    created_by: verifiedBy ?? 'recommendation-queue',
  };

  if (existing?.id) {
    const { error: updateError } = await supabase
      .from('cross_reference_override')
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (updateError) {
      throw new Error(`promoteRecommendationToOverride update failed: ${updateError.message}`);
    }
    return { promoted: true, overrideId: existing.id, mode: 'updated' };
  }

  const { data: inserted, error: insertError } = await supabase
    .from('cross_reference_override')
    .insert(row)
    .select('id')
    .single();
  if (insertError || !inserted) {
    throw new Error(
      `promoteRecommendationToOverride insert failed: ${insertError?.message ?? 'no row returned'}`,
    );
  }
  return { promoted: true, overrideId: inserted.id, mode: 'inserted' };
}
