-- B0-464 RECONCILIATION BACKFILL — DDL applied live with no checked-in migration file.
-- Transcribed verbatim from pg_get_functiondef() on 2026-08-27, not from memory.
--
-- THIS IS THE FRESHEST INSTANCE OF THE BUG B0-464 IS ABOUT. B0-696 (commit ab40c033, 2026-08-26)
-- added the `include_unverified boolean default false` parameter to rag.match_product_alias_fuzzy
-- and applied it live — the live supabase_migrations ledger carries a row named
-- `gate_unverified_aliases_in_match_product_alias_fuzzy_b0696` — but the migration file was never
-- committed. Only the TypeScript half of ab40c033 is in git.
-- scripts/check-schema-drift.mjs reported it as `fn-param` (include_unverified named in no
-- migration that also names the function).
--
-- OVERLOAD LANDMINE: the committed 20260815160000_add_alias_fuzzy_trgm_match_b0482.sql creates the
-- THREE-argument (text, real, int) form. B0-696 dropped that form and created the four-argument
-- form. On a rebuild, this file must do the same or the two all-defaults signatures coexist and
-- every call becomes ambiguous — the exact 59f118f1 failure that drove tool_failed from 0.6% to
-- 45.6% for 11 days.
--
-- The DROP below is a no-op against live: DROP FUNCTION matches an exact argument-type list, and
-- live only has (text, real, integer, boolean). Verified pg_get_function_identity_arguments before
-- and after: `query text, similarity_threshold real, max_results integer, include_unverified boolean`.
--
-- Every statement below is a NO-OP against the current live database.

drop function if exists rag.match_product_alias_fuzzy(text, real, int);

create or replace function rag.match_product_alias_fuzzy(
  query text,
  similarity_threshold real default 0.35,
  max_results integer default 5,
  include_unverified boolean default false
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
set search_path = rag, extensions, public, pg_catalog
as $$
declare
  v_query text := lower(trim(query));
begin
  if v_query = '' then
    return;
  end if;

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
    and (include_unverified or pa.verified)
  order by
    similarity(pa.alias_norm, v_query) desc,
    pa.verified desc,
    pa.confidence desc,
    pa.alias_norm asc
  limit max_results;
end;
$$;

comment on function rag.match_product_alias_fuzzy(text, real, integer, boolean) is
  'B0-696: trigram alias lookup. Returns VERIFIED aliases only unless include_unverified is true; callers on the retrieval path must never opt in. Ordering is deterministic and always prefers a verified row over an unverified one at equal similarity.';

revoke execute on function rag.match_product_alias_fuzzy(text, real, integer, boolean) from public, anon, authenticated;
grant execute on function rag.match_product_alias_fuzzy(text, real, integer, boolean) to service_role;
