import type { SmeAgentId } from '~/lib/agents/sme/types';

/** Feasibility / demo routing: keyword signals only (replace with LLM router later). */
const BATHROOM_SIGNALS = [
  'bathroom',
  'bath ',
  'bath.',
  'half bath',
  'full bath',
  'powder room',
  'vanity',
  'toilet',
  'wc ',
  'shower',
  'bathtub',
  'tub ',
  'tile',
  'grout',
  'faucet',
  'rough-in',
  'rough in',
  'drain',
  'p-trap',
  'wet wall',
  'enclosure',
  'glass door',
  'bidet',
  'gpf',
  'gpm',
  'master bath',
  'guest bath',
];

const PRODUCT_SIGNALS = [
  'product',
  'sku',
  'model',
  'spec',
  'specs',
  'datasheet',
  'manual',
  'warranty',
  'serial',
  'part number',
  'part #',
  'compare',
  'versus',
  ' vs ',
  'lineup',
  'catalog',
  'accessory',
  'compatible',
  'compatibility',
  'replacement',
  'dimensions',
  'dimension',
  'upc',
  'item number',
];

function countSignalHits(text: string, signals: string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;

  for (const signal of signals) {
    if (lower.includes(signal.toLowerCase())) {
      hits += 1;
    }
  }

  return hits;
}

export type SmeRouteDecision = {
  agent: SmeAgentId | null;
  productScore: number;
  bathroomScore: number;
  rationale: string;
};

/**
 * Picks Product vs Bathroom SME from free text. Returns `agent: null` when
 * scores tie at zero or tie with each other (orchestrator should ask for clarification).
 */
export function routeUserMessageToSme(message: string): SmeRouteDecision {
  const trimmed = message.trim();

  if (!trimmed) {
    return {
      agent: null,
      productScore: 0,
      bathroomScore: 0,
      rationale: 'Empty message; cannot route.',
    };
  }

  const bathroomScore = countSignalHits(trimmed, BATHROOM_SIGNALS);
  const productScore = countSignalHits(trimmed, PRODUCT_SIGNALS);

  if (bathroomScore === 0 && productScore === 0) {
    return {
      agent: null,
      productScore,
      bathroomScore,
      rationale:
        'No bathroom or product keywords matched. Mention fixtures/layout for Bathroom, or SKU/specs/model for Product.',
    };
  }

  if (bathroomScore > productScore) {
    return {
      agent: 'bathroom',
      productScore,
      bathroomScore,
      rationale: `Bathroom signals (${bathroomScore}) outranked product signals (${productScore}).`,
    };
  }

  if (productScore > bathroomScore) {
    return {
      agent: 'product',
      productScore,
      bathroomScore,
      rationale: `Product signals (${productScore}) outranked bathroom signals (${bathroomScore}).`,
    };
  }

  return {
    agent: null,
    productScore,
    bathroomScore,
    rationale: `Tie (${bathroomScore} bathroom vs ${productScore} product signals); ask a more specific question.`,
  };
}
