-- B0-XXX: Settings table for toggling environment variables via UI

CREATE TABLE IF NOT EXISTS public.settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  value text NOT NULL,
  value_type text NOT NULL CHECK (value_type IN ('boolean', 'string', 'number')),
  description text,
  allowed_values text[] DEFAULT NULL, -- JSON array of allowed values for strings
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Enable RLS
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

-- Policy: All authenticated users can read settings
CREATE POLICY "settings_read_authenticated" ON public.settings
  FOR SELECT USING (auth.role() = 'authenticated_user');

-- Policy: Only admins (via app logic) can update settings
-- This is enforced at the API layer via hasPermission check
CREATE POLICY "settings_update_admin_only" ON public.settings
  FOR UPDATE USING (auth.role() = 'authenticated_user')
  WITH CHECK (auth.role() = 'authenticated_user');

-- Create index on key for fast lookups
CREATE INDEX settings_key_idx ON public.settings(key);

-- Seed initial settings with their default values
INSERT INTO public.settings (key, value, value_type, description, allowed_values) VALUES
  ('WEBSEARCH_PROVIDER', 'tavily', 'string', 'Web search provider', ARRAY['tavily']),
  ('WEBSEARCH_DB_CACHE_ENABLED', 'true', 'boolean', 'Enable database caching for web search results', NULL),
  ('XREF_RECOMMENDATION_TIMEOUT_MS', '1500', 'number', 'Timeout in milliseconds for cross-reference recommendations', NULL),
  ('BEX_DISABLE_CONFIDENCE_GATING', 'true', 'boolean', 'Disable confidence gating for recommendations', NULL),
  ('BEX_PERMISSIONS_ENFORCED', 'false', 'boolean', 'Enforce permission checks', NULL),
  ('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small', 'string', 'OpenAI embedding model', ARRAY['text-embedding-3-small', 'text-embedding-3-large']),
  ('BEX_AI_SDK_STREAMING_ENABLED', 'true', 'boolean', 'Enable AI SDK streaming', NULL),
  ('BEX_AI_SDK_STREAMING_ROLLOUT_MODE', 'all', 'string', 'AI SDK streaming rollout mode', ARRAY['all', 'percentage', 'off']),
  ('NEXT_PUBLIC_BEX_STREAMING_UI_ENABLED', 'true', 'boolean', 'Enable streaming UI in Bex chat', NULL),
  ('NEXT_PUBLIC_BEX_STREAMING_ROLLOUT_COHORT', 'all', 'string', 'Streaming rollout cohort', ARRAY['all', 'percentage', 'off']),
  ('NEXT_PUBLIC_BEX_AI_ELEMENTS_UI', 'false', 'boolean', 'Enable AI elements UI', NULL),
  ('BEX_AI_SDK_ROUNDTRIPS_ENABLED', 'false', 'boolean', 'Enable AI SDK roundtrips', NULL),
  ('BEX_AI_SDK_GENERATION_ENABLED', 'false', 'boolean', 'Enable AI SDK generation', NULL),
  ('BEX_LLM_ROUTER_ENABLED', 'true', 'boolean', 'Enable LLM intent routing (rollback lever)', NULL),
  ('BEX_LLM_ROUTER_SHADOW_MODE', 'false', 'boolean', 'LLM router shadow mode (logs but keyword routes)', NULL)
ON CONFLICT (key) DO NOTHING;
