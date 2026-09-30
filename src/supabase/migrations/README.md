# Migrations

Supabase SQL migrations go here, named `<timestamp>_<description>.sql` (matches
`supabase migration new <name>`). Apply with the Supabase CLI or MCP `apply_migration`
during local development.

`20260930000000_create_settings_table.sql` is the one migration this template ships with — it
creates the `public.settings` table that `~/lib/settings/settings-service.ts` reads from. Everything
else starts empty; add your own schema as your app needs it.
