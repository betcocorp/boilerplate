-- B0-257 (scope addition, 2026-07-20 design review): near-duplicate suppression
-- across sources. The app layer needs real cosine similarity between candidate
-- chunks (not just each chunk's similarity to the query) to detect overlapping
-- ingredients/hazards/first-aid content across product/SDS/label documents for
-- the same product + section_type. pgvector's `<=>` cosine-distance operator
-- already exists on rag.document_chunk.embedding_large; this RPC exposes it for
-- a small, app-supplied candidate set rather than pulling raw vectors client-side.
--
-- New function (no existing overload to collide with), so CREATE OR REPLACE is
-- safe here -- unlike match_corpus_chunks*/match_product_chunks*, which must be
-- DROP + CREATE per the landmine documented earlier in this epic.
create or replace function rag.compute_chunk_pairwise_similarity(p_chunk_ids uuid[])
returns table (chunk_id_a uuid, chunk_id_b uuid, cosine_similarity double precision)
language sql
stable
security definer
set search_path = rag, public, extensions
as $$
  select
    a.id as chunk_id_a,
    b.id as chunk_id_b,
    1 - (a.embedding_large <=> b.embedding_large) as cosine_similarity
  from rag.document_chunk a
  join rag.document_chunk b on b.id > a.id
  where a.id = any(p_chunk_ids)
    and b.id = any(p_chunk_ids)
    and a.embedding_large is not null
    and b.embedding_large is not null;
$$;

revoke execute on function rag.compute_chunk_pairwise_similarity(uuid[]) from public, anon, authenticated;
grant execute on function rag.compute_chunk_pairwise_similarity(uuid[]) to service_role;
