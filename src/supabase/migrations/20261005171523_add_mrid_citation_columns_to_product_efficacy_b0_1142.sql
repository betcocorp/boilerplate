-- B0-1142 — attach EPA MRID (Master Record Identification) regulatory citations to
-- existing per-organism efficacy-claim rows in rag.product_efficacy, so answers citing
-- disinfectant efficacy can show which EPA-filed study backs each claim.
--
-- All four columns are NULLABLE and additive only. rag.product_efficacy is read by
-- src/lib/retrieval/product-facts.ts via an explicit column-list constant
-- (PRODUCT_EFFICACY_COLUMNS), not `select *`, so this is safe for that read path
-- without any code change.
--
-- mrid_number is intentionally NOT unique: a single MRID study can back multiple
-- organism rows (e.g. one AOAC use-dilution study often covers several organisms in
-- one project), and conversely some chemistry-type MRID studies could in principle
-- apply to more than one product_efficacy row. A non-unique index is sufficient for
-- the only query shape this needs (lookup by MRID number).
ALTER TABLE rag.product_efficacy
  ADD COLUMN mrid_number text,
  ADD COLUMN study_date date,
  ADD COLUMN laboratory_name text,
  ADD COLUMN guideline_code text;

CREATE INDEX idx_product_efficacy_mrid_number ON rag.product_efficacy (mrid_number);
