-- REC-2 / REC-3 — Structured product attributes for attribute-enriched hybrid retrieval
-- and EPA-registration cross-referencing over the Betco catalog.
--
-- STATUS: APPLIED 2026-07-13 to project gbkobtatfsjibkxebvdw (via the Supabase management API).
-- Additive columns + indexes to hard-filter retrieval by chemistry class / application and to
-- match on EPA registrant. Backfill of chemistry_class/product_application follows in
-- 20260713031000. It intentionally does NOT rewrite the `rag.match_corpus_chunks*` functions
-- (see the "FOLLOW-UP" block at the bottom) — that change to the shared production search path
-- is staged for review and depends on curating the heuristic backfill first.
--
-- Before this delivers value you also need (data-gated, out of this file):
--   1. A source of chemistry_class + epa_registration per Betco product line. These do NOT
--      exist in `legacy.prod_line` today, so they must be sourced/curated upstream.
--   2. A backfill that populates the new columns (from that source, or via the deterministic
--      extractor in src/lib/websearch/extract-competitor-spec.ts run over the profile bodies).
--   3. A re-embed pass (`syncDocumentChunkEmbeddings`) is NOT required for these columns
--      (they are hard-filters, not embedded text), but IS required if chemistry/application
--      text is also folded into chunk_text.
--
-- Attributes live on `rag.document` (one row per product-line profile), which the match
-- functions already join; filtering on the joined document columns avoids per-chunk duplication.

alter table rag.document
  add column if not exists chemistry_class text,
  add column if not exists product_application text,
  add column if not exists epa_registration text,
  add column if not exists contact_time_seconds integer,
  add column if not exists dilution_oz_per_gal numeric;

-- EPA registrant = the registrant prefix before the first hyphen (e.g. 6836-348 -> 6836).
-- Generated + stored so it stays in sync and is directly indexable for same-registrant matches
-- (BNC-15 6836-348 <-> Triforce 6836-349). Mirrors epaRegistrant() in competitive-analysis.ts.
alter table rag.document
  add column if not exists epa_registrant text
  generated always as (nullif(split_part(epa_registration, '-', 1), '')) stored;

comment on column rag.document.chemistry_class is
  'Normalized disinfectant/cleaner chemistry class (quat, peroxide, hypochlorite, phenolic, alcohol, acid, other) — REC-2 hard filter.';
comment on column rag.document.product_application is
  'Normalized primary application/category (e.g. disinfectant, degreaser, floor-finish) — REC-2 hard filter.';
comment on column rag.document.epa_registration is
  'EPA registration number as printed on the label (e.g. 6836-349) — REC-3 cross-reference key.';
comment on column rag.document.epa_registrant is
  'Generated registrant prefix of epa_registration — REC-3 same-registrant matching.';
comment on column rag.document.contact_time_seconds is
  'Label kill/contact time in seconds, when known.';
comment on column rag.document.dilution_oz_per_gal is
  'Use-dilution in oz per gallon, when known (drives cost-in-use comparison).';

create index if not exists document_chemistry_class_idx
  on rag.document (chemistry_class)
  where chemistry_class is not null;
create index if not exists document_product_application_idx
  on rag.document (product_application)
  where product_application is not null;
create index if not exists document_epa_registrant_idx
  on rag.document (epa_registrant)
  where epa_registrant is not null;

-- =====================================================================================
-- FOLLOW-UP (do NOT run from this file — needs the live function body):
--
-- The live rag.match_corpus_chunks / match_corpus_chunks_hybrid signatures currently are
-- (per src/types/supabase.rag.ts, which mirrors the live schema):
--   match_corpus_chunks(query_embedding, match_count, filter_product_line_key,
--                       filter_scope, filter_section_type)
--   match_corpus_chunks_hybrid(query_embedding, query_text, match_count,
--                              filter_product_line_key, filter_scope, filter_section_type)
--
-- To enable REC-2 hard-filtering, dump the live body (supabase db dump / pg_get_functiondef)
-- and add these optional params + predicates against the joined `rag.document`:
--
--   create or replace function rag.match_corpus_chunks_hybrid(
--     ...existing params...,
--     filter_chemistry_class text default null,
--     filter_product_application text default null,
--     filter_epa_registrant text default null
--   ) returns table (...existing cols..., chemistry_class text, epa_registration text)
--   ... as $$
--     ... existing query, joined to rag.document d, with:
--       and (filter_chemistry_class is null or d.chemistry_class = filter_chemistry_class)
--       and (filter_product_application is null or d.product_application = filter_product_application)
--       and (filter_epa_registrant is null or d.epa_registrant = filter_epa_registrant)
--   $$;
--
-- Then thread filter_chemistry_class / filter_product_application / filter_epa_registrant
-- through SearchProductChunksOptions + callMatchRpc in src/lib/rag/search.ts (send the args
-- only when provided, behind a flag, so behavior is unchanged until the function is updated).
-- =====================================================================================
