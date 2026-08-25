import {
  SME_AGENT_IDS,
  V1_AGENT_REGISTRY,
  type SmeAgentId,
} from '~/lib/agents/agent-registry';

export type RoutingTestAgentOption = {
  id: SmeAgentId;
  label: string;
};

/**
 * B0-657/658 — the expected-agent choices, derived from `SME_AGENT_IDS` (never hardcoded) with the
 * human label taken from `V1_AGENT_REGISTRY` where one exists. A sixth SME agent shows up here for
 * free; the DB CHECK constraint on `routing_test_items.expected_agent` does not (see
 * `./schemas.ts`).
 */
export const ROUTING_TEST_AGENT_OPTIONS: RoutingTestAgentOption[] =
  SME_AGENT_IDS.map((id) => ({
    id,
    label: V1_AGENT_REGISTRY.find((agent) => agent.id === id)?.label ?? id,
  }));

export function routingTestAgentLabel(id: string): string {
  return ROUTING_TEST_AGENT_OPTIONS.find((option) => option.id === id)?.label ?? id;
}
