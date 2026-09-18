-- B0-1055: enforce the (competitor_brand_norm, competitor_product_norm) identity going forward
-- among not-yet-reviewed recommendations, now that cross_reference_recommendations_dedupe_data has
-- collapsed the existing duplicate clusters. createRecommendation (src/lib/recommendations/repository.ts)
-- upserts against this identity instead of always inserting.
create unique index cross_reference_recommendations_identity_unreviewed_uq
  on rag.cross_reference_recommendations (competitor_brand_norm, competitor_product_norm)
  where status not in ('verified', 'rejected');
