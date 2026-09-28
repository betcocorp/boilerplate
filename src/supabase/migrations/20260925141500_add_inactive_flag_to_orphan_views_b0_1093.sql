-- B0-1093: flag inactive product lines / deactivated documents in the orphan monitor.
--
-- B0-1091 deactivates the product-line profile of every line with no active items: the
-- rag.document row stays, its rag.source_record.is_active flips to false, its chunks are
-- deleted, and every rag.entity row with entity_type = 'product_line' gains
-- metadata->>'line_lifecycle' in ('web_active' | 'active_offline' | 'inactive' | 'empty').
-- That leaves ~1,085 expected `document_no_chunks` rows and keeps every other check
-- counting dead lines. Same shape as B0-804's `translated` column: expose an `inactive`
-- boolean so the UI can default-hide those rows behind a "Show inactive" toggle.
--
-- `inactive` per check:
--   * label_no_entity / sds_no_entity — the document's source_record is no longer active
--     (entity_id is null by definition, so there is no line to consult). Today this also
--     covers the SDS deactivated by the B0-243/B0-283 corpus-scope purge and B0-794's
--     content-language purge — deliberately retired, never retrieved, so expected.
--   * document_no_chunks — source_record inactive OR the document's entity is on an
--     inactive/empty line. Documents attach to product-tier entities as well as line-tier
--     ones, so the lifecycle is resolved through the parent line (rag.entity product rows
--     carry product_line_key; the line entity with the same product_line_key and
--     entity_type = 'product_line' holds the lifecycle; product_line_key is unique and
--     non-null across line entities).
--   * product_no_line / product_link_unverified / product_no_alias — parent line is
--     inactive/empty (product_no_line has no parent, so it is never inactive).
--   * product_line_no_documents — the line itself is inactive/empty.
--   * source_record_not_materialized — false (it already requires is_active).
--   * efficacy_no_entity — false.
-- Until B0-1091 lands, no entity carries line_lifecycle and the entity clauses are simply
-- false; the source_record clause is live immediately.
--
-- CREATE OR REPLACE VIEW cannot insert a column in the middle, so all three views are
-- dropped in dependency order and recreated. Nothing outside this trio depends on them
-- (checked via pg_depend). Live state before the change: owner postgres, reloptions NULL,
-- default Supabase grants to anon/authenticated/service_role — all reproduced below
-- unchanged. `inactive` sits after `translated`; the summary keeps its existing column
-- order and appends `inactive` / `active_inactive` at the end.

drop view if exists public.orphan_queue_summary_v;
drop view if exists public.orphan_queue_v;
drop view if exists public.orphan_checks_v;

create view public.orphan_checks_v as
  select 'product_no_line'::text as check_key, 'products'::text as data_type,
         e.id::text as ref_id,
         coalesce(nullif(e.title,''), e.sku) as ref_label,
         jsonb_build_object('sku', e.sku, 'sds_number', e.metadata->>'sds_number',
                            'canonical_key', e.canonical_key) as detail,
         false as translated,
         false as inactive
  from rag.entity e
  where e.entity_type='product' and e.product_line_key is null
  union all
  select 'product_link_unverified', 'products',
         e.id::text, coalesce(nullif(e.title,''), e.sku),
         jsonb_build_object('sku', e.sku, 'product_line_key', e.product_line_key,
                            'link_method', e.metadata->>'link_method'),
         false,
         exists (select 1 from rag.entity le
                 where le.entity_type='product_line'
                   and le.product_line_key = e.product_line_key
                   and le.metadata->>'line_lifecycle' in ('inactive','empty'))
  from rag.entity e
  where e.entity_type='product' and e.metadata->>'link_needs_review'='true'
  union all
  select 'product_no_alias', 'products',
         e.id::text, coalesce(nullif(e.title,''), e.sku),
         jsonb_build_object('sku', e.sku, 'product_line_key', e.product_line_key),
         false,
         exists (select 1 from rag.entity le
                 where le.entity_type='product_line'
                   and le.product_line_key = e.product_line_key
                   and le.metadata->>'line_lifecycle' in ('inactive','empty'))
  from rag.entity e
  where e.entity_type='product'
    and not exists (select 1 from rag.product_alias a where a.entity_id = e.id)
  union all
  select 'product_line_no_documents', 'product_lines',
         e.id::text, coalesce(nullif(e.title,''), e.product_line_key),
         jsonb_build_object('product_line_key', e.product_line_key),
         false,
         (e.metadata->>'line_lifecycle' in ('inactive','empty'))
  from rag.entity e
  where e.entity_type='product_line'
    and not exists (select 1 from rag.document d where d.entity_id = e.id)
  union all
  select 'label_no_entity', 'labels',
         d.id::text, coalesce(nullif(d.title,''), d.document_key),
         jsonb_build_object('document_key', d.document_key, 'source_uri',
                            (select sr.source_uri from rag.source_record sr where sr.id=d.source_record_id),
                            'language_code', d.language_code),
         (upper(d.language_code) is distinct from 'EN'),
         exists (select 1 from rag.source_record sr
                 where sr.id = d.source_record_id and not sr.is_active)
  from rag.document d
  where d.document_kind='label' and d.entity_id is null
  union all
  select 'sds_no_entity', 'sds',
         d.id::text, coalesce(nullif(d.title,''), d.document_key),
         jsonb_build_object('document_key', d.document_key, 'source_uri',
                            (select sr.source_uri from rag.source_record sr where sr.id=d.source_record_id),
                            'language_code', d.language_code),
         (upper(d.language_code) is distinct from 'EN'),
         exists (select 1 from rag.source_record sr
                 where sr.id = d.source_record_id and not sr.is_active)
  from rag.document d
  where d.document_kind='sds' and d.entity_id is null
  union all
  select 'document_no_chunks', 'documents',
         d.id::text, coalesce(nullif(d.title,''), d.document_key),
         jsonb_build_object('document_kind', d.document_kind, 'document_key', d.document_key,
                            'language_code', d.language_code),
         (upper(d.language_code) is distinct from 'EN'),
         (exists (select 1 from rag.source_record sr
                  where sr.id = d.source_record_id and not sr.is_active)
          or exists (select 1 from rag.entity e
                     where e.id = d.entity_id
                       and (e.metadata->>'line_lifecycle' in ('inactive','empty')
                            or exists (select 1 from rag.entity le
                                       where le.entity_type='product_line'
                                         and le.product_line_key = e.product_line_key
                                         and le.metadata->>'line_lifecycle' in ('inactive','empty')))))
  from rag.document d
  where not exists (select 1 from rag.document_chunk c where c.document_id = d.id)
  union all
  select 'source_record_not_materialized', 'source_records',
         sr.id::text, sr.source_schema || '.' || sr.source_table || ':' || sr.source_pk,
         jsonb_build_object('source_schema', sr.source_schema, 'source_table', sr.source_table,
                            'source_type', sr.source_type, 'source_uri', sr.source_uri),
         false,
         false
  from rag.source_record sr
  where sr.is_active
    and not exists (select 1 from rag.document d where d.source_record_id = sr.id)
  union all
  select 'efficacy_no_entity', 'efficacy',
         pe.id::text, coalesce(pe.product_key, pe.organism),
         jsonb_build_object('product_key', pe.product_key, 'organism', pe.organism),
         false,
         false
  from rag.product_efficacy pe
  where not exists (select 1 from rag.entity e where e.id = pe.entity_id);

comment on view public.orphan_checks_v is 'Raw orphaned records across all data types, one row per (check_key, ref_id). `translated` marks non-English source documents (expected, never chunked or retrieved). `inactive` marks deactivated source records and records on inactive/empty product lines (B0-1091 line_lifecycle; expected).';

create view public.orphan_queue_v as
  select c.check_key, c.data_type, c.ref_id, c.ref_label, c.detail, c.translated, c.inactive,
         (oi.id is not null) as ignored,
         oi.reason as ignore_reason,
         oi.created_by as ignored_by,
         oi.updated_at as ignored_at
  from public.orphan_checks_v c
  left join public.orphan_ignore oi
    on oi.check_key = c.check_key and oi.ref_id = c.ref_id and oi.is_active;

comment on view public.orphan_queue_v is 'Orphan queue: every orphaned record with its acknowledgement (ignore) status, translated flag and inactive flag.';

-- `inactive` counts every inactive row; `active_inactive` counts only the ones still in
-- the active queue (same reasoning as translated / active_translated). The table's default
-- view is "not ignored AND not translated AND not inactive", so the headline count is
-- `active - count(not ignored and (translated or inactive))` — `active_hidden` below is
-- that exact number, because a row can be both translated and inactive and subtracting the
-- two counts separately would double-count it.
create view public.orphan_queue_summary_v as
  select data_type, check_key,
         count(*) as total,
         count(*) filter (where not ignored) as active,
         count(*) filter (where ignored) as ignored,
         count(*) filter (where translated) as translated,
         count(*) filter (where translated and not ignored) as active_translated,
         count(*) filter (where inactive) as inactive,
         count(*) filter (where inactive and not ignored) as active_inactive,
         count(*) filter (where (translated or inactive) and not ignored) as active_hidden
  from public.orphan_queue_v
  group by data_type, check_key;

comment on view public.orphan_queue_summary_v is 'Per-check counts (total/active/ignored/translated/active_translated/inactive/active_inactive/active_hidden) for the orphan monitor dashboard.';

-- Reproduce the grants the dropped views carried (Supabase default privileges in public).
grant all on public.orphan_checks_v        to anon, authenticated, service_role;
grant all on public.orphan_queue_v         to anon, authenticated, service_role;
grant all on public.orphan_queue_summary_v to anon, authenticated, service_role;
