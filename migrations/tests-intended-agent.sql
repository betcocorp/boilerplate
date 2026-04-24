-- Optional SME agent id for a test dataset (matches V1_AGENT_REGISTRY ids).
ALTER TABLE public.tests
  ADD COLUMN IF NOT EXISTS intended_agent text;

COMMENT ON COLUMN public.tests.intended_agent IS
  'Target SME agent id (e.g. product, bathroom) from the v1 agent registry; null if unset.';
