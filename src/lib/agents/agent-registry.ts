export const SME_AGENT_IDS = [
  'product',
  'bathroom',
  'dilution',
  'floor',
  'recommendations',
] as const;
export type SmeAgentId = (typeof SME_AGENT_IDS)[number];

export const BEX_CHAT_AGENT_MODES = ['orchestrator', ...SME_AGENT_IDS] as const;
export type BexChatAgentMode = (typeof BEX_CHAT_AGENT_MODES)[number];

export const DEFAULT_BEX_CHAT_AGENT_MODE: BexChatAgentMode = 'orchestrator';

export const V1_AGENT_REGISTRY = [
  {
    id: 'product',
    path: '/api/v1/agents/product',
    label: 'Betco Product Specialist',
    description:
      'Betco product facts, SDS (non-medical), compatibility, catalogs; handoffs to Dilution/Floor when needed.',
  },
  {
    id: 'dilution',
    path: '/api/v1/agents/dilution',
    label: 'Dilution Control Specialist',
    description:
      'Dispenser calibration, proportioners, metering tips, and setup from approved charts.',
  },
  {
    id: 'floor',
    path: '/api/v1/agents/floor',
    label: 'Floor Care Specialist',
    description:
      'Stripping, finishing, burnishing, and floor maintenance programs.',
  },
  {
    id: 'bathroom',
    path: '/api/v1/agents/bathroom',
    label: 'Bathroom specialist',
    description:
      'Restroom cleaning, disinfection, odor control, floor care, and Betco product/procedure guidance.',
  },
  {
    id: 'recommendations',
    path: '/api/v1/agents/recommendations',
    label: 'Product Recommendations Specialist',
    description:
      'Recommends the Betco equivalent for a competitor product using the cross-reference lookup and (when available) the web-search-grounded recommendation engine; answers only above a confidence threshold, otherwise defers to a Betco sales representative (stub).',
  },
] as const satisfies ReadonlyArray<{
  id: SmeAgentId;
  path: `/api/v1/agents/${SmeAgentId}`;
  label: string;
  description: string;
}>;

export function isBexChatAgentMode(value: unknown): value is BexChatAgentMode {
  return typeof value === 'string' && (BEX_CHAT_AGENT_MODES as readonly string[]).includes(value);
}
