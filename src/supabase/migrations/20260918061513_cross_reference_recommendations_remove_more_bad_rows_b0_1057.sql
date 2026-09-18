-- B0-1057: further cleanup of rows that never belonged in this competitor cross-reference table
-- (found and named by Tom): a generic "one product for everything" request, a self-duplicating
-- brand===product entry ("Hard As Nails"/"Hard As Nails"), bare "floor finish" with no identity,
-- "hospital"/"healthcare" facility-type descriptions, and Betco's own Green Earth/BestScent/
-- Triforce product lines recorded as if they were competitors. All rows unreviewed.
delete from rag.cross_reference_recommendations
where status not in ('verified', 'rejected')
  and (
    lower(trim(competitor_product)) like 'just tell me%'
    or (lower(trim(coalesce(competitor_brand, ''))) = lower(trim(competitor_product)) and competitor_product ilike '%hard as nails%')
    or lower(trim(competitor_product)) = 'floor finish'
    or lower(trim(competitor_product)) ilike '%healthcare cleaner%'
    or lower(trim(coalesce(competitor_brand, ''))) = 'hospital'
    or lower(trim(competitor_product)) ilike '%hospital disinfectant%'
    or lower(trim(coalesce(competitor_brand, ''))) in ('green earth', 'greenearth', 'bestscent', 'triforce')
    or lower(trim(competitor_product)) ilike '%green earth floor finish%'
    or lower(trim(competitor_product)) ilike '%greenearth floor finish%'
    or lower(trim(competitor_product)) ilike '%bestscent lemon zest%'
    or lower(trim(competitor_product)) = 'triforce'
  );
