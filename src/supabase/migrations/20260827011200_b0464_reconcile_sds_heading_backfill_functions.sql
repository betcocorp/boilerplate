-- B0-464 RECONCILIATION BACKFILL — DDL applied live with no checked-in migration file.
-- Transcribed verbatim from pg_get_functiondef() on 2026-08-27, not from memory.
--
-- 20260515123000_sds_section_heading_enrichment.sql committed the *procedure*
-- rag.enrich_sds_section_headings(int). The two FUNCTIONS below were applied live afterwards and
-- never committed:
--
--   * rag.enrich_sds_section_headings_batch(p_batch_size integer) — the single-batch, jsonb-returning
--     variant the app calls. scripts/check-schema-drift.mjs reported this as `fn-param`
--     (p_batch_size named in no migration that also names this function) because
--     20260722061000_rag_security_lockdown_… only ALTERs it.
--   * rag.run_bulk_sds_heading_backfill() — one-shot full backfill; surfaced by the tightened
--     `fn-missing` check added in this ticket.
--
-- Note the regex differs from the committed procedure's: live uses the literal `Sección`, the
-- procedure uses `Secci[oó]n`. Transcribed as-is — this is regulated-adjacent extraction logic and
-- must not be "harmonised" inside a reconciliation backfill.
--
-- Both signatures match live exactly (verified against pg_get_function_identity_arguments before
-- and after), so CREATE OR REPLACE replaces rather than creating a second overload — the
-- 59f118f1 landmine this ticket exists to prevent.
--
-- Every statement below is a NO-OP against the current live database.

create or replace function rag.enrich_sds_section_headings_batch(p_batch_size integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = rag, public
set statement_timeout = '250s'
as $$
DECLARE
  v_updated integer;
BEGIN
  WITH candidates AS (
    SELECT dc.id
    FROM rag.document_chunk dc
    JOIN rag.document d ON d.id = dc.document_id
    WHERE d.document_kind = 'sds'
      AND (dc.heading IS NULL OR dc.heading = 'SDS content')
    LIMIT p_batch_size
  ),
  extracted AS (
    SELECT
      dc.id,
      regexp_match(
        dc.chunk_text,
        E'(?:Section|Sección|SECTION)\\s+(\\d{1,2})[.:]\\s+([^\\n.]{3,80})',
        'i'
      ) AS section_match
    FROM rag.document_chunk dc
    WHERE dc.id IN (SELECT id FROM candidates)
  )
  UPDATE rag.document_chunk dc
  SET
    heading = CASE
      WHEN e.section_match IS NOT NULL
        THEN concat('Section ', e.section_match[1], '. ', trim(e.section_match[2]))
      ELSE ''
    END,
    section_path = CASE
      WHEN e.section_match IS NOT NULL
        THEN ARRAY['sds', concat('section_', e.section_match[1])]::text[]
      ELSE section_path
    END
  FROM extracted e
  WHERE dc.id = e.id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Avoid a full-table COUNT every pass. If we processed a full batch there is
  -- almost certainly more work; if fewer rows updated than requested we are done.
  RETURN jsonb_build_object(
    'chunksEnriched',  v_updated,
    'remainingChunks', -1,
    'hasMore',         v_updated >= p_batch_size
  );
END;
$$;

create or replace function rag.run_bulk_sds_heading_backfill()
returns jsonb
language plpgsql
security definer
set search_path = rag, public
set statement_timeout = '0'
as $$
DECLARE
  v_updated integer;
BEGIN
  DROP INDEX IF EXISTS rag.document_chunk_search_vector_idx;

  UPDATE rag.document_chunk dc
  SET
    heading = CASE
      WHEN m.section_match IS NOT NULL
        THEN concat('Section ', m.section_match[1], '. ', trim(m.section_match[2]))
      ELSE ''
    END,
    section_path = CASE
      WHEN m.section_match IS NOT NULL
        THEN ARRAY['sds', concat('section_', m.section_match[1])]::text[]
      ELSE dc.section_path
    END
  FROM (
    SELECT
      dc2.id,
      regexp_match(
        dc2.chunk_text,
        E'(?:Section|Sección|SECTION)\\s+(\\d{1,2})[.:]\\s+([^\\n.]{3,80})',
        'i'
      ) AS section_match
    FROM rag.document_chunk dc2
    JOIN rag.document d ON d.id = dc2.document_id
    WHERE d.document_kind = 'sds'
      AND (dc2.heading IS NULL OR dc2.heading = 'SDS content')
  ) m
  WHERE dc.id = m.id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  DROP INDEX IF EXISTS rag.document_chunk_heading_pending_idx;

  CREATE INDEX document_chunk_search_vector_idx
    ON rag.document_chunk USING gin(search_vector);

  RETURN jsonb_build_object('rowsUpdated', v_updated);
END;
$$;

-- Live ACL for both is {postgres=X, service_role=X}: PUBLIC revoked, service_role granted.
revoke execute on function rag.enrich_sds_section_headings_batch(integer) from public, anon, authenticated;
grant execute on function rag.enrich_sds_section_headings_batch(integer) to service_role;
revoke execute on function rag.run_bulk_sds_heading_backfill() from public, anon, authenticated;
grant execute on function rag.run_bulk_sds_heading_backfill() to service_role;
