-- B0-657: Routing test tool — flat singleton list of prompts with an expected SME agent.
--
-- Deliberately NOT parented by `public.tests`: there is (and will only ever be) ONE routing test,
-- so a dataset/parent entity would be dead weight. This table is intentionally simpler than
-- `public.test_items` and must not be merged into it.
--
-- KEEP IN SYNC: the CHECK constraint below duplicates `SME_AGENT_IDS`
-- (`src/lib/agents/agent-registry.ts`). Postgres cannot import the TS constant, so adding a sixth
-- SME agent requires BOTH a new migration altering this constraint AND the Zod enum in
-- `src/lib/routing-test/schemas.ts` (which is derived from SME_AGENT_IDS automatically).

CREATE TABLE IF NOT EXISTS public.routing_test_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt text NOT NULL,
  expected_agent text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT routing_test_items_prompt_not_blank CHECK (btrim(prompt) <> ''),
  CONSTRAINT routing_test_items_expected_agent_check CHECK (
    expected_agent IN ('product', 'bathroom', 'dilution', 'floor', 'recommendations')
  )
);

-- Same posture as public.tests / public.test_items: RLS on, service_role-only access. The app
-- reads and writes exclusively through `~/supabase/clients/service-role`.
ALTER TABLE public.routing_test_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS routing_test_items_service_role ON public.routing_test_items;
CREATE POLICY routing_test_items_service_role ON public.routing_test_items
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Matches trg_tests_updated_at on public.tests.
DROP TRIGGER IF EXISTS trg_routing_test_items_updated_at ON public.routing_test_items;
CREATE TRIGGER trg_routing_test_items_updated_at
  BEFORE UPDATE ON public.routing_test_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS routing_test_items_created_at_idx
  ON public.routing_test_items (created_at);
