export const SME_AGENT_IDS = [
  'product',
  'bathroom',
  'dilution',
  // B0-746 — the former single `floor` id was split into four substrate specialists. This is a
  // BREAKING change to the `/api/v1/agents/floor` surface (that route no longer exists).
  'floor_wood_sport',
  'floor_concrete',
  'floor_stg',
  'floor_vct',
  'recommendations',
  'cross_reference',
] as const;
export type SmeAgentId = (typeof SME_AGENT_IDS)[number];

export const BEX_CHAT_AGENT_MODES = ['orchestrator', ...SME_AGENT_IDS] as const;
export type BexChatAgentMode = (typeof BEX_CHAT_AGENT_MODES)[number];

export const DEFAULT_BEX_CHAT_AGENT_MODE: BexChatAgentMode = 'orchestrator';

/**
 * B0-351 — human labels for the agent-mode picker, so the eval harness's "Run dataset" control and
 * any other mode selector render the same names without re-listing the modes. The Bex chat composer
 * still hardcodes its own `<SelectItem>` labels; these are byte-identical to them.
 */
export const BEX_CHAT_AGENT_MODE_LABELS: Record<BexChatAgentMode, string> = {
  orchestrator: 'Orchestrator',
  product: 'Product',
  bathroom: 'Bathroom',
  dilution: 'Dilution',
  floor_wood_sport: 'Floor — Wood/Sport',
  floor_concrete: 'Floor — Concrete',
  floor_stg: 'Floor — Stone/Tile/Grout',
  floor_vct: 'Floor — VCT',
  recommendations: 'Recommendations',
  cross_reference: 'Cross-Reference',
};

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
    id: 'floor_wood_sport',
    path: '/api/v1/agents/floor_wood_sport',
    label: 'Wood/Sport Floor Care Specialist',
    description:
      'Wood (hardwood) sport/gym floor finish and coating: recoating programs and daily/interim maintenance.',
  },
  {
    id: 'floor_concrete',
    path: '/api/v1/agents/floor_concrete',
    label: 'Concrete Floor Care Specialist',
    description:
      'Concrete floor cleaning, densifying, sealing, coating, stripping, and scrubbing programs.',
  },
  {
    id: 'floor_stg',
    path: '/api/v1/agents/floor_stg',
    label: 'Stone, Tile & Grout Specialist',
    description:
      'Cleaning and protecting natural stone, tile, and grout surfaces (STG Cleaner and Protectant line).',
  },
  {
    id: 'floor_vct',
    path: '/api/v1/agents/floor_vct',
    label: 'VCT & Resilient Tile Floor Care Specialist',
    description:
      'VCT, terrazzo, and resilient/hard tile: stripping, finishing, burnishing, and floor maintenance programs.',
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
      'Recommends the best-fit Betco product for a described job or problem (no competitor named) using the product catalog and RAG tools; presents one primary pick plus up to two alternatives when there is a genuine reason to offer them.',
  },
  {
    id: 'cross_reference',
    path: '/api/v1/agents/cross_reference',
    label: 'Cross-Reference Specialist',
    description:
      'Recommends the Betco equivalent for a competitor product using the cross-reference lookup and (when available) the web-search-grounded recommendation engine; answers only above a confidence threshold, otherwise defers to a Betco sales representative.',
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
