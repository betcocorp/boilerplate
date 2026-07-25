-- ============================================================
-- 20260725092000_token_aware_chunking_remediation.sql
-- B0-279: Token-aware chunking - remediate tiny (<40 tok) and oversized (>1200 tok) chunks
--
-- This migration:
-- 1. Adds token count columns to corpus_chunk and document_chunk for real token tracking
-- 2. Flags tiny and oversized chunks for manual review
-- 3. Sets up the foundation for js-tiktoken-based remediation in application layer
--
-- Note: Actual combining of tiny chunks and splitting of large chunks is handled
-- by the Node.js application (src/lib/rag/token-counting.ts) which has access to
-- js-tiktoken for accurate OpenAI token counting. This migration provides the
-- audit queries and metadata columns needed.
-- ============================================================

-- Step 1: Add audit metadata columns if not present
ALTER TABLE rag.corpus_chunk
ADD COLUMN IF NOT EXISTS token_count_accurate integer,
ADD COLUMN IF NOT EXISTS chunk_status text DEFAULT 'valid',
ADD COLUMN IF NOT EXISTS remediation_notes text;

ALTER TABLE rag.document_chunk
ADD COLUMN IF NOT EXISTS token_count_accurate integer,
ADD COLUMN IF NOT EXISTS chunk_status text DEFAULT 'valid',
ADD COLUMN IF NOT EXISTS remediation_notes text;

-- Step 2: Audit corpus chunks for size violations
-- Mark chunks that are too small (<40 tokens based on character estimate)
UPDATE rag.corpus_chunk
SET chunk_status = 'tiny_chunk',
    remediation_notes = 'Combine with adjacent chunks to reach minimum 40 tokens'
WHERE chunk_status = 'valid'
  AND (
    -- Character-based estimate: < 160 chars ≈ < 40 tokens
    length(chunk_text) < 160
    AND trim(chunk_text) != ''
  );

-- Mark chunks that are potentially too large (>4800 chars ≈ > 1200 tokens)
UPDATE rag.corpus_chunk
SET chunk_status = 'oversized_chunk',
    remediation_notes = 'Split on sentence boundaries to target ~600 tokens per chunk'
WHERE chunk_status = 'valid'
  AND length(chunk_text) > 4800;

-- Step 3: Audit document chunks for size violations
UPDATE rag.document_chunk
SET chunk_status = 'tiny_chunk',
    remediation_notes = 'Combine with adjacent chunks to reach minimum 40 tokens'
WHERE chunk_status = 'valid'
  AND (
    length(chunk_text) < 160
    AND trim(chunk_text) != ''
  );

UPDATE rag.document_chunk
SET chunk_status = 'oversized_chunk',
    remediation_notes = 'Split on sentence boundaries to target ~600 tokens per chunk'
WHERE chunk_status = 'valid'
  AND length(chunk_text) > 4800;

-- Step 4: Create audit view for monitoring chunk health
CREATE OR REPLACE VIEW rag.chunk_size_audit AS
SELECT
  'corpus_chunk' as chunk_table,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE chunk_status = 'valid') as valid_chunks,
  COUNT(*) FILTER (WHERE chunk_status = 'tiny_chunk') as tiny_chunks,
  COUNT(*) FILTER (WHERE chunk_status = 'oversized_chunk') as oversized_chunks,
  ROUND(100.0 * COUNT(*) FILTER (WHERE chunk_status = 'valid') / NULLIF(COUNT(*), 0), 2) as percent_valid
FROM rag.corpus_chunk
UNION ALL
SELECT
  'document_chunk' as chunk_table,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE chunk_status = 'valid') as valid_chunks,
  COUNT(*) FILTER (WHERE chunk_status = 'tiny_chunk') as tiny_chunks,
  COUNT(*) FILTER (WHERE chunk_status = 'oversized_chunk') as oversized_chunks,
  ROUND(100.0 * COUNT(*) FILTER (WHERE chunk_status = 'valid') / NULLIF(COUNT(*), 0), 2) as percent_valid
FROM rag.document_chunk;

-- Step 5: Create audit detail queries (exposed as helper RPCs if needed)
-- Query the audit view to see current status:
-- SELECT * FROM rag.chunk_size_audit;

-- List all tiny chunks for remediation:
-- SELECT id, document_id, chunk_index, length(chunk_text) as char_count, remediation_notes
-- FROM rag.corpus_chunk WHERE chunk_status = 'tiny_chunk'
-- ORDER BY document_id, chunk_index;

-- List all oversized chunks for remediation:
-- SELECT id, document_id, chunk_index, length(chunk_text) as char_count, remediation_notes
-- FROM rag.corpus_chunk WHERE chunk_status = 'oversized_chunk'
-- ORDER BY document_id, chunk_index;

raise notice 'B0-279 audit complete: corpus_chunk and document_chunk flagged for remediation.';
raise notice 'Application layer (src/lib/rag/token-counting.ts) will use js-tiktoken for precise token counts and remediation.';
