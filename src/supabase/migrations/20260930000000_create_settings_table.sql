-- Settings table backing ~/lib/settings/settings-service.ts (getBooleanSetting / getStringSetting /
-- getNumberSetting / getRouterType / getLlmProvider). No rows are seeded — add your own via
-- `insert into public.settings (...)` or the Supabase dashboard as your app needs flags/config.

CREATE TABLE IF NOT EXISTS public.settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  value text NOT NULL,
  value_type text NOT NULL CHECK (value_type IN ('boolean', 'string', 'number')),
  description text,
  allowed_values text[] DEFAULT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "settings_read_authenticated" ON public.settings
  FOR SELECT USING (auth.role() = 'authenticated_user');

-- Locking down writes to a specific role/claim is app-specific — add your own UPDATE policy
-- (or enforce it at the API layer) before exposing a write path to this table.

CREATE INDEX settings_key_idx ON public.settings(key);
