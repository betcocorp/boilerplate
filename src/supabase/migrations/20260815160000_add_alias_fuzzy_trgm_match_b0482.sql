-- B0-482: pg_trgm GIN index + fuzzy alias lookup RPC for typo/partial-match resolution.
--
-- pg_trgm 1.6 is already installed on this project (schema `extensions`) -- verified live via
-- list_extensions before writing this migration, not assumed from the ticket text.
--
-- Adds a GIN trigram index on `rag.product_alias.alias_norm` (mirroring the existing
-- `extensions.gin_trgm_ops`-qualified indexes on rag.search_query_cache, see
-- 20260406230000_add_approximate_search_embedding_lookup.sql) plus a SECURITY INVOKER RPC that
-- ranks candidates by trigram similarity. Follows the SECURITY INVOKER + pinned search_path +
-- service_role-only grant pattern established by 20260725091000_convert_security_definer_to_invoker.sql
-- and the lockdown conventions in 20260722061000_rag_security_lockdown_rpc_grants_search_path.sql
-- (revoke from PUBLIC/anon/authenticated, grant only to service_role -- the app's own client role).
--
-- This is a brand-new function (no existing overload of this name/signature), so
-- CREATE OR REPLACE is safe here -- unlike match_corpus_chunks*/match_product_chunks*, which have
-- a documented DROP+CREATE landmine for *added parameters* on an existing signature.

create index if not exists product_alias_alias_norm_trgm_idx
  on rag.product_alias using gin (alias_norm extensions.gin_trgm_ops);

comment on index rag.product_alias_alias_norm_trgm_idx is
  'B0-482: trigram GIN index backing rag.match_product_alias_fuzzy for typo/partial-match alias resolution.';

create or replace function rag.match_product_alias_fuzzy(
  query text,
  similarity_threshold real default 0.35,
  max_results int default 5
)
returns table (
  alias_norm text,
  alias text,
  product_line_key text,
  entity_id uuid,
  verified boolean,
  alias_type text,
  confidence numeric,
  similarity real
)
language plpgsql
security invoker
set search_path = rag, extensions, public, pg_catalog
as $$
declare
  v_query text := lower(trim(query));
begin
  if v_query = '' then
    return;
  end if;

  -- `%`/`similarity()` compare against the session's current similarity_threshold GUC
  -- (pg_trgm's `set_limit`), not a query-time constant -- pin it to the caller's requested
  -- threshold so the GIN index (`%`-indexable) and the returned `similarity` column agree on
  -- what "above threshold" means for this call.
  perform set_limit(similarity_threshold);

  return query
  select
    pa.alias_norm,
    pa.alias,
    pa.product_line_key,
    pa.entity_id,
    pa.verified,
    pa.alias_type,
    pa.confidence,
    similarity(pa.alias_norm, v_query)::real as similarity
  from rag.product_alias pa
  where pa.alias_norm % v_query
  order by similarity desc
  limit max_results;
end;
$$;

comment on function rag.match_product_alias_fuzzy(text, real, int) is
  'B0-482: trigram-similarity fuzzy alias lookup for typo/partial-match product-name resolution. Ranked candidates only, no accept/reject decision -- callers (resolveProductEntityByName) apply their own threshold + ambiguity gating.';

revoke execute on function rag.match_product_alias_fuzzy(text, real, int) from public, anon, authenticated;
grant execute on function rag.match_product_alias_fuzzy(text, real, int) to service_role;
