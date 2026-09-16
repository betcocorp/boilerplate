-- B0-1021: track who uploaded/ingested each rag.document row.
-- Nullable text column following the existing "who did this" convention
-- (reviewed_by on product_alias_review / recommendations review tables):
-- session.user.email for human-triggered admin ingestion, a literal
-- 'system:legacy-sync' marker for the one fully automated writer
-- (rag.sync_legacy_product_profiles, invoked by a cron/webhook-authorized
-- route with no human actor). Existing rows stay null -- no fabricated
-- backfill.

alter table rag.document
  add column if not exists ingested_by text;

comment on column rag.document.ingested_by is
  'Who last ingested/updated this document: an admin session email for human-triggered ingestion, or a literal system:* marker for automated syncs. Null for historical rows ingested before B0-1021.';

-- rag.sync_legacy_product_profiles: only rag.document writer that is not a
-- human-triggered admin action (it runs behind isRagSyncAuthorized, a
-- cron/webhook token check -- see src/app/api/rag/docs/sync/route.ts).
-- Body verified live via pg_get_functiondef before this edit; the only
-- change is adding ingested_by to the insert/upsert into rag.document.
-- Parameter list and return type are unchanged, so CREATE OR REPLACE is safe
-- (the DROP+CREATE rule in AGENTS.md applies to signature/param changes on
-- match_* RPCs, not a same-signature body edit).
create or replace function rag.sync_legacy_product_profiles(p_language_code text default 'EN'::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'rag', 'legacy', 'public'
 set statement_timeout to '300s'
as $function$
declare
  v_language_code text := upper(coalesce(nullif(trim(p_language_code), ''), 'EN'));
  v_batch_limit integer := 25;
  v_source_rows_processed integer := 0;
  v_source_count integer := 0;
  v_entity_count integer := 0;
  v_document_count integer := 0;
  v_deactivated_count integer := 0;
  v_remaining_source_rows integer := 0;
  v_remaining_deactivations integer := 0;
begin
  drop table if exists pg_temp.rag_profile_sync_candidates;
  drop table if exists pg_temp.rag_profile_deactivate_candidates;

  create temporary table rag_profile_sync_candidates
  on commit drop
  as
  with pending_rows as (
    select
      lpps.source_schema,
      lpps.source_table,
      lpps.source_pk,
      upper(lpps.language_code) as language_code,
      lpps.source_type,
      lpps.document_key,
      lpps.entity_type,
      lpps.entity_key,
      lpps.title,
      lpps.body_text,
      lpps.sku,
      lpps.product_line_key,
      lpps.product_key,
      md5(coalesce(lpps.body_text, '')) as checksum,
      lpps.metadata,
      existing_source_record.updated_at as source_record_updated_at,
      existing_entity.updated_at as entity_updated_at,
      existing_document.updated_at as document_updated_at
    from rag.legacy_product_line_profile_source lpps
    left join rag.source_record existing_source_record
      on existing_source_record.source_schema = lpps.source_schema
     and existing_source_record.source_table = lpps.source_table
     and existing_source_record.source_pk = lpps.source_pk
     and upper(existing_source_record.source_locale) = upper(lpps.language_code)
    left join rag.entity existing_entity
      on existing_entity.entity_type = lpps.entity_type
     and existing_entity.canonical_key = lpps.entity_key
    left join rag.document existing_document
      on existing_document.document_key = lpps.document_key
    where upper(lpps.language_code) = v_language_code
      and (
        existing_source_record.id is null
        or existing_source_record.source_type is distinct from lpps.source_type
        or existing_source_record.checksum is distinct from md5(coalesce(lpps.body_text, ''))
        or existing_source_record.is_active is distinct from true
        or existing_source_record.metadata is distinct from lpps.metadata
        or existing_entity.id is null
        or existing_entity.title is distinct from lpps.title
        or existing_entity.sku is distinct from lpps.sku
        or existing_entity.product_key is distinct from lpps.product_key
        or existing_entity.product_line_key is distinct from lpps.product_line_key
        or existing_entity.metadata is distinct from lpps.metadata
        or existing_document.id is null
        or existing_document.title is distinct from lpps.title
        or upper(coalesce(existing_document.language_code, '')) is distinct from upper(lpps.language_code)
        or existing_document.body_text is distinct from lpps.body_text
        or existing_document.metadata is distinct from lpps.metadata
        or existing_document.document_kind is distinct from 'product_line_profile'
        or existing_document.token_count is null
      )
  )
  select
    d.source_schema,
    d.source_table,
    d.source_pk,
    d.language_code,
    d.source_type,
    d.document_key,
    d.entity_type,
    d.entity_key,
    d.title,
    d.body_text,
    d.sku,
    d.product_line_key,
    d.product_key,
    d.checksum,
    d.metadata
  from (
    select distinct on (pr.document_key)
      pr.source_schema,
      pr.source_table,
      pr.source_pk,
      pr.language_code,
      pr.source_type,
      pr.document_key,
      pr.entity_type,
      pr.entity_key,
      pr.title,
      pr.body_text,
      pr.sku,
      pr.product_line_key,
      pr.product_key,
      pr.checksum,
      pr.metadata,
      coalesce(
        least(
          coalesce(pr.source_record_updated_at, 'infinity'::timestamptz),
          coalesce(pr.entity_updated_at, 'infinity'::timestamptz),
          coalesce(pr.document_updated_at, 'infinity'::timestamptz)
        ),
        '-infinity'::timestamptz
      ) as sync_priority
    from pending_rows pr
    order by
      pr.document_key,
      coalesce(
        least(
          coalesce(pr.source_record_updated_at, 'infinity'::timestamptz),
          coalesce(pr.entity_updated_at, 'infinity'::timestamptz),
          coalesce(pr.document_updated_at, 'infinity'::timestamptz)
        ),
        '-infinity'::timestamptz
      )
  ) d
  order by d.sync_priority, d.document_key
  limit v_batch_limit;

  select count(*) into v_source_rows_processed
  from rag_profile_sync_candidates;

  with upserted as (
    insert into rag.source_record (
      source_schema,
      source_table,
      source_pk,
      source_locale,
      source_type,
      checksum,
      is_active,
      last_seen_at,
      metadata
    )
    select
      c.source_schema,
      c.source_table,
      c.source_pk,
      c.language_code,
      c.source_type,
      c.checksum,
      true,
      timezone('utc', now()),
      c.metadata
    from rag_profile_sync_candidates c
    on conflict on constraint source_record_identity_key
    do update
      set source_type = excluded.source_type,
          checksum = excluded.checksum,
          is_active = true,
          last_seen_at = excluded.last_seen_at,
          metadata = excluded.metadata
    returning 1
  )
  select count(*) into v_source_count
  from upserted;

  with upserted as (
    insert into rag.entity (
      entity_type,
      canonical_key,
      title,
      sku,
      product_key,
      product_line_key,
      metadata
    )
    select
      c.entity_type,
      c.entity_key,
      c.title,
      c.sku,
      c.product_key,
      c.product_line_key,
      c.metadata
    from rag_profile_sync_candidates c
    on conflict on constraint entity_identity_key
    do update
      set title = excluded.title,
          sku = excluded.sku,
          product_key = excluded.product_key,
          product_line_key = excluded.product_line_key,
          metadata = excluded.metadata
    returning 1
  )
  select count(*) into v_entity_count
  from upserted;

  with resolved as (
    select
      c.document_key,
      sr.id as source_record_id,
      e.id as entity_id,
      c.title,
      c.language_code,
      c.body_text,
      c.metadata
    from rag_profile_sync_candidates c
    join rag.source_record sr
      on sr.source_schema = c.source_schema
     and sr.source_table = c.source_table
     and sr.source_pk = c.source_pk
     and upper(sr.source_locale) = c.language_code
    left join rag.entity e
      on e.entity_type = c.entity_type
     and e.canonical_key = c.entity_key
  ),
  upserted as (
    insert into rag.document (
      document_key,
      source_record_id,
      entity_id,
      document_kind,
      title,
      language_code,
      body_text,
      token_count,
      metadata,
      ingested_by
    )
    select
      r.document_key,
      r.source_record_id,
      r.entity_id,
      'product_line_profile',
      r.title,
      r.language_code,
      r.body_text,
      ceil(greatest(length(coalesce(r.body_text, '')), 1) / 4.0)::integer,
      r.metadata,
      'system:legacy-sync'
    from resolved r
    on conflict (document_key)
    do update
      set source_record_id = excluded.source_record_id,
          entity_id = excluded.entity_id,
          document_kind = excluded.document_kind,
          title = excluded.title,
          language_code = excluded.language_code,
          body_text = excluded.body_text,
          token_count = excluded.token_count,
          metadata = excluded.metadata,
          ingested_by = excluded.ingested_by
    returning 1
  )
  select count(*) into v_document_count
  from upserted;

  create temporary table rag_profile_deactivate_candidates
  on commit drop
  as
  select
    sr.id
  from rag.source_record sr
  where sr.source_schema = 'legacy'
    and sr.source_table = 'prod_line'
    and sr.source_type = 'product_line_profile'
    and upper(sr.source_locale) = v_language_code
    and sr.is_active = true
    and not exists (
      select 1
      from rag.legacy_product_line_profile_source lplps
      where upper(lplps.language_code) = v_language_code
        and lplps.source_pk = sr.source_pk
    )
  order by sr.updated_at, sr.id
  limit v_batch_limit;

  update rag.source_record sr
     set is_active = false,
         last_seen_at = timezone('utc', now())
    from rag_profile_deactivate_candidates dc
   where dc.id = sr.id;

  get diagnostics v_deactivated_count = row_count;

  v_remaining_source_rows := case when v_source_rows_processed = v_batch_limit then 1 else 0 end;
  v_remaining_deactivations := case when v_deactivated_count = v_batch_limit then 1 else 0 end;

  return jsonb_build_object(
    'language_code', v_language_code,
    'batch_limit', v_batch_limit,
    'source_rows_processed', v_source_rows_processed,
    'source_records_upserted', v_source_count,
    'entities_upserted', v_entity_count,
    'documents_upserted', v_document_count,
    'source_records_deactivated', v_deactivated_count,
    'remaining_source_rows', v_remaining_source_rows,
    'remaining_deactivations', v_remaining_deactivations,
    'has_more', (v_remaining_source_rows + v_remaining_deactivations) > 0
  );
end;
$function$;
