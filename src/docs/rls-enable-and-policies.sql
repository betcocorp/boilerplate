-- B0-202 — Enable RLS + policies on the exposed tables.
--
-- ✅ APPLIED to prod 2026-07-15 as migration `20260715090200_enable_rls_and_policies.sql`
--    (tailored: legacy.* also gets anon/authenticated SELECT; rag.* + sensitive public.* are
--    service-role only). This file remains as the annotated reference + risk rationale.
--    Post-apply verification: legacy 25/25 rls+anon-read; public 12/12 rls/0 anon; rag 6/6 rls/0 anon.
--
-- REVIEW BEFORE RUNNING. This is a reviewable script, not an auto-applied migration.
--
-- Context: 43 tables currently have RLS DISABLED, including agent_conversations,
-- agent_messages, audit_logs, and the entire rag corpus. Anyone with the anon key
-- can read/modify every row.
--
-- Why this is safe for the server: all server paths use the Supabase SERVICE ROLE
-- (getSupabaseServiceRoleClient), which BYPASSES RLS. Enabling RLS therefore does NOT
-- break server-side reads/writes. The explicit service_role policies below are
-- belt-and-suspenders (service_role bypasses RLS regardless).
--
-- ⚠️ RISK CHECKLIST — do this before running in prod:
--   1. Grep the frontend for the BROWSER client (supabase/clients/client.ts, anon key).
--      Any table it reads directly from the browser needs an `authenticated` SELECT
--      policy below, or enabling RLS-with-no-policy will break that read.
--      Likely browser-read candidates: public.product_category(_link), public.tests /
--      test_items / test_results / test_result_items (admin eval UI),
--      public.agent_conversations / agent_messages (chat history UI).
--   2. Confirm chat history is fetched server-side (next-auth route → service role).
--      If so, no authenticated policy is needed for agent_* .
--   3. Run in staging / a Supabase branch first; smoke-test chat + admin UIs.
--   4. Re-run get_advisors(security) after — expect the rls_disabled lints to clear.

begin;

-- =========================================================================
-- 1) ENABLE RLS (all 43). Service role bypasses; anon/authenticated blocked until policies.
-- =========================================================================
-- rag (6)
alter table rag.source_record    enable row level security;
alter table rag.entity           enable row level security;
alter table rag.entity_link      enable row level security;
alter table rag.document         enable row level security;
alter table rag.document_chunk   enable row level security;
alter table rag.search_embedding enable row level security;
-- public (12)
alter table public.agent_conversations   enable row level security;
alter table public.agent_messages        enable row level security;
alter table public.workflow_runs         enable row level security;
alter table public.workflow_steps        enable row level security;
alter table public.review_tasks          enable row level security;
alter table public.audit_logs            enable row level security;
alter table public.tests                 enable row level security;
alter table public.test_items            enable row level security;
alter table public.test_results          enable row level security;
alter table public.test_result_items     enable row level security;
alter table public.agent_message_feedback enable row level security;
alter table public.ai_suggestions        enable row level security;
-- legacy (25)
alter table legacy.certifications                 enable row level security;
alter table legacy.competitor                     enable row level security;
alter table legacy.competitor_products            enable row level security;
alter table legacy.documents                      enable row level security;
alter table legacy.feature_srch                   enable row level security;
alter table legacy.prod_class                     enable row level security;
alter table legacy.prod_images                    enable row level security;
alter table legacy.prod_line                      enable row level security;
alter table legacy.prod_line_attr                 enable row level security;
alter table legacy.prod_line_descr                enable row level security;
alter table legacy.prod_types                     enable row level security;
alter table legacy.product_direction_of_use       enable row level security;
alter table legacy.products_attr                  enable row level security;
alter table legacy.products_descr                 enable row level security;
alter table legacy.related_products               enable row level security;
alter table legacy.size_code                      enable row level security;
alter table legacy.size_code_descr                enable row level security;
alter table legacy.sub_child_prod_types           enable row level security;
alter table legacy.sub_child_prod_types_descr     enable row level security;
alter table legacy.sub_prod_types                 enable row level security;
alter table legacy.sub_prod_types_descr           enable row level security;
alter table legacy.tech_spec                      enable row level security;
alter table legacy.tech_spec_def                  enable row level security;
alter table legacy.videos                         enable row level security;
alter table legacy.products                       enable row level security;

-- =========================================================================
-- 2) SERVICE-ROLE policies (explicit full access). Generated per table.
--    (Optional — service_role bypasses RLS — but makes intent auditable.)
-- =========================================================================
do $$
declare t record;
begin
  for t in
    select schemaname, tablename from pg_tables
    where (schemaname = 'rag')
       or (schemaname = 'public' and tablename in (
            'agent_conversations','agent_messages','workflow_runs','workflow_steps',
            'review_tasks','audit_logs','tests','test_items','test_results',
            'test_result_items','agent_message_feedback','ai_suggestions'))
       or (schemaname = 'legacy')
  loop
    execute format(
      'create policy %I on %I.%I for all to service_role using (true) with check (true);',
      t.tablename || '_service_role', t.schemaname, t.tablename);
  end loop;
end $$;

-- =========================================================================
-- 3) AUTHENTICATED read policies — UNCOMMENT ONLY the tables the BROWSER reads
--    directly via the anon/authenticated client (see risk checklist #1).
--    Leave commented if the data is fetched server-side via the service role.
-- =========================================================================
-- create policy product_category_auth_read     on public.product_category      for select to authenticated using (true);
-- create policy product_category_link_auth_read on public.product_category_link for select to authenticated using (true);
-- create policy tests_auth_read                 on public.tests                 for select to authenticated using (true);
-- create policy test_items_auth_read            on public.test_items            for select to authenticated using (true);
-- create policy test_results_auth_read          on public.test_results          for select to authenticated using (true);
-- create policy test_result_items_auth_read     on public.test_result_items     for select to authenticated using (true);
--
-- Thread ownership (preferred once agent_conversations.user_id is populated — roadmap #4):
-- create policy agent_conversations_owner on public.agent_conversations
--   for select to authenticated using (user_id = auth.uid()::text);
-- create policy agent_messages_owner on public.agent_messages
--   for select to authenticated using (
--     conversation_id in (select id from public.agent_conversations where user_id = auth.uid()::text));

commit;
