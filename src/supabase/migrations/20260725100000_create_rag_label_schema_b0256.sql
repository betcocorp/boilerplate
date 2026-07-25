-- B0-256: Create rag.label and rag.label_chunk schema
-- Phase 1: Label entity tables and backfill from existing documents
--
-- Schema:
--   rag.label: document-level label metadata (id, product_key, document_kind, is_discontinued, metadata, created_at)
--   rag.label_chunk: chunked label sections (id, label_id, chunk_index, section_type, chunk_text, token_count)
--
-- Backfill: Migrate all document_kind='label' rows from rag.document to rag.label_chunk

BEGIN;

-- Create rag.label table
CREATE TABLE rag.label (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_key TEXT NOT NULL,
  entity_id UUID REFERENCES rag.entity(id) ON DELETE SET NULL,
  document_kind TEXT NOT NULL DEFAULT 'label',
  is_discontinued BOOLEAN DEFAULT false,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_label_product_key ON rag.label(product_key);
CREATE INDEX idx_label_entity_id ON rag.label(entity_id);
CREATE INDEX idx_label_is_discontinued ON rag.label(is_discontinued);
CREATE INDEX idx_label_created_at ON rag.label(created_at);

-- Create rag.label_chunk table
CREATE TABLE rag.label_chunk (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label_id UUID NOT NULL REFERENCES rag.label(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  section_type TEXT,
  chunk_text TEXT NOT NULL,
  heading TEXT,
  section_path TEXT[] DEFAULT '{}'::text[],
  token_count INTEGER,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(label_id, chunk_index)
);

CREATE INDEX idx_label_chunk_label_id ON rag.label_chunk(label_id);
CREATE INDEX idx_label_chunk_section_type ON rag.label_chunk(section_type);
CREATE INDEX idx_label_chunk_created_at ON rag.label_chunk(created_at);
CREATE INDEX idx_label_chunk_text_tsvector ON rag.label_chunk USING GIN(to_tsvector('english'::regconfig, chunk_text));

-- Create trigger to auto-update rag.label.updated_at
CREATE OR REPLACE FUNCTION rag.update_label_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_label_updated_at_trigger
BEFORE UPDATE ON rag.label
FOR EACH ROW
EXECUTE FUNCTION rag.update_label_updated_at();

-- Backfill rag.label from rag.document where document_kind='label'
-- Extract product_key from entity_id or document metadata
INSERT INTO rag.label (id, product_key, entity_id, document_kind, metadata, created_at, updated_at)
SELECT
  gen_random_uuid(),
  COALESCE(e.product_key, (d.metadata->>'sku')) AS product_key,
  d.entity_id,
  d.document_kind,
  jsonb_build_object(
    'document_id', d.id,
    'document_key', d.document_key,
    'source_record_id', d.source_record_id,
    'brand', d.metadata->>'brand',
    'sku', d.metadata->>'sku',
    'epa_reg_no', d.metadata->>'epa_reg_no',
    'title', d.title,
    'body_markdown', d.body_markdown
  ) AS metadata,
  d.created_at,
  d.updated_at
FROM rag.document d
LEFT JOIN rag.entity e ON d.entity_id = e.id
WHERE d.document_kind = 'label'
  AND d.language_code = 'en'
  AND COALESCE(e.product_key, (d.metadata->>'sku')) IS NOT NULL
ON CONFLICT DO NOTHING;

-- Backfill rag.label_chunk from rag.document_chunk for label documents
INSERT INTO rag.label_chunk (id, label_id, chunk_index, section_type, chunk_text, heading, section_path, token_count, metadata, created_at, updated_at)
SELECT
  gen_random_uuid(),
  l.id,
  dc.chunk_index,
  dc.section_type,
  dc.chunk_text,
  dc.heading,
  dc.section_path,
  dc.token_count,
  jsonb_build_object(
    'chunk_id', dc.id,
    'chunk_key', dc.chunk_key,
    'brand', dc.metadata->>'brand',
    'sku', dc.metadata->>'sku'
  ) AS metadata,
  dc.created_at,
  dc.updated_at
FROM rag.document_chunk dc
INNER JOIN rag.document d ON dc.document_id = d.id
INNER JOIN rag.label l ON l.metadata->>'document_id' = d.id::text
WHERE d.document_kind = 'label'
  AND d.language_code = 'en'
ON CONFLICT DO NOTHING;

COMMIT;
