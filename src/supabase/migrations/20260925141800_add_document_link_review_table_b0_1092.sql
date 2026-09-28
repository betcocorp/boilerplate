-- B0-1092: review queue for document -> product-line links that could not be made automatically.
--
-- The B0-1092 linking migrations (labels via sds_number/sku line ids, SDS via product_code stem
-- and legacy.documents) only write rag.document.entity_id when independent keys agree on ONE
-- product line. Anything that resolves by a single key, or where the keys disagree, lands here
-- with every candidate so a human can decide. Rows are inserted ON CONFLICT DO NOTHING per
-- (document_id, ticket), so the linking migrations stay idempotent.
--
-- candidate_lines is a jsonb array of {key, value, prod_line_id, product_line_key}: one element
-- per key that was derived from the document's metadata, with prod_line_id/product_line_key null
-- when that key did not resolve to a rag.entity product_line row.
--
-- Not consumed by any UI yet; it is a queryable ledger for /admin/products/orphans follow-up.

CREATE TABLE rag.document_link_review (
  document_id uuid NOT NULL REFERENCES rag.document(id) ON DELETE CASCADE,
  document_kind text NOT NULL,
  candidate_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text NOT NULL CHECK (reason IN ('single_key', 'key_conflict')),
  ticket text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, ticket)
);

COMMENT ON TABLE rag.document_link_review IS
  'B0-1092: human-review queue for rag.document rows whose product-line link could not be made '
  'automatically (only one key resolved, or the keys disagreed). candidate_lines lists every '
  'candidate {key, value, prod_line_id, product_line_key}. Written by linking migrations only; '
  'a row here means the document was deliberately left with entity_id IS NULL.';

GRANT SELECT ON rag.document_link_review TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON rag.document_link_review TO service_role;
