-- B0-1056: this table is for competitors of Betco/Basic Coatings/EnviroZyme only. 6 rows had
-- Betco itself recorded as the "competitor" brand (self-reference misfires from the same
-- ungated product-tools.ts tool-call path fixed alongside this migration -- see
-- cross_reference_recommendations_remove_non_competitor_rows_b0_1056). None reviewed.
delete from rag.cross_reference_recommendations
where status not in ('verified', 'rejected')
  and lower(trim(coalesce(competitor_brand, ''))) in ('betco', 'basic coatings', 'envirozyme');
