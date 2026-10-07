-- B0-464 RECONCILIATION BACKFILL — DDL applied live with no checked-in migration file.
-- Transcribed from the live catalog on 2026-08-27, not from memory.
--
-- B0-669 added the cached text-embedding-3-large vector to `public.routing_test_items` live with no
-- migration file; 20260825130000_create_routing_test_items_b0657.sql (the committed CREATE TABLE)
-- has no knowledge of these two columns, so scripts/check-schema-drift.mjs reported them as
-- `col-missing`.
--
-- halfvec(3072) matches the live type exactly: pgvector's `vector` caps at 2000 dimensions for
-- indexing, so text-embedding-3-large's 3072 dims are stored as halfvec here (same choice as the
-- rest of the RAG corpus). extensions.halfvec is provided by the already-installed `vector`
-- extension in schema `extensions`.
--
-- Every statement below is a NO-OP against the current live database.

alter table public.routing_test_items
  add column if not exists embedding_large extensions.halfvec(3072);
alter table public.routing_test_items
  add column if not exists embedding_model_large text;

comment on column public.routing_test_items.embedding_large is
  'B0-669 — text-embedding-3-large embedding of prompt, recomputed only when prompt changes.';
comment on column public.routing_test_items.embedding_model_large is
  'B0-669 — model name paired with embedding_large; both are set to null together if embedding generation fails.';
