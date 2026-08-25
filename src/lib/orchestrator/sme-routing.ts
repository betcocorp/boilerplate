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
 * signal that should route to the `cross_reference` specialist rather than the general
 * product catalog. Kept capability/phrase-based (no hardcoded competitor SKUs).
 *
 * B0-663 — renamed from `RECOMMENDATION_SIGNALS`. Content is unchanged: this list is, and always
 * was, exclusively competitor-cross-reference phrasing. It is now paired with a SEPARATE
 * `JOB_RECOMMENDATION_SIGNALS` list for the new job/problem-driven `recommendations` agent (no
 * competitor named) — the two are deliberately distinct categories, not a rename of meaning.
 */
const CROSS_REFERENCE_SIGNALS = [
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
 * B0-663 — job/problem-driven product-recommendation phrasing with NO competitor named, e.g.
 * "What should I use to degrease a kitchen floor?" or "What do you recommend for sticky
 * residue?". Fires the `recommendations` agent, which is ADDITIVE ONLY: bathroom/dilution/floor
 * keep answering their own domain-specific "what should I use" questions exactly as before (their
 * signal lists still win the tie-break — see `SME_ROUTE_TIE_BREAK_ORDER`). Deliberately pure
 * job/problem PHRASING — no surface or product vocabulary — so this never double-counts against
 * `PRODUCT_SIGNALS` / `BATHROOM_SIGNALS` / `DILUTION_SIGNALS` / `FLOOR_SIGNALS`.
 *
 * Unlike `CROSS_REFERENCE_SIGNALS`, this category has no decisive-signal short-circuit — it is
 * scored like `product`/`bathroom`/`dilution`/`floor` and can lose ties to any of them.
 */
const JOB_RECOMMENDATION_SIGNALS = [
  'what should i use',
  'what would you recommend',
  'what do you recommend',
  'best product for',
  'what product for',
  'which product should i use',
  'i have a problem',
  'i have an issue',
  'what would work for',
  'need something for',
  'looking for a product',
];

/**
 * B0-339 — signals that mean competitor→Betco cross-reference and essentially nothing else.
 *
 * `PRODUCT_SIGNALS` contains the generic tokens 'product' and 'betco', which appear in almost every
 * cross-reference phrasing, so a literal "Cross-reference X to a Betco product" scored product 2 /
 * cross_reference 1 and routed to `product`. The existing tie-break could not help, because product
 * never tied — it won outright. Measured on live `audit_logs`: 270 of the 414 runs that called
 * `lookup_cross_reference` (65%) were labeled `product`, which skipped the cross-reference-only
 * post-processing (curated-override safety net, competitive-answer builder, validator evidence
 * injection) — so a real competitor with a curated override could be declined on the label alone.
 *
 * A decisive hit wins outright rather than by count. Kept to unambiguous phrases: the generic
 * 'recommend', bare 'competitive', and 'what/which betco product' are deliberately NOT decisive,
 * since those routinely appear in plain catalog questions.
 *
 * Removing 'product'/'betco' from `PRODUCT_SIGNALS` was the other option and was rejected: they are
 * that route's catch-all, and dropping them would strand ordinary product questions at `agent: null`.
 *
 * B0-663 — renamed from `DECISIVE_RECOMMENDATION_SIGNALS`; content unchanged.
 */
const DECISIVE_CROSS_REFERENCE_SIGNALS = [
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

/**
 * B0-392 — returns the matched PHRASES as well as the count. The count is unchanged (one per
 * signal-list entry found as a substring), so routing maths is untouched; the phrases exist because
 * the counts are not comparable across categories — the lists overlap internally (e.g. both
 * `competitive` and `competitive analysis` match "competitive analysis", scoring 2 where an
 * equivalent floor phrase scores 1), so a bare "cross_reference 2 / floor 1" implies a margin that
 * does not exist. The phrases are what make a score auditable.
 */
function countSignalHits(
  text: string,
  signals: string[],
): { hits: number; matched: string[] } {
  const lower = text.toLowerCase();
  const matched: string[] = [];

  for (const signal of signals) {
    if (lower.includes(signal.toLowerCase())) {
      matched.push(signal);
    }
  }

  return { hits: matched.length, matched };
}

/** B0-392 — the decisive phrases present in the message (empty when none are). */
function matchedDecisiveCrossReferenceSignals(message: string): string[] {
  const lower = message.toLowerCase();
  return DECISIVE_CROSS_REFERENCE_SIGNALS.filter((signal) => lower.includes(signal));
}

/**
 * B0-339 — true when the message carries unambiguous competitor→Betco cross-reference intent.
 * Delegates to the phrase list (B0-392) so the predicate and the recorded phrases cannot disagree.
 *
 * B0-663 — renamed from `hasDecisiveRecommendationSignal`; behavior unchanged.
 */
export function hasDecisiveCrossReferenceSignal(message: string): boolean {
  return matchedDecisiveCrossReferenceSignals(message).length > 0;
}

export type SmeRouteScoreKey =
  | 'product'
  | 'bathroom'
  | 'dilution'
  | 'floor'
  | 'cross_reference'
  | 'recommendations';

/**
 * B0-392 — HOW the decision was reached, so a consumer never has to parse `rationale` prose.
 *
 * `no_signal` is the honest name for what the workflow later labels `ambiguous`: zero keyword hits
 * across all six lists, which is NOT a tie — a tie resolves through `SME_ROUTE_TIE_BREAK_ORDER`
 * and reports `tie_break`.
 */
export type SmeRouteDecisionPath =
  | 'empty_message'
  | 'no_signal'
  | 'decisive_cross_reference_signal'
  | 'tie_break'
  | 'outright_winner';

export type SmeRouteDecision = {
  agent: SmeAgentId | null;
  productScore: number;
  bathroomScore: number;
  dilutionScore: number;
  floorScore: number;
  /** B0-663 — competitor→Betco cross-reference signal count (renamed from `recommendationScore`). */
  crossReferenceScore: number;
  /** B0-663 — NEW: job/problem-driven "what should I use" signal count, no competitor named. */
  recommendationScore: number;
  /** B0-392 — the exact phrases that matched, per category. Counts alone are not comparable. */
  matchedPhrases: Record<SmeRouteScoreKey, string[]>;
  /** B0-392 — the decisive cross-reference phrases found (B0-339 short-circuit inputs). Renamed from `decisiveRecommendationPhrases` (B0-663). */
  decisiveCrossReferencePhrases: string[];
  /** B0-392 — which branch produced `agent`. */
  decisionPath: SmeRouteDecisionPath;
  /** B0-392 — categories tied at the top score; empty unless `decisionPath === 'tie_break'`. */
  tiedCategories: SmeRouteScoreKey[];
  rationale: string;
};

/**
 * When scores tie, prefer system/procedure specialists (dilution/floor/bathroom), then the
 * job-based `recommendations` agent, then `cross_reference`, over broad catalog routing. Exported
 * (B0-392) so a recorded routing decision cites the order actually applied.
 *
 * B0-663 — `recommendations` (job-based, additive-only) is deliberately placed ABOVE
 * `cross_reference` in this list: it still loses ties to the three domain specialists (the
 * additive-only guarantee), but a plain "what should I use for X" with no domain/competitor signal
 * should not lose to a `cross_reference` category that, in practice, almost never reaches a numeric
 * tie anyway (it wins outright via `DECISIVE_CROSS_REFERENCE_SIGNALS` before scoring is even
 * consulted). `product` remains the final catch-all.
 */
export const SME_ROUTE_TIE_BREAK_ORDER: readonly SmeRouteScoreKey[] = [
  'dilution',
  'floor',
  'bathroom',
  'recommendations',
  'cross_reference',
  'product',
];

/** Hits a category needs before it can win at all (below this, `agent` is null). */
export const SME_ROUTE_MIN_HITS_TO_ROUTE = 1;

/** Fresh arrays per call — a shared constant would let one caller mutate another's record. */
function emptyMatchedPhrases(): Record<SmeRouteScoreKey, string[]> {
  return {
    product: [],
    bathroom: [],
    dilution: [],
    floor: [],
    cross_reference: [],
    recommendations: [],
  };
}

/**
 * Picks an SME from free text.
 *
 * `agent: null` happens in exactly two cases — an empty message, or zero keyword hits across all
 * six lists (`decisionPath` says which). A TIE is not one of them: it resolves through
 * `SME_ROUTE_TIE_BREAK_ORDER` (dilution > floor > bathroom > recommendations > cross_reference >
 * product) and returns a real agent with `decisionPath: 'tie_break'`.
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
      crossReferenceScore: 0,
      recommendationScore: 0,
      matchedPhrases: emptyMatchedPhrases(),
      decisiveCrossReferencePhrases: [],
      decisionPath: 'empty_message',
      tiedCategories: [],
      rationale: 'Empty message; cannot route.',
    };
  }

  const bathroom = countSignalHits(trimmed, BATHROOM_SIGNALS);
  const product = countSignalHits(trimmed, PRODUCT_SIGNALS);
  const dilution = countSignalHits(trimmed, DILUTION_SIGNALS);
  const floor = countSignalHits(trimmed, FLOOR_SIGNALS);
  const crossReference = countSignalHits(trimmed, CROSS_REFERENCE_SIGNALS);
  const jobRecommendation = countSignalHits(trimmed, JOB_RECOMMENDATION_SIGNALS);

  const bathroomScore = bathroom.hits;
  const productScore = product.hits;
  const dilutionScore = dilution.hits;
  const floorScore = floor.hits;
  const crossReferenceScore = crossReference.hits;
  const recommendationScore = jobRecommendation.hits;

  const matchedPhrases: Record<SmeRouteScoreKey, string[]> = {
    product: product.matched,
    bathroom: bathroom.matched,
    dilution: dilution.matched,
    floor: floor.matched,
    cross_reference: crossReference.matched,
    recommendations: jobRecommendation.matched,
  };
  const decisiveCrossReferencePhrases = matchedDecisiveCrossReferenceSignals(trimmed);

  const scores: Record<SmeRouteScoreKey, number> = {
    product: productScore,
    bathroom: bathroomScore,
    dilution: dilutionScore,
    floor: floorScore,
    cross_reference: crossReferenceScore,
    recommendations: recommendationScore,
  };

  const entries = (Object.entries(scores) as [SmeRouteScoreKey, number][]).filter(
    ([, s]) => s >= SME_ROUTE_MIN_HITS_TO_ROUTE,
  );

  const common = {
    productScore,
    bathroomScore,
    dilutionScore,
    floorScore,
    crossReferenceScore,
    recommendationScore,
    matchedPhrases,
    decisiveCrossReferencePhrases,
  };

  if (entries.length === 0) {
    return {
      agent: null,
      ...common,
      decisionPath: 'no_signal',
      tiedCategories: [],
      rationale:
        'No specialist keywords matched. Mention a Betco product or SDS topic, restroom care, dilution control hardware, floor maintenance procedures, a competitor product to cross-reference, or ask what product to use for a job.',
    };
  }

  // B0-339: an unambiguous cross-reference phrase wins outright, before any counting. Counting
  // cannot resolve this on its own — the generic 'product'/'betco' PRODUCT_SIGNALS out-hit the
  // single cross-reference phrase, so `product` won without ever tying.
  if (crossReferenceScore > 0 && decisiveCrossReferencePhrases.length > 0) {
    return {
      agent: 'cross_reference',
      ...common,
      decisionPath: 'decisive_cross_reference_signal',
      tiedCategories: [],
      rationale: `Decisive cross-reference signal; chose **cross_reference** outright (product ${productScore}, bathroom ${bathroomScore}, dilution ${dilutionScore}, floor ${floorScore}, cross_reference ${crossReferenceScore}, recommendations ${recommendationScore}).`,
    };
  }

  const max = Math.max(...entries.map(([, s]) => s));
  const winners = entries.filter(([, s]) => s === max) as [SmeRouteScoreKey, number][];

  let agent: SmeRouteScoreKey = winners[0]![0];
  for (const key of SME_ROUTE_TIE_BREAK_ORDER) {
    if (winners.some(([k]) => k === key)) {
      agent = key;
      break;
    }
  }

  const rationale =
    winners.length > 1
      ? `Tie at ${max} hits between ${winners.map(([k]) => k).join(', ')}; chose **${agent}** by priority (${SME_ROUTE_TIE_BREAK_ORDER.join(' > ')}).`
      : `${agent} signals (${max}) won (product ${productScore}, bathroom ${bathroomScore}, dilution ${dilutionScore}, floor ${floorScore}, cross_reference ${crossReferenceScore}, recommendations ${recommendationScore}).`;

  return {
    agent,
    ...common,
    decisionPath: winners.length > 1 ? 'tie_break' : 'outright_winner',
    tiedCategories: winners.length > 1 ? winners.map(([key]) => key) : [],
    rationale,
  };
}
