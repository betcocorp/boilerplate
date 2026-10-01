-- Orphan monitoring: app-owned ignore table + orphan check views.
-- App-owned (survives legacy re-syncs), service-role only. Mirrors cross_reference_override pattern.
-- NOTE: This migration has ALREADY been applied to the remote project (gbkobtatfsjibkxebvdw).
-- It is committed here so the repo migration history stays in sync.

create table if not exists public.orphan_ignore (
  id          uuid primary key default gen_random_uuid(),
  check_key   text not null,
  ref_id      text not null,
  reason      text,
  is_active   boolean not null default true,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (check_key, ref_id)
);

comment on table public.orphan_ignore is
  'App-owned acknowledgements that a specific orphaned record (check_key + ref_id) is known/acceptable and should be hidden from the active orphan queue. Survives legacy re-syncs. Service-role only.';

create index if not exists orphan_ignore_check_key_idx on public.orphan_ignore (check_key) where is_active;

create or replace view public.orphan_checks_v as
  select 'product_no_line'::text as check_key, 'products'::text as data_type,
         e.id::text as ref_id,
         coalesce(nullif(e.title,''), e.sku) as ref_label,
         jsonb_build_object('sku', e.sku, 'sds_number', e.metadata->>'sds_number',
                            'canonical_key', e.canonical_key) as detail
  from rag.entity e
  where e.entity_type='product' and e.product_line_key is null
  union all
  select 'product_link_unverified', 'products',
         e.id::text, coalesce(nullif(e.title,''), e.sku),
         jsonb_build_object('sku', e.sku, 'product_line_key', e.product_line_key,
                            'link_method', e.metadata->>'link_method')
  from rag.entity e
  where e.entity_type='product' and e.metadata->>'link_needs_review'='true'
  union all
  select 'product_no_alias', 'products',
         e.id::text, coalesce(nullif(e.title,''), e.sku),
         jsonb_build_object('sku', e.sku, 'product_line_key', e.product_line_key)
  from rag.entity e
  where e.entity_type='product'
    and not exists (select 1 from rag.product_alias a where a.entity_id = e.id)
  union all
  select 'product_line_no_documents', 'product_lines',
         e.id::text, coalesce(nullif(e.title,''), e.product_line_key),
         jsonb_build_object('product_line_key', e.product_line_key)
  from rag.entity e
  where e.entity_type='product_line'
    and not exists (select 1 from rag.document d where d.entity_id = e.id)
  union all
  select 'label_no_entity', 'labels',
         d.id::text, coalesce(nullif(d.title,''), d.document_key),
         jsonb_build_object('document_key', d.document_key, 'source_uri',
                            (select sr.source_uri from rag.source_record sr where sr.id=d.source_record_id))
  from rag.document d
  where d.document_kind='label' and d.entity_id is null
  union all
  select 'sds_no_entity', 'sds',
         d.id::text, coalesce(nullif(d.title,''), d.document_key),
         jsonb_build_object('document_key', d.document_key, 'source_uri',
                            (select sr.source_uri from rag.source_record sr where sr.id=d.source_record_id))
  from rag.document d
  where d.document_kind='sds' and d.entity_id is null
  union all
  select 'document_no_chunks', 'documents',
         d.id::text, coalesce(nullif(d.title,''), d.document_key),
         jsonb_build_object('document_kind', d.document_kind, 'document_key', d.document_key)
  from rag.document d
  where not exists (select 1 from rag.document_chunk c where c.document_id = d.id)
  union all
  select 'source_record_not_materialized', 'source_records',
         sr.id::text, sr.source_schema || '.' || sr.source_table || ':' || sr.source_pk,
         jsonb_build_object('source_schema', sr.source_schema, 'source_table', sr.source_table,
                            'source_type', sr.source_type, 'source_uri', sr.source_uri)
  from rag.source_record sr
  where sr.is_active
    and not exists (select 1 from rag.document d where d.source_record_id = sr.id)
  union all
  select 'efficacy_no_entity', 'efficacy',
         pe.id::text, coalesce(pe.product_key, pe.organism),
         jsonb_build_object('product_key', pe.product_key, 'organism', pe.organism)
  from rag.product_efficacy pe
  where not exists (select 1 from rag.entity e where e.id = pe.entity_id);

comment on view public.orphan_checks_v is 'Raw orphaned records across all data types, one row per (check_key, ref_id).';

create or replace view public.orphan_queue_v as
  select c.check_key, c.data_type, c.ref_id, c.ref_label, c.detail,
         (oi.id is not null) as ignored,
         oi.reason as ignore_reason,
         oi.created_by as ignored_by,
         oi.updated_at as ignored_at
  from public.orphan_checks_v c
  left join public.orphan_ignore oi
    on oi.check_key = c.check_key and oi.ref_id = c.ref_id and oi.is_active;

comment on view public.orphan_queue_v is 'Orphan queue: every orphaned record with its acknowledgement (ignore) status.';

create or replace view public.orphan_queue_summary_v as
  select data_type, check_key,
         count(*) as total,
         count(*) filter (where not ignored) as active,
         count(*) filter (where ignored) as ignored
  from public.orphan_queue_v
  group by data_type, check_key;

comment on view public.orphan_queue_summary_v is 'Per-check counts (total/active/ignored) for the orphan monitor dashboard.';

create or replace function public.set_orphan_ignore(
  p_check_key text,
  p_ref_id    text,
  p_reason    text default null,
  p_created_by text default null,
  p_is_active boolean default true
) returns public.orphan_ignore
language sql as $$
  insert into public.orphan_ignore (check_key, ref_id, reason, created_by, is_active)
  values (p_check_key, p_ref_id, p_reason, p_created_by, p_is_active)
  on conflict (check_key, ref_id) do update
    set reason = excluded.reason,
        created_by = coalesce(excluded.created_by, public.orphan_ignore.created_by),
        is_active = excluded.is_active,
        updated_at = now()
  returning *;
$$;

alter table public.orphan_ignore enable row level security;
