-- ============================================================
-- 20260522122000_chunk_enrichment_fields.sql
--
-- Backfills structured enrichment fields into chunk metadata:
--
--   P4: product_line_key  — denormalized from document→entity
--       into SDS chunk metadata (already in PLP metadata).
--
--   P3: dilution_ratio    — regex-extracted from chunk text.
--       Targets SDS sections and PLP directions-for-use sections.
--       Matches "1:X" ratios, "X oz per gallon", "ready-to-use".
--
--   P3: surface_type      — regex-extracted from chunk text.
--       Captures the first "for use on …" or "apply to … surface"
--       phrase found in the chunk. Stored as a short text value.
--
--   P5: dwell_time        — regex-extracted from chunk text.
--       Matches "dwell time of N min/sec" and similar patterns.
--       Only 10 chunks currently mention dwell; included for
--       completeness in the extraction pass.
--
-- All four updates operate only on active EN corpus chunks and
-- skip chunks that already have the field set.  Safe to re-run.
-- ============================================================


-- ── P4: product_line_key into SDS chunks ─────────────────────────────────────
--
-- SDS documents link to rag.entity via document.entity_id.
-- Copy entity.product_line_key into chunk metadata so it is
-- available at the chunk level without a join at query time.

UPDATE rag.document_chunk dc
SET metadata = dc.metadata || jsonb_build_object('product_line_key', e.product_line_key)
FROM rag.document d
JOIN rag.entity   e  ON e.id  = d.entity_id
JOIN rag.source_record sr ON sr.id = d.source_record_id
WHERE d.id            = dc.document_id
  AND d.document_kind = 'sds'
  AND sr.is_active    = true
  AND upper(coalesce(d.language_code, '')) = 'EN'
  AND e.product_line_key IS NOT NULL
  AND NOT (dc.metadata ? 'product_line_key');


-- ── P3 + P5: dilution_ratio, surface_type, dwell_time ────────────────────────
--
-- Single pass over all active EN chunks that mention any target keyword.
-- Uses regexp_match() so only the captured group is stored (not the
-- full sentence), keeping metadata values short and query-friendly.
-- NULL values are stripped by jsonb_strip_nulls so unmatched fields
-- add no metadata key.

UPDATE rag.document_chunk dc
SET metadata = dc.metadata || jsonb_strip_nulls(
  jsonb_build_object(

    -- dilution_ratio: prefer explicit ratio notation, fall back to
    -- oz-per-gallon concentration, then "ready-to-use" label.
    -- NOTE: PostgreSQL POSIX regex uses \y for word boundary, not \b (\b = backspace).
    'dilution_ratio',
    CASE
      WHEN dc.metadata ? 'dilution_ratio' THEN NULL   -- already set; skip
      WHEN dc.chunk_text ~* '\y1\s*:\s*[0-9]+\y' THEN
        (regexp_match(dc.chunk_text, '\y(1\s*:\s*[0-9]+)\y', 'i'))[1]
      WHEN dc.chunk_text ~* '\y[0-9]+(\.[0-9]+)?\s*oz\s*(per|/)\s*gal' THEN
        lower((regexp_match(
          dc.chunk_text,
          '\y([0-9]+(\.[0-9]+)?\s*oz\.?\s*(per|/)\s*gal(lon)?)\y', 'i'
        ))[1])
      WHEN dc.chunk_text ~* '\yready.to.use\y' THEN 'ready-to-use'
      ELSE NULL
    END,

    -- surface_type: first surface phrase from common patterns.
    -- Captures up to 60 chars after the trigger phrase, trimmed.
    'surface_type',
    CASE
      WHEN dc.metadata ? 'surface_type' THEN NULL   -- already set; skip
      WHEN dc.chunk_text ~* '(?:for use on|safe (?:for|on)|apply (?:to|on)|use on)\s+\S' THEN
        trim(left(
          (regexp_match(
            dc.chunk_text,
            '(?:for use on|safe (?:for|on)|apply (?:to|on)|use on)\s+([^.\n;,]{3,60})', 'i'
          ))[1],
          60
        ))
      WHEN dc.chunk_text ~* 'compatible with\s+\S' THEN
        trim(left(
          (regexp_match(
            dc.chunk_text,
            'compatible with\s+([^.\n;,]{3,60})', 'i'
          ))[1],
          60
        ))
      ELSE NULL
    END,

    -- dwell_time: "dwell time of N min" / "N-minute dwell" patterns.
    'dwell_time',
    CASE
      WHEN dc.metadata ? 'dwell_time' THEN NULL   -- already set; skip
      WHEN dc.chunk_text ~* '\ydwell\s*time\s*(of\s*)?[0-9]' THEN
        trim((regexp_match(
          dc.chunk_text,
          '\ydwell\s*time\s*(of\s*)?([0-9]+(\.[0-9]+)?\s*(min(utes?)?|sec(onds?)?|hours?))', 'i'
        ))[2])
      WHEN dc.chunk_text ~* '\y[0-9]+[\s-]minute\s+(contact|dwell)\y' THEN
        trim((regexp_match(
          dc.chunk_text,
          '\y([0-9]+(\.[0-9]+)?[\s-]minute\s+(contact|dwell))', 'i'
        ))[1])
      ELSE NULL
    END

  )
)
FROM rag.document d
JOIN rag.source_record sr ON sr.id = d.source_record_id
WHERE d.id         = dc.document_id
  AND sr.is_active = true
  AND upper(coalesce(d.language_code, '')) = 'EN'
  AND (
    dc.chunk_text ~* '\y1\s*:\s*[0-9]+'
    OR dc.chunk_text ~* '\y[0-9]+(\.[0-9]+)?\s*oz\s*(per|/)\s*gal'
    OR dc.chunk_text ~* '\yready.to.use\y'
    OR dc.chunk_text ~* '\ydilut'
    OR dc.chunk_text ~* '\ysurface\y'
    OR dc.chunk_text ~* 'for use on'
    OR dc.chunk_text ~* 'compatible with'
    OR dc.chunk_text ~* '\ydwell\y'
  );
