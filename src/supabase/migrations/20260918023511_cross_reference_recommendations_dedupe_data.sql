-- B0-1055: one-time cleanup — the nightly scheduled-test sweep re-runs the same golden-set prompts,
-- and createRecommendation always INSERTed a new row (no identity check), so the same real-world
-- (competitor_brand, competitor_product) identity accumulated many duplicate rows (e.g. bnc/bnc-15
-- x53, diversey/quat disinfectant x40). Collapse every not-yet-reviewed duplicate cluster down to the
-- most-recently-created row. Never touches verified/rejected rows — those are permanent human
-- decisions. Candidate rows cascade-delete via the existing
-- cross_reference_recommendation_candidate_recommendation_id_fkey (ON DELETE CASCADE).
with ranked as (
  select
    id,
    row_number() over (
      partition by competitor_brand_norm, competitor_product_norm
      order by created_at desc
    ) as rn
  from rag.cross_reference_recommendations
  where status not in ('verified', 'rejected')
)
delete from rag.cross_reference_recommendations
where id in (select id from ranked where rn > 1);
