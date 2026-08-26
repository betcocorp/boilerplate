-- B0-686 — rag.chunk_token_stats(): single-scan corpus token statistics for
-- /admin/products/rag/chunking.
--
-- WHY: PostgREST aggregate functions are disabled project-wide (PGRST123 "Use of aggregate
-- functions is not allowed") and db-max-rows is 1000, so the page had to compute these numbers
-- with a 29-request paged sweep of rag.document_chunk behind a 15-minute unstable_cache. This
-- collapses that to one row from one sequential scan.
--
-- CONTRACT (must stay in lockstep with the app's ChunkTokenStats type):
--   * A NULL token_count counts as 0, matching the TS `row.token_count ?? 0`. It therefore lands
--     in the `under100` bucket and drags `avg_tokens`/`min_tokens` down exactly as today —
--     switching the page over must not shift a single number.
--   * Bucket boundaries mirror the TS exactly: <100, 100-299, 300-599, 600-999, >=1000.
--   * An empty table returns zeros, never nulls (min/max are coalesced; avg is guarded against
--     divide-by-zero).
--
-- SECURITY INVOKER, like the four match RPCs over this same table — rag.document_chunk has RLS
-- enabled and only postgres/service_role hold USAGE on schema rag, so no privilege is widened.
-- No statement_timeout is pinned: the scan is ~29k rows / a few milliseconds (measured), well
-- inside any caller default.

create or replace function rag.chunk_token_stats()
returns jsonb
language sql
stable
security invoker
set search_path to 'rag', 'pg_catalog'
as $function$
  -- One pass over the table; every bucket is a FILTER on the same scan.
  with agg as (
    select
      count(*)::bigint as total_chunks,
      coalesce(sum(coalesce(dc.token_count, 0)), 0)::numeric as sum_tokens,
      coalesce(min(coalesce(dc.token_count, 0)), 0)::integer as min_tokens,
      coalesce(max(coalesce(dc.token_count, 0)), 0)::integer as max_tokens,
      count(*) filter (where coalesce(dc.token_count, 0) < 100)::bigint as under100,
      count(*) filter (where coalesce(dc.token_count, 0) between 100 and 299)::bigint as from100to299,
      count(*) filter (where coalesce(dc.token_count, 0) between 300 and 599)::bigint as from300to599,
      count(*) filter (where coalesce(dc.token_count, 0) between 600 and 999)::bigint as from600to999,
      count(*) filter (where coalesce(dc.token_count, 0) >= 1000)::bigint as over1000
    from rag.document_chunk dc
  )
  select jsonb_build_object(
    'total_chunks', a.total_chunks,
    'avg_tokens', case
      when a.total_chunks = 0 then 0
      else round(a.sum_tokens / a.total_chunks)::integer
    end,
    'min_tokens', a.min_tokens,
    'max_tokens', a.max_tokens,
    'distribution', jsonb_build_object(
      'under100', a.under100,
      'from100to299', a.from100to299,
      'from300to599', a.from300to599,
      'from600to999', a.from600to999,
      'over1000', a.over1000
    )
  )
  from agg a;
$function$;

comment on function rag.chunk_token_stats() is
  'B0-686: single-scan token statistics over rag.document_chunk for the RAG chunking admin page. NULL token_count counts as 0 (matches the TS `?? 0`); buckets are <100 / 100-299 / 300-599 / 600-999 / >=1000; empty table returns zeros.';

-- Grants: same pattern as rag.resolve_boost_weights — drop the default PUBLIC execute, grant only
-- service_role (how the app invokes rag routines server-side). anon/authenticated hold no USAGE on
-- schema rag, so this is belt-and-braces.
revoke execute on function rag.chunk_token_stats() from public, anon, authenticated;
grant execute on function rag.chunk_token_stats() to service_role;
