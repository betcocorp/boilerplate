-- B0-686 — boost-weight resolution helpers for the rag match RPCs.
--
-- public.settings has RLS enabled and the match RPCs are SECURITY INVOKER, so a non-service_role
-- caller reading public.settings directly from inside a match RPC would see zero rows. Hence
-- rag.resolve_boost_weights() is SECURITY DEFINER with a pinned search_path.
--
-- resolve_boost_weights() is TOTAL: a missing row, a non-numeric value, or any error yields the
-- documented default instead of throwing, and when RAG_BOOST_ENABLED is not true it returns all
-- three weights as 0 so callers need no second branch.

create or replace function rag.resolve_boost_weights()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_enabled  boolean;
  v_surface  double precision;
  v_dwell    double precision;
  v_dilution double precision;
begin
  begin
    select lower(trim(s.value)) in ('true', 't', '1', 'yes', 'on')
    into v_enabled
    from public.settings s
    where s.key = 'RAG_BOOST_ENABLED';
  exception when others then
    v_enabled := null;
  end;
  v_enabled := coalesce(v_enabled, false);

  if not v_enabled then
    -- Disabled: every weight is 0 so rag.chunk_metadata_boost() is arithmetically inert.
    return jsonb_build_object(
      'enabled', false,
      'surface_type', 0::double precision,
      'dwell_time_minutes', 0::double precision,
      'dilution_ratio', 0::double precision
    );
  end if;

  begin
    select nullif(trim(s.value), '')::double precision
    into v_surface
    from public.settings s
    where s.key = 'RAG_BOOST_SURFACE_TYPE';
  exception when others then
    v_surface := null;
  end;

  begin
    select nullif(trim(s.value), '')::double precision
    into v_dwell
    from public.settings s
    where s.key = 'RAG_BOOST_DWELL_TIME';
  exception when others then
    v_dwell := null;
  end;

  begin
    select nullif(trim(s.value), '')::double precision
    into v_dilution
    from public.settings s
    where s.key = 'RAG_BOOST_DILUTION_RATIO';
  exception when others then
    v_dilution := null;
  end;

  return jsonb_build_object(
    'enabled', true,
    'surface_type', coalesce(v_surface, 0.10::double precision),
    'dwell_time_minutes', coalesce(v_dwell, 0.05::double precision),
    'dilution_ratio', coalesce(v_dilution, 0.05::double precision)
  );
end;
$function$;

comment on function rag.resolve_boost_weights() is
  'B0-686: resolves RAG_BOOST_* settings into {"enabled",surface_type,dwell_time_minutes,dilution_ratio}. Total (never throws); returns all-zero weights when boosting is disabled.';

-- Per-chunk boost. IMMUTABLE + SECURITY INVOKER so it can sit in an ORDER BY of the STABLE
-- LANGUAGE sql match RPCs. Null-safe: returns 0 for null metadata or null weights.
create or replace function rag.chunk_metadata_boost(
  p_metadata jsonb,
  p_inferred_surface_type text,
  p_weights jsonb
)
returns double precision
language sql
immutable
security invoker
set search_path to 'pg_catalog'
as $function$
  select case
    when p_metadata is null
      or p_weights is null
      or jsonb_typeof(p_metadata) <> 'object'
      or jsonb_typeof(p_weights) <> 'object'
    then 0::double precision
    else
      -- surface_type: exact (case-insensitive, trimmed) match against the caller's inferred value.
      (case
         when nullif(trim(coalesce(p_inferred_surface_type, '')), '') is not null
          and nullif(trim(coalesce(p_metadata ->> 'surface_type', '')), '') is not null
          and lower(trim(p_metadata ->> 'surface_type')) = lower(trim(p_inferred_surface_type))
          and jsonb_typeof(p_weights -> 'surface_type') = 'number'
         then (p_weights ->> 'surface_type')::double precision
         else 0::double precision
       end)
      -- dwell_time_minutes: presence only.
      + (case
           when p_metadata ? 'dwell_time_minutes'
            and jsonb_typeof(p_metadata -> 'dwell_time_minutes') <> 'null'
            and jsonb_typeof(p_weights -> 'dwell_time_minutes') = 'number'
           then (p_weights ->> 'dwell_time_minutes')::double precision
           else 0::double precision
         end)
      -- dilution_ratio: presence only.
      + (case
           when p_metadata ? 'dilution_ratio'
            and jsonb_typeof(p_metadata -> 'dilution_ratio') <> 'null'
            and jsonb_typeof(p_weights -> 'dilution_ratio') = 'number'
           then (p_weights ->> 'dilution_ratio')::double precision
           else 0::double precision
         end)
  end;
$function$;

comment on function rag.chunk_metadata_boost(jsonb, text, jsonb) is
  'B0-686: per-chunk metadata boost (surface_type exact match, dwell_time_minutes presence, dilution_ratio presence). Applied to match RPC ORDER BY only, never to the returned similarity.';

-- Grants: mirror 20260722061000_rag_security_lockdown_rpc_grants_search_path — revoke the default
-- PUBLIC execute and grant only service_role (how the app invokes rag routines server-side).
-- Note anon/authenticated hold no USAGE on schema rag, so this is belt-and-braces.
revoke execute on function rag.resolve_boost_weights() from public, anon, authenticated;
grant execute on function rag.resolve_boost_weights() to service_role;

revoke execute on function rag.chunk_metadata_boost(jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function rag.chunk_metadata_boost(jsonb, text, jsonb) to service_role;
