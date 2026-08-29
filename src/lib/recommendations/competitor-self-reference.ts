/**
 * B0-751 — decide whether a turn the routers classified as competitor cross-reference is actually
 * asking about Betco's OWN products (or about a chemistry, or for a whole conversion list), so the
 * workflow can stop pinning `lookup_cross_reference`, skip the B0-355 backstop, and keep the B0-356
 * engine gate from replacing the specialist's draft with the engine's decline. Pure and
 * dependency-injected: the only I/O is the caller-supplied `resolveBetcoEntity`.
 *
 * Fail-open by design: any resolver error, or a competitor identity nothing here recognises, is
 * `{ suppressed: false }` — today's behaviour. Nothing in this module reads regulated data; it only
 * decides routing/forcing.
 */

export type CompetitorSelfReferenceReason =
  | 'betco_brand'
  | 'betco_product'
  | 'chemistry_term'
  | 'conversion_list_ask';

export type CompetitorSelfReferenceVerdict =
  | { suppressed: false }
  | {
      suppressed: true;
      reason: CompetitorSelfReferenceReason;
      productLineKey: string | null;
      /** The exact normalised text the rule fired on — for the audit row and the gate reason. */
      matched: string;
    };

export type BetcoEntityResolution = {
  productLineKey: string | null;
  ambiguousAlias: boolean;
};

export type ClassifyCompetitorSelfReferenceInput = {
  userMessage: string;
  competitorBrand: string | null;
  competitorProduct: string | null;
  resolveBetcoEntity: (name: string) => Promise<BetcoEntityResolution>;
};

/** Betco and its sub-brands only — see the org rule: never invent sub-brands. */
const BETCO_BRANDS = new Set(['betco', 'basic coatings', 'envirozyme', '1950']);

/**
 * Bare chemistry names a user may name in place of a competitor product. Matched against the WHOLE
 * normalised product string (an optional leading article aside), never as a substring, so
 * "Spartan Quat Disinfectant" — a real competitor product — never matches.
 */
const CHEMISTRY_TERMS = new Set([
  'bleach',
  'chlorine bleach',
  'quat',
  'quats',
  'quaternary',
  'quaternary ammonium',
  'peroxide',
  'hydrogen peroxide',
  'ammonia',
  'chlorine',
]);

/**
 * A whole-line / whole-catalog conversion ask, which the engine can only ever decline (it answers
 * one competitor product at a time). Deliberately conservative: it requires BOTH a list-shaped
 * noun and a cross-reference/conversion word, or the "whole/entire catalog|line" phrasing, so a
 * single-product equivalence ask ("Betco equivalent to Virex II 256") can never match.
 */
const CONVERSION_LIST_PATTERNS: readonly RegExp[] = [
  /\b(full|complete|entire|whole)\b[^.?!]{0,40}\b(cross[\s-]?reference|xref|conversion)\b[^.?!]{0,40}\b(list|sheet|chart|guide|catalog(ue)?)\b/i,
  /\b(cross[\s-]?reference|xref|conversion|convert)\b[^.?!]{0,40}\b(their|the|our|a|an|this)?\s*(whole|entire|full|complete)\s+(catalog(ue)?|line|product line|portfolio)\b/i,
  /\b(cross[\s-]?reference|xref|conversion)\s+(list|sheet|chart)\b[^.?!]{0,40}\b(their|the|our|a)?\s*(whole|entire|full|complete)?\s*(catalog(ue)?|line|conversion)\b/i,
];

function normalizeProductText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[®™]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Exported so the workflow can skip the competitor extraction when this message-only rule fires. */
export function isConversionListAsk(userMessage: string): boolean {
  return CONVERSION_LIST_PATTERNS.some((pattern) => pattern.test(userMessage));
}

function isBetcoBrand(brand: string | null): boolean {
  return BETCO_BRANDS.has(normalizeProductText(brand));
}

function chemistryTermMatch(product: string): string | null {
  const stripped = product.replace(/^(a|an|the)\s+/, '');
  return CHEMISTRY_TERMS.has(stripped) ? stripped : null;
}

export async function classifyCompetitorSelfReference(
  input: ClassifyCompetitorSelfReferenceInput,
): Promise<CompetitorSelfReferenceVerdict> {
  if (isConversionListAsk(input.userMessage)) {
    return {
      suppressed: true,
      reason: 'conversion_list_ask',
      productLineKey: null,
      matched: input.userMessage.trim(),
    };
  }

  if (isBetcoBrand(input.competitorBrand)) {
    return {
      suppressed: true,
      reason: 'betco_brand',
      productLineKey: null,
      matched: normalizeProductText(input.competitorBrand),
    };
  }

  const product = normalizeProductText(input.competitorProduct);
  if (!product) {
    return { suppressed: false };
  }

  const chemistry = chemistryTermMatch(product);
  if (chemistry) {
    return { suppressed: true, reason: 'chemistry_term', productLineKey: null, matched: chemistry };
  }

  try {
    const resolution = await input.resolveBetcoEntity(product);
    if (resolution.productLineKey && !resolution.ambiguousAlias) {
      return {
        suppressed: true,
        reason: 'betco_product',
        productLineKey: resolution.productLineKey,
        matched: product,
      };
    }
  } catch (error) {
    // Fail open: an unavailable alias table must not change today's routing.
    console.warn('[competitor-self-reference] resolver failed; not suppressing', {
      product,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { suppressed: false };
}
