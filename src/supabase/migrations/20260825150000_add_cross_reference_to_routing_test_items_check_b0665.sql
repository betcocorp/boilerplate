-- B0-665: `SME_AGENT_IDS` (src/lib/agents/agent-registry.ts) added `cross_reference`, and
-- routing_test_items's Zod enum picked it up automatically (see src/lib/routing-test/schemas.ts),
-- but this CHECK constraint was never updated, so saving a routing test item with expected agent
-- = cross_reference violated it. Drop + recreate to stay in sync with SME_AGENT_IDS.

ALTER TABLE public.routing_test_items
  DROP CONSTRAINT routing_test_items_expected_agent_check;

ALTER TABLE public.routing_test_items
  ADD CONSTRAINT routing_test_items_expected_agent_check CHECK (
    expected_agent IN ('product', 'bathroom', 'dilution', 'floor', 'recommendations', 'cross_reference')
  );
