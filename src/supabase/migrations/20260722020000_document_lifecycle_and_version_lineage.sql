-- B0-233 — Version lineage + lifecycle status on rag.document.
--
-- Generic, additive columns on rag.document (safe no-op for every existing
-- document_kind: defaults keep current rows 'active' + is_current=true). Built for
-- the efficacy lab-report corpus (B0-223/224/228) but not efficacy-specific, since
-- future doc-versioned kinds can reuse the same fields:
--
--   lifecycle_status        — Master-sheet status column (B0-223): active / never_activated /
--                              unused / superseded. Drives default-retrieval exclusion (B0-235).
--   is_current               — "Current formula = Y" on the Master sheet: the authoritative
--                              version among all versions of the same formula_code.
--   superseded_by_document_id — when is_current=false, points at the document that superseded
--                              this one (nullable — a document can be superseded with no
--                              successor on file yet).
--   cites_data_from_document_id — the "current version cites an earlier version's data" case
--                              (e.g. M000796 v7 reusing V6 (-5% eth) data, per B0-223): lets a
--                              document stay is_current=true while still crediting the version
--                              whose lab numbers it's reporting, so citation (B0-238) never
--                              drops the source of the actual measurements.
alter table rag.document
  add column if not exists lifecycle_status text not null default 'active',
  add column if not exists is_current boolean not null default true,
  add column if not exists superseded_by_document_id uuid references rag.document (id) on delete set null,
  add column if not exists cites_data_from_document_id uuid references rag.document (id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'document_lifecycle_status_check'
  ) then
    alter table rag.document
      add constraint document_lifecycle_status_check
      check (lifecycle_status in ('active', 'never_activated', 'unused', 'superseded'));
  end if;
end $$;

comment on column rag.document.lifecycle_status is
  'B0-223/233/235: active | never_activated | unused | superseded. Non-active rows are excluded from default retrieval (see rag.match_corpus_chunks*) but remain directly addressable by id/chunk_id for explicit version-history queries.';
comment on column rag.document.is_current is
  'B0-233: true for the authoritative version of a formula_code per the Master sheet "Current formula = Y" column.';
comment on column rag.document.superseded_by_document_id is
  'B0-233: when is_current=false, the document that superseded this version (nullable).';
comment on column rag.document.cites_data_from_document_id is
  'B0-233: when this (current) document reuses an earlier version''s lab data verbatim, points at the version that actually generated the numbers, so citations (B0-238) stay accurate.';

create index if not exists document_lifecycle_status_idx
  on rag.document (lifecycle_status) where lifecycle_status <> 'active';
create index if not exists document_is_current_idx
  on rag.document (is_current) where is_current = false;

-- "A view/helper returns 'current efficacy for product X'" (B0-233 acceptance criteria).
-- Joins the formula<->product crosswalk (B0-231) to the current, active efficacy document
-- for a given product_line_key. Returns zero rows if the product has no linked formula yet
-- (B0-232 backfill) — callers (B0-237) treat that as "no efficacy data on file".
create or replace function rag.get_current_efficacy_for_product(p_product_line_key text)
returns setof rag.document
language sql
stable
set search_path to 'rag', 'public'
as $function$
  select d.*
  from rag.document d
  join rag.efficacy_formula_product efp
    on efp.formula_code = coalesce(d.metadata ->> 'formula_code', '')
   and efp.is_active = true
  where d.document_kind = 'efficacy'
    and d.is_current = true
    and d.lifecycle_status = 'active'
    and efp.product_line_key = p_product_line_key;
$function$;

comment on function rag.get_current_efficacy_for_product(text) is
  'B0-233: current, active efficacy document(s) for a product_line_key via the B0-231 formula<->product crosswalk.';

grant execute on function rag.get_current_efficacy_for_product(text) to service_role;
