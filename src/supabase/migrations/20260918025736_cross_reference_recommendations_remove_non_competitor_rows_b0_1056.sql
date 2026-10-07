-- B0-1056: remove rows where competitor_product is plainly not a competitor product identity at
-- all -- a full user question or unrelated request (e.g. "Why does the grout stay dirty even after
-- we mop it?", "I found a spec sheet online for a competitor's disinfectant. Can you find the
-- Betco match?"). Root cause: product-tools.ts's `recommend_cross_reference` tool case took the
-- model's tool-call `competitorProduct` argument straight to the engine + persistence with no
-- identity guard (fixed in application code alongside this migration). All 42 matching rows are
-- unreviewed (never verified/rejected) and have no competitor_brand recorded, confirming none are
-- a real competitor query that happens to be long.
delete from rag.cross_reference_recommendations
where status not in ('verified', 'rejected')
  and (
    competitor_product ilike '%?%'
    or length(trim(competitor_product)) > 80
    or competitor_product ~* '^\s*(which|what|why|when|where|who|how|is|are|can|could|would|should|do|does|did|i need|i have|i found|our|we|a customer|a customer''s)\M'
  );
