-- B0-794: a standing surface for the SDS content-language check.
--
-- This is the third corpus-scope false negative found by hand (B0-243, B0-283, B0-794).
-- Each time, the documents were sitting in the retrievable corpus and nothing said so.
-- The detector itself cannot live in SQL -- language detection is `franc` in
-- `evaluateSdsContentLanguage`, and that stays the authoritative gate -- so this view
-- does the half SQL can do: it enumerates exactly the SDS documents that ARE retrievable
-- right now, and hands out a body sample cheap enough to run the detector over all of
-- them in one pass.
--
-- `body_sample` is the first 4,000 characters, which always covers GHS section 1 (the
-- product identifier, "SAFETY DATA SHEET" / "FICHA DE DATOS DE SEGURIDAD" /
-- "FICHE DE DONNEES DE SECURITE" header and the hazard block) -- far more than franc
-- needs, while keeping a full scan to a few MB instead of ~30MB of body_text.
--
-- ROOT CAUSE this also exposes: `parseSdsFile` in pipeline.ts ALREADY calls
-- `evaluateSdsContentLanguage` on every SDS it parses and stores the answer in
-- rag.document.metadata (`language_detected` / `language_detection_code` /
-- `language_policy_mismatch`). All 1,526 previously-retrievable SDS carried that verdict
-- and 363 of them said `language_policy_mismatch = true`. The gate was never missing and
-- never un-run -- it ran, it was right, and nothing consumed its answer. So
-- `recorded_language_mismatch` below makes the cheapest form of this check a one-line SQL
-- query needing no language library at all.
--
-- Consumed by `src/app/(authenticated)/admin/sds/sds-content-language.test.ts`, which
-- fails loudly if any row here is confidently non-English.
--
-- The membership predicate is the real retrieval gate, copied from the four match_* RPCs:
-- source_record.is_active = true AND upper(language_code) = 'EN'. Documents are listed
-- even when they have no chunks yet, so a newly ingested foreign-language sheet is caught
-- before it is embedded rather than after.

CREATE OR REPLACE VIEW rag.retrievable_sds_language_audit AS
SELECT
  d.id                                   AS document_id,
  d.document_key,
  d.title,
  d.language_code,
  sr.source_pk,
  d.metadata ->> 's3_key'                AS s3_key,
  length(d.body_text)                    AS body_text_length,
  "left"(d.body_text, 4000)              AS body_sample,
  (SELECT count(*) FROM rag.document_chunk dc WHERE dc.document_id = d.id) AS chunk_count,
  -- Verdict recorded by the ingestion pipeline at parse time (may be absent on rows
  -- ingested before that instrumentation existed).
  d.metadata ->> 'language_detection_code'          AS recorded_detection_code,
  (d.metadata ->> 'language_policy_mismatch')::boolean AS recorded_language_mismatch
FROM rag.document d
JOIN rag.source_record sr ON sr.id = d.source_record_id
WHERE d.document_kind = 'sds'
  AND sr.is_active = true
  AND upper(coalesce(d.language_code, '')) = 'EN';

COMMENT ON VIEW rag.retrievable_sds_language_audit IS
  'B0-794: every SDS document currently retrievable by the match_* RPCs. '
  'recorded_language_mismatch is the verdict ingestion already stored; any true row is a '
  'corpus-scope defect. body_sample lets evaluateSdsContentLanguage re-derive it. '
  'See src/app/(authenticated)/admin/sds/sds-content-language.test.ts.';

GRANT SELECT ON rag.retrievable_sds_language_audit TO authenticated, service_role;
