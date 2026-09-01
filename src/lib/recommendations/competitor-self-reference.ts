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
  | 'betco_catalog'
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
  /**
   * B0-751 follow-up — the name is in the Betco catalog even though no single product line
   * resolved. The alias table has no row for most product names (speedex, grease solv, af315,
   * green earth all have zero), so alias resolution alone answered "not ours" for products that
   * plainly are. Membership is the question this check actually asks; the line key is a bonus.
   */
  catalogMatch: boolean;
  catalogProductLineKey: string | null;
};

export type ClassifyCompetitorSelfReferenceInput = {
  userMessage: string;
  competitorBrand: string | null;
  competitorProduct: string | null;
  resolveBetcoEntity: (name: string) => Promise<BetcoEntityResolution>;
  /**
   * B0-786 — when the consolidated signals call decided these, its verdict is used INSTEAD of the
   * keyword rules below (`CONVERSION_LIST_PATTERNS`, `CHEMISTRY_TERMS`). Omitted — by a standalone
   * caller, or by a turn whose signals call degraded — and those rules still decide, so this
   * module's behaviour without them is byte-identical to before B0-786.
   */
  isConversionListAsk?: boolean;
  competitorIsGenericChemistry?: boolean;
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

/**
 * B0-751 follow-up — words that describe a product category rather than identify a product. A name
 * built only from these ("low-odor floor stripper", "glass cleaner") is a DESCRIPTION of what the
 * user wants, not a product identity, and it would substring-match dozens of Betco titles. Matching
 * on one would suppress a genuine cross-reference, so the catalog tier is skipped unless at least
 * one token carries identity. Category words only — never a brand or product word.
 */
const GENERIC_PRODUCT_WORDS = new Set([
  'cleaner', 'cleaners', 'degreaser', 'disinfectant', 'disinfectants', 'sanitizer', 'stripper',
  'finish', 'sealer', 'soap', 'detergent', 'deodorizer', 'polish', 'wax', 'shampoo',
  'floor', 'floors', 'glass', 'restroom', 'bathroom', 'carpet', 'wood', 'tile', 'window',
  'multi', 'surface', 'general', 'purpose', 'all', 'low', 'odor', 'free', 'heavy', 'duty',
  'concentrate', 'concentrated', 'rtu', 'ready', 'to', 'use', 'neutral', 'acid', 'foam', 'foaming',
  'product', 'products', 'solution', 'chemical', 'spray', 'wipe', 'liquid', 'and', 'the', 'a', 'an',
]);

/** True when the name carries at least one token that identifies rather than describes. */
function hasDistinctiveToken(product: string): boolean {
  return product
    .split(/[^a-z0-9]+/)
    .some((token) => token.length >= 3 && !GENERIC_PRODUCT_WORDS.has(token));
}

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
  if (input.isConversionListAsk ?? isConversionListAsk(input.userMessage)) {
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

  // B0-786 — the signal says WHETHER it is a bare chemistry; the matched text is then the product
  // string itself (there is no keyword term to report).
  const chemistry =
    input.competitorIsGenericChemistry === undefined
      ? chemistryTermMatch(product)
      : input.competitorIsGenericChemistry
        ? product
        : null;
  if (chemistry) {
    return { suppressed: true, reason: 'chemistry_term', productLineKey: null, matched: chemistry };
  }

  /**
   * B0-751 follow-up — a named brand that is not one of ours settles it: this is a real competitor,
   * so no amount of product-name matching below may withdraw the cross-reference. Without this,
   * a generic product half ("3M" + "#1 Glass Cleaner", "Diversey" + "quat disinfectant") could
   * match a Betco title and suppress the single thing the cross-reference path exists to do.
   */
  if (input.competitorBrand && normalizeProductText(input.competitorBrand)) {
    return { suppressed: false };
  }

  // A pure category description identifies nothing — see GENERIC_PRODUCT_WORDS.
  if (!hasDistinctiveToken(product)) {
    return { suppressed: false };
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
    /**
     * An alias spanning several product lines (pH7Q resolves to three EPA-registered formulations)
     * is still unambiguously OURS — the ambiguity is about which line, which this check does not
     * need. The resolver returns no key in that case, so read the flag rather than the key.
     */
    if (resolution.ambiguousAlias) {
      return { suppressed: true, reason: 'betco_product', productLineKey: null, matched: product };
    }
    // Catalog membership last: the weakest signal, and the one that catches the products with no
    // alias row at all (speedex, grease solv, af315).
    if (resolution.catalogMatch) {
      return {
        suppressed: true,
        reason: 'betco_catalog',
        productLineKey: resolution.catalogProductLineKey,
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
