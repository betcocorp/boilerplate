-- B0-656 — ROUTER_TYPE: which router implementation the orchestrator should use.
--
-- Default 'keyword' deliberately preserves today's behavior exactly. 'semantic' is accepted by the
-- CHECK-free `allowed_values` list so /admin/settings can offer it, but selecting it has NO effect
-- until B0-648 (the semantic router itself) and B0-649 (wiring this setting into the live routing
-- decision) land. Until then `getRouterType()` in `~/lib/settings/settings-service.ts` merely
-- reports the stored value; nothing reads it to route a real turn, so an early flip is inert
-- rather than a misroute.
--
-- Note `settings.value_type` has a CHECK constraint ('boolean'|'string'|'number') but
-- `allowed_values` does NOT constrain `value` at the database level — it is advisory metadata the
-- admin API (`POST /api/admin/settings`) validates against. `getRouterType()` therefore coerces any
-- unrecognized stored string back to 'keyword' instead of trusting the column.
insert into public.settings (key, value, value_type, description, allowed_values) values
  (
    'ROUTER_TYPE',
    'keyword',
    'string',
    'Which router implementation the orchestrator uses to pick an SME agent. ''keyword'' = the existing routeUserMessageToSme/LLM-classifier path. ''semantic'' = the B0-648 embedding-similarity router; has NO effect until B0-648/B0-649 land, and an unrecognized value is treated as ''keyword''.',
    array['keyword', 'semantic']
  )
on conflict (key) do nothing;
