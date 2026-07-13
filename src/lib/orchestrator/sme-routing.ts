import type { SmeAgentId } from '~/lib/agents/sme/types';

/** Feasibility / demo routing: keyword signals (replace with LLM router later). */
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
  'p-trap',
  'wet wall',
  'enclosure',
  'glass door',
  'bidet',
  'gpf',
  'gpm',
  'master bath',
  'guest bath',
  'restroom',
  'urinal',
  'stall ',
];

/** Dispenser / system dilution — narrower than “dilution ratio on a label” (product specialist). */
const DILUTION_SIGNALS = [
  'dispenser calibration',
  'calibrate the dispenser',
  'calibrate dispenser',
  'metering tip',
  'proportioner',
  'proportioning',
  'dilution control system',
  'chemical management system',
  'fastdraw',
  'fast draw',
  'injection tip',
  'tip chart',
  'dispenser setup',
  'setup my dispenser',
  'on-site mixing system',
];

/** Procedural floor maintenance (hand off from product facts). */
const FLOOR_SIGNALS = [
  'floor stripping',
  'strip the floor',
  'strip floors',
  'strip and wax',
  'strip wax',
  'remove wax',
  'burnish',
  'burnishing',
  'scrub and recoat',
  'top scrub',
  'recoat floor',
  'floor finish procedure',
  'applying floor finish',
  'apply finish',
  'multiple coats of finish',
  'vct program',
  'floor maintenance program',
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
  'sds',
  'msds',
  'disinfect',
  'sanitiz',
  'epa registered',
  'epa #',
  'epa reg',
  'cleaner',
  'degreas',
  'rtu',
  'ready-to-use',
  'ready to use',
  'concentrate',
  'dilution ratio',
  'mix ratio',
  'hazard',
  'ppe',
  'first aid',
  'ingredient',
  'betco',
  'dwell time',
  'kill claim',
  'norinse',
];

/**
 * Competitor → Betco cross-reference / equivalent-recommendation intent. Fires on
 * language about matching or replacing a *competitor* product with a Betco one — the
 * signal that should route to the Recommendations specialist rather than the general
 * product catalog. Kept capability/phrase-based (no hardcoded competitor SKUs).
 */
const RECOMMENDATION_SIGNALS = [
  'cross-reference',
  'cross reference',
  'crossreference',
  'competitor',
  'competitive analysis',
  'competitive',
  'equivalent',
  'equivalent to',
  'betco equivalent',
  'betco version',
  'betco alternative',
  'alternative to',
  'replacement for',
  'switch from',
  'convert from',
  'comparable',
  'what betco product',
  'which betco product',
  'recommend',
  'recommendation',
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
  dilutionScore: number;
  floorScore: number;
  recommendationScore: number;
  rationale: string;
};

type ScoreKey = 'product' | 'bathroom' | 'dilution' | 'floor' | 'recommendations';

/**
 * Picks an SME from free text. Returns `agent: null` when no signals fire.
 * When the top score is tied, prefers: dilution > floor > bathroom > recommendations > product
 * (procedure/system specialists win first; recommendations beats the broad product catch-all).
 */
export function routeUserMessageToSme(message: string): SmeRouteDecision {
  const trimmed = message.trim();

  if (!trimmed) {
    return {
      agent: null,
      productScore: 0,
      bathroomScore: 0,
      dilutionScore: 0,
      floorScore: 0,
      recommendationScore: 0,
      rationale: 'Empty message; cannot route.',
    };
  }

  const bathroomScore = countSignalHits(trimmed, BATHROOM_SIGNALS);
  const productScore = countSignalHits(trimmed, PRODUCT_SIGNALS);
  const dilutionScore = countSignalHits(trimmed, DILUTION_SIGNALS);
  const floorScore = countSignalHits(trimmed, FLOOR_SIGNALS);
  const recommendationScore = countSignalHits(trimmed, RECOMMENDATION_SIGNALS);

  const scores: Record<ScoreKey, number> = {
    product: productScore,
    bathroom: bathroomScore,
    dilution: dilutionScore,
    floor: floorScore,
    recommendations: recommendationScore,
  };

  const entries = (Object.entries(scores) as [ScoreKey, number][]).filter(
    ([, s]) => s > 0,
  );

  if (entries.length === 0) {
    return {
      agent: null,
      productScore,
      bathroomScore,
      dilutionScore,
      floorScore,
      recommendationScore,
      rationale:
        'No specialist keywords matched. Mention a Betco product or SDS topic, restroom care, dilution control hardware, floor maintenance procedures, or a competitor product to cross-reference.',
    };
  }

  const max = Math.max(...entries.map(([, s]) => s));
  const winners = entries.filter(([, s]) => s === max) as [ScoreKey, number][];

  /** When scores tie, prefer system/procedure specialists, then cross-reference, over broad catalog routing. */
  const tieBreakOrder: ScoreKey[] = [
    'dilution',
    'floor',
    'bathroom',
    'recommendations',
    'product',
  ];

  let agent: ScoreKey = winners[0]![0];
  for (const key of tieBreakOrder) {
    if (winners.some(([k]) => k === key)) {
      agent = key;
      break;
    }
  }

  const rationale =
    winners.length > 1
      ? `Tie at ${max} hits between ${winners.map(([k]) => k).join(', ')}; chose **${agent}** by priority (${tieBreakOrder.join(' > ')}).`
      : `${agent} signals (${max}) won (product ${productScore}, bathroom ${bathroomScore}, dilution ${dilutionScore}, floor ${floorScore}, recommendations ${recommendationScore}).`;

  return {
    agent,
    productScore,
    bathroomScore,
    dilutionScore,
    floorScore,
    recommendationScore,
    rationale,
  };
}
