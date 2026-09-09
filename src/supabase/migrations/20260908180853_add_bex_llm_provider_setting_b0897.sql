-- B0-897 — BEX_LLM_PROVIDER: which LLM vendor Bex should prefer, as an admin-selectable row.
--
-- Seeds the row and nothing else. As of 2026-09-08 NO code path reads this setting — it is the
-- select control on /admin/settings plus the typed getter `getLlmProvider()` in
-- `~/lib/settings/settings-service.ts`; wiring it into a runtime (chat generation, grading,
-- validator, router) is a separate follow-up ticket. Flipping it to 'anthropic' today is inert.
--
-- Default 'openai' preserves today's behavior exactly: every Bex chat runtime is OpenAI, and the one
-- Anthropic consumer (run-report grading, B0-806/B0-819) infers its provider from the model id, not
-- from a flag. ANTHROPIC_API_KEY stays in env because it is a secret (B0-638); everything else about
-- the provider belongs here.
--
-- `settings.value_type` has a CHECK constraint but `allowed_values` does NOT constrain `value` at the
-- database level — it is advisory metadata `POST /api/admin/settings` validates against. The getter
-- therefore coerces any unrecognized stored string back to 'openai' rather than trusting the column.
insert into public.settings (key, value, value_type, description, allowed_values) values
  (
    'BEX_LLM_PROVIDER',
    'openai',
    'string',
    'Preferred LLM vendor for Bex: ''openai'' or ''anthropic''. NOT YET WIRED (B0-897 seeds the row and the select only) — no runtime reads it, so changing it has no effect until a follow-up ticket connects a consumer. Read via getLlmProvider() (~/lib/settings/settings-service.ts); an unrecognized value is treated as ''openai''.',
    array['openai', 'anthropic']
  )
on conflict (key) do nothing;
