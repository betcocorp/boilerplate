-- B0-464 RECONCILIATION BACKFILL — the drift checker's own RPC.
--
-- public.schema_drift_snapshot() was applied live via the Supabase MCP `apply_migration` tool as
-- ledger row `add_schema_drift_snapshot_rpc_b0464` before its migration file existed, so on its
-- first run scripts/check-schema-drift.mjs correctly reported *itself* as `fn-missing`. This file
-- closes that loop. Transcribed verbatim from pg_get_functiondef() on 2026-08-27.
--
-- Read-only catalog snapshot consumed by scripts/check-schema-drift.mjs. SECURITY DEFINER because
-- the caller needs pg_catalog visibility across rag + public regardless of role; it exposes only
-- object names, types and flags — no row data.
--
-- Zero-argument; the signature matches live exactly, so CREATE OR REPLACE replaces rather than
-- creating a second overload.
--
-- Every statement below is a NO-OP against the current live database.

create or replace function public.schema_drift_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'functions', coalesce((
      select jsonb_agg(f order by f->>'schema', f->>'name', f->>'identity_args')
      from (
        select jsonb_build_object(
          'schema', n.nspname,
          'name', p.proname,
          'identity_args', pg_get_function_identity_arguments(p.oid),
          -- IN / INOUT / VARIADIC only. proargnames also carries OUT column names for
          -- table-returning functions, which are not part of the call signature and would
          -- produce false drift reports.
          'arg_names', coalesce((
            select jsonb_agg(nm order by ord)
            from unnest(p.proargnames) with ordinality as an(nm, ord)
            where nm is not null
              and nm <> ''
              and (
                p.proargmodes is null
                or coalesce(p.proargmodes[ord], 'i') in ('i', 'b', 'v')
              )
          ), '[]'::jsonb),
          'kind', p.prokind::text,
          'security_definer', p.prosecdef,
          'volatility', p.provolatile::text
        ) as f
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('rag', 'public')
      ) s
    ), '[]'::jsonb),
    'relations', coalesce((
      select jsonb_agg(r order by r->>'schema', r->>'name')
      from (
        select jsonb_build_object(
          'schema', n.nspname,
          'name', c.relname,
          'kind', c.relkind::text
        ) as r
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('rag', 'public')
          and c.relkind in ('r', 'v', 'm', 'p')
      ) s
    ), '[]'::jsonb),
    'columns', coalesce((
      select jsonb_agg(col order by col->>'schema', col->>'table', col->>'name')
      from (
        select jsonb_build_object(
          'schema', n.nspname,
          'table', c.relname,
          'name', a.attname,
          'type', format_type(a.atttypid, a.atttypmod),
          'not_null', a.attnotnull,
          'generated', a.attgenerated <> ''
        ) as col
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('rag', 'public')
          and c.relkind in ('r', 'v', 'm', 'p')
          and a.attnum > 0
          and not a.attisdropped
      ) s
    ), '[]'::jsonb),
    'captured_at', now()
  );
$$;

comment on function public.schema_drift_snapshot() is
  'B0-464: read-only catalog snapshot (functions, relations, columns for rag/public) consumed by scripts/check-schema-drift.mjs to detect live DDL with no checked-in migration.';

-- Live ACL is the Supabase schema-public default for functions (anon, authenticated, service_role);
-- the checker runs with the service-role key.
grant execute on function public.schema_drift_snapshot() to anon, authenticated, service_role;
