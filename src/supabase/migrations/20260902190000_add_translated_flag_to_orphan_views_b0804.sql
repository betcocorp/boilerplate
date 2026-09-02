-- B0-804: flag translated (non-English) documents in the orphan monitor.
--
-- rag.document holds EN + ES/FR/IT copies of the same SDS. Only English rows are ever
-- chunked (rag.sync_sds_chunks) and only English rows are retrievable (every match_* RPC
-- filters upper(d.language_code) = 'EN'), so the ~796 translated rows sitting in
-- document_no_chunks / sds_no_entity are expected, not defects. Expose a `translated`
-- boolean so the UI can default-hide them behind a "Show translated" toggle instead of
-- drowning the real orphans.
--
-- CREATE OR REPLACE VIEW cannot insert a column in the middle, so all three views are
-- dropped in dependency order and recreated. Nothing outside this trio depends on them
-- (checked via pg_depend). Live state before the change: owner postgres, reloptions NULL
-- (these views were never converted by b0_284_security_invoker_views), default Supabase
-- grants to anon/authenticated/service_role — all reproduced below unchanged.

drop view if exists public.orphan_queue_summary_v;
drop view if exists public.orphan_queue_v;
drop view if exists public.orphan_checks_v;

create view public.orphan_checks_v as
  select 'product_no_line'::text as check_key, 'products'::text as data_type,
         e.id::text as ref_id,
         coalesce(nullif(e.title,''), e.sku) as ref_label,
         jsonb_build_object('sku', e.sku, 'sds_number', e.metadata->>'sds_number',
                            'canonical_key', e.canonical_key) as detail,
         false as translated
  from rag.entity e
  where e.entity_type='product' and e.product_line_key is null
  union all
  select 'product_link_unverified', 'products',
         e.id::text, coalesce(nullif(e.title,''), e.sku),
         jsonb_build_object('sku', e.sku, 'product_line_key', e.product_line_key,
                            'link_method', e.metadata->>'link_method'),
         false
  from rag.entity e
  where e.entity_type='product' and e.metadata->>'link_needs_review'='true'
  union all
  select 'product_no_alias', 'products',
         e.id::text, coalesce(nullif(e.title,''), e.sku),
         jsonb_build_object('sku', e.sku, 'product_line_key', e.product_line_key),
         false
  from rag.entity e
  where e.entity_type='product'
    and not exists (select 1 from rag.product_alias a where a.entity_id = e.id)
  union all
  select 'product_line_no_documents', 'product_lines',
         e.id::text, coalesce(nullif(e.title,''), e.product_line_key),
         jsonb_build_object('product_line_key', e.product_line_key),
         false
  from rag.entity e
  where e.entity_type='product_line'
    and not exists (select 1 from rag.document d where d.entity_id = e.id)
  union all
  select 'label_no_entity', 'labels',
         d.id::text, coalesce(nullif(d.title,''), d.document_key),
         jsonb_build_object('document_key', d.document_key, 'source_uri',
                            (select sr.source_uri from rag.source_record sr where sr.id=d.source_record_id),
                            'language_code', d.language_code),
         (upper(d.language_code) is distinct from 'EN')
  from rag.document d
  where d.document_kind='label' and d.entity_id is null
  union all
  select 'sds_no_entity', 'sds',
         d.id::text, coalesce(nullif(d.title,''), d.document_key),
         jsonb_build_object('document_key', d.document_key, 'source_uri',
                            (select sr.source_uri from rag.source_record sr where sr.id=d.source_record_id),
                            'language_code', d.language_code),
         (upper(d.language_code) is distinct from 'EN')
  from rag.document d
  where d.document_kind='sds' and d.entity_id is null
  union all
  select 'document_no_chunks', 'documents',
         d.id::text, coalesce(nullif(d.title,''), d.document_key),
         jsonb_build_object('document_kind', d.document_kind, 'document_key', d.document_key,
                            'language_code', d.language_code),
         (upper(d.language_code) is distinct from 'EN')
  from rag.document d
  where not exists (select 1 from rag.document_chunk c where c.document_id = d.id)
  union all
  select 'source_record_not_materialized', 'source_records',
         sr.id::text, sr.source_schema || '.' || sr.source_table || ':' || sr.source_pk,
         jsonb_build_object('source_schema', sr.source_schema, 'source_table', sr.source_table,
                            'source_type', sr.source_type, 'source_uri', sr.source_uri),
         false
  from rag.source_record sr
  where sr.is_active
    and not exists (select 1 from rag.document d where d.source_record_id = sr.id)
  union all
  select 'efficacy_no_entity', 'efficacy',
         pe.id::text, coalesce(pe.product_key, pe.organism),
         jsonb_build_object('product_key', pe.product_key, 'organism', pe.organism),
         false
  from rag.product_efficacy pe
  where not exists (select 1 from rag.entity e where e.id = pe.entity_id);

comment on view public.orphan_checks_v is 'Raw orphaned records across all data types, one row per (check_key, ref_id). `translated` marks non-English source documents (expected, never chunked or retrieved).';

create view public.orphan_queue_v as
  select c.check_key, c.data_type, c.ref_id, c.ref_label, c.detail, c.translated,
         (oi.id is not null) as ignored,
         oi.reason as ignore_reason,
         oi.created_by as ignored_by,
         oi.updated_at as ignored_at
  from public.orphan_checks_v c
  left join public.orphan_ignore oi
    on oi.check_key = c.check_key and oi.ref_id = c.ref_id and oi.is_active;

comment on view public.orphan_queue_v is 'Orphan queue: every orphaned record with its acknowledgement (ignore) status and translated flag.';

-- `translated` counts every translated row; `active_translated` counts only the ones still
-- in the active queue. The dashboard needs the second one: the table's default view is
-- "not ignored AND not translated", so the headline count is `active - active_translated`.
-- Subtracting `translated` instead would double-count any translated row that was also
-- acknowledged.
create view public.orphan_queue_summary_v as
  select data_type, check_key,
         count(*) as total,
         count(*) filter (where not ignored) as active,
         count(*) filter (where ignored) as ignored,
         count(*) filter (where translated) as translated,
         count(*) filter (where translated and not ignored) as active_translated
  from public.orphan_queue_v
  group by data_type, check_key;

comment on view public.orphan_queue_summary_v is 'Per-check counts (total/active/ignored/translated/active_translated) for the orphan monitor dashboard.';

-- Reproduce the grants the dropped views carried (Supabase default privileges in public).
grant all on public.orphan_checks_v        to anon, authenticated, service_role;
grant all on public.orphan_queue_v         to anon, authenticated, service_role;
grant all on public.orphan_queue_summary_v to anon, authenticated, service_role;
