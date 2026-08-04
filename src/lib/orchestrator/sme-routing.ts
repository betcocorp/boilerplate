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
  // B0-339: substitution verbs that were missing, so "Which Betco product replaces X?" and
  // "We currently use X — what should we switch to?" scored 0 here and lost to the generic
  // 'product'/'betco' PRODUCT_SIGNALS. Deliberately no bare 'replace': PRODUCT_SIGNALS already
  // carries 'replacement', and substring matching would double-count it.
  'replaces',
  'to replace',
  'can replace',
  'switch to',
  'swap out',
  'swap to',
  'instead of',
  // Matches "we currently use" and "I currently use" without double-counting either.
  'currently use',
];

/**
 * B0-339 — signals that mean competitor→Betco cross-reference and essentially nothing else.
 *
 * `PRODUCT_SIGNALS` contains the generic tokens 'product' and 'betco', which appear in almost every
 * cross-reference phrasing, so a literal "Cross-reference X to a Betco product" scored product 2 /
 * recommendations 1 and routed to `product`. The existing tie-break could not help, because product
 * never tied — it won outright. Measured on live `audit_logs`: 270 of the 414 runs that called
 * `lookup_cross_reference` (65%) were labeled `product`, which skipped the recommendations-only
 * post-processing (curated-override safety net, competitive-answer builder, validator evidence
 * injection) — so a real competitor with a curated override could be declined on the label alone.
 *
 * A decisive hit wins outright rather than by count. Kept to unambiguous phrases: the generic
 * 'recommend', bare 'competitive', and 'what/which betco product' are deliberately NOT decisive,
 * since those routinely appear in plain catalog questions.
 *
 * Removing 'product'/'betco' from `PRODUCT_SIGNALS` was the other option and was rejected: they are
 * that route's catch-all, and dropping them would strand ordinary product questions at `agent: null`.
 */
const DECISIVE_RECOMMENDATION_SIGNALS = [
  'cross-reference',
  'cross reference',
  'crossreference',
  'competitor',
  'competitive analysis',
  'betco equivalent',
  'betco version',
  'betco alternative',
  'equivalent to',
  'alternative to',
  'replacement for',
  'comparable',
  'switch from',
  'switch to',
  'convert from',
  'swap out',
  'swap to',
  'replaces',
  'to replace',
  'can replace',
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

/** B0-339 — true when the message carries unambiguous competitor→Betco cross-reference intent. */
export function hasDecisiveRecommendationSignal(message: string): boolean {
  const lower = message.toLowerCase();
  return DECISIVE_RECOMMENDATION_SIGNALS.some((signal) => lower.includes(signal));
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

  // B0-339: an unambiguous cross-reference phrase wins outright, before any counting. Counting
  // cannot resolve this on its own — the generic 'product'/'betco' PRODUCT_SIGNALS out-hit the
  // single cross-reference phrase, so `product` won without ever tying.
  if (recommendationScore > 0 && hasDecisiveRecommendationSignal(trimmed)) {
    return {
      agent: 'recommendations',
      productScore,
      bathroomScore,
      dilutionScore,
      floorScore,
      recommendationScore,
      rationale: `Decisive cross-reference signal; chose **recommendations** outright (product ${productScore}, bathroom ${bathroomScore}, dilution ${dilutionScore}, floor ${floorScore}, recommendations ${recommendationScore}).`,
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
