-- B0-202 — Enable RLS on the 43 previously-exposed tables (APPLIED to prod 2026-07-15).
-- Policy shape:
--   * rag.* + sensitive public.* (agent/audit/workflow/eval) → service-role only (no anon read).
--   * legacy.* reference tables → service-role + anon/authenticated SELECT, because the
--     /admin/products/legacy/* pages read them via the anon server client (getSupabaseServerClient).
-- All server writes use the service role, which bypasses RLS. Verified post-apply:
--   legacy 25/25 rls + anon-readable; public 12/12 rls, 0 anon; rag 6/6 rls, 0 anon.
do $$
declare r record;
begin
  for r in (
    select 'rag'::text as sch, unnest(array[
      'source_record','entity','entity_link','document','document_chunk','search_embedding']) as tbl
    union all select 'public', unnest(array[
      'agent_conversations','agent_messages','workflow_runs','workflow_steps','review_tasks',
      'audit_logs','tests','test_items','test_results','test_result_items',
      'agent_message_feedback','ai_suggestions'])
    union all select 'legacy', unnest(array[
      'certifications','competitor','competitor_products','documents','feature_srch','prod_class',
      'prod_images','prod_line','prod_line_attr','prod_line_descr','prod_types',
      'product_direction_of_use','products_attr','products_descr','related_products','size_code',
      'size_code_descr','sub_child_prod_types','sub_child_prod_types_descr','sub_prod_types',
      'sub_prod_types_descr','tech_spec','tech_spec_def','videos','products'])
  ) loop
    execute format('alter table %I.%I enable row level security;', r.sch, r.tbl);
    execute format('drop policy if exists %I on %I.%I;', r.tbl||'_service_role', r.sch, r.tbl);
    execute format('create policy %I on %I.%I for all to service_role using (true) with check (true);',
                   r.tbl||'_service_role', r.sch, r.tbl);
    if r.sch = 'legacy' then
      execute format('drop policy if exists %I on %I.%I;', r.tbl||'_ref_read', r.sch, r.tbl);
      execute format('create policy %I on %I.%I for select to anon, authenticated using (true);',
                     r.tbl||'_ref_read', r.sch, r.tbl);
    end if;
  end loop;
end $$;

-- FOLLOW-UP (roadmap #4): once agent_conversations.user_id / workspace_id are populated, add
-- per-user `authenticated` SELECT policies for thread ownership and reduce service-role reliance.
