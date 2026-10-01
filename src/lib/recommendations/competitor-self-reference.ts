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
  /**
   * B0-875 — a chemistry class plus product-class words ("quat disinfectant", "Diversey quat
   * disinfectant", "peroxide cleaner") offered in place of a product. Distinct from
   * `chemistry_term` (a bare chemistry, which the product specialist answers with alternatives):
   * this shape means "replace my unnamed product of this kind", which only a clarifying question
   * can answer — the workflow renders `buildGenericChemistryClarification` for it.
   */
  | 'generic_chemistry_description'
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
 * B0-876 — Betco PRODUCT-LINE prefixes, not brands. "GE" is Betco's Green Earth line ("GE Fight
 * Bac RTU", "GE Daily Disinfectant", "GE Peroxide Cleaner"); the routers read the bare "GE" as a
 * competitor manufacturer. Grounded live 2026-09-07: 28 `rag.document` titles and 26 `rag.entity`
 * titles start with "GE ", 22 and 66 respectively with "Green Earth". Matched on the brand slot
 * OR as the leading word(s) of the product string; the prefix alone is a catalog-class signal
 * because the alias table cannot be relied on to carry the rest of the name (post-B0-878 it holds
 * 66 corpus-mined rows, none verified).
 *
 * B0-1057 — added 'greenearth' (the no-space variant seen live: "GreenEarth floor finish"),
 * 'triforce', and 'bestscent': three more real Betco product-line names that reached the
 * `recommend_cross_reference` tool-call path (which has no `resolveBetcoEntity` DB check in scope
 * to catch these the way the chat-workflow self-reference pipeline can) and got persisted as
 * "competitor" products — "BestScent Lemon Zest", "Triforce", "Green Earth Floor Finish".
 */
const BETCO_LINE_PREFIXES = ['green earth', 'greenearth', 'ge', 'triforce', 'bestscent'] as const;

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
 * B0-875 — chemistry-class tokens for the "<chemistry> <product class>" shape. A product string
 * built ONLY from these plus `PRODUCT_CLASS_WORDS` (e.g. "quat disinfectant", "hydrogen peroxide
 * disinfectant", "acid bowl cleaner", "enzyme digester") names a kind of product, not a product.
 * Any other token ("spartan", "virex", "bnc") is identity and disqualifies the shape.
 */
const CHEMISTRY_CLASS_WORDS = new Set([
  'quat', 'quats', 'quaternary', 'ammonium', 'bleach', 'chlorine', 'chlorinated', 'hypochlorite',
  'peroxide', 'hydrogen', 'peracetic', 'peroxyacetic', 'enzyme', 'enzymes', 'enzymatic', 'acid',
  'acidic', 'phenolic', 'phenol', 'alcohol', 'ammonia', 'ammoniated', 'citric', 'lactic', 'oxidizing',
  'solvent', 'butyl',
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
  // B0-1057 — facility/setting words: "hospital disinfectant", "healthcare cleaner" name a KIND of
  // customer/setting, not a product, exactly like the category words above.
  'hospital', 'hospitals', 'healthcare', 'medical', 'clinic', 'clinics', 'school', 'schools',
  'daycare', 'gym', 'gyms', 'athletic', 'kitchen', 'kitchens', 'office', 'offices', 'industrial',
  'commercial', 'institutional', 'nursing', 'facility', 'facilities', 'building', 'buildings',
]);

/**
 * B0-875 — the product-class vocabulary for `isGenericChemistryDescription`: the category words
 * above plus the handful of class nouns the golden shapes use that are not category words in the
 * catalog sense ("digester", "bowl cleaner", "based").
 */
const PRODUCT_CLASS_WORDS = new Set([
  ...GENERIC_PRODUCT_WORDS,
  'digester', 'digesters', 'bowl', 'toilet', 'urinal', 'drain', 'based', 'type', 'style', 'generic',
  'sanitizers', 'sanitiser', 'sanitisers', 'disinfecting', 'cleaning', 'sanitizing', 'deodorant',
  'hand', 'wipes', 'some', 'any', 'kind', 'of', 'or', 'brand',
]);

/**
 * True when the name carries at least one token that identifies rather than describes.
 *
 * B0-1057 — exported so `extract-competitor-product.ts`'s `isImplausibleCompetitorProductText`
 * (the guard for `product-tools.ts`'s tool-call case, which has no `resolveBetcoEntity` DB check
 * in scope) can reuse this same "is there any actual identity here" test rather than a second,
 * drifting copy. `product` must already be lowercased/trimmed by the caller (mirrors every other
 * function in this file).
 */
export function hasDistinctiveToken(product: string): boolean {
  return product
    .split(/[^a-z0-9]+/)
    .some((token) => token.length >= 3 && !GENERIC_PRODUCT_WORDS.has(token));
}

/**
 * B0-875 — "<chemistry> <product class>" with nothing else: at least one chemistry-class token, at
 * least one other token, and EVERY token drawn from the chemistry or product-class vocabularies.
 * A bare chemistry ("bleach", "quats") is deliberately NOT this shape — that stays with the B0-786
 * signal / `CHEMISTRY_TERMS` rule, so the signal keeps deciding the bare case.
 *
 * B0-887 — a leading article is stripped first (mirroring `chemistryTermMatch`'s own stripping) so
 * "a quat" tokenises to the single word "quat" and correctly falls short of the 2-token floor,
 * instead of counting "a" as a second (product-class) token and misreading a bare chemistry plus an
 * article as this "<chemistry> <product class>" shape. This is now checked BEFORE the bare-chemistry
 * check in `classifyCompetitorSelfReference`, so this floor is what keeps "a quat" as `chemistry_term`.
 */
export function isGenericChemistryDescription(product: string): boolean {
  const stripped = product.replace(/^(a|an|the)\s+/, '');
  const tokens = stripped.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length < 2) return false;
  let chemistry = 0;
  for (const token of tokens) {
    if (CHEMISTRY_CLASS_WORDS.has(token)) {
      chemistry += 1;
    } else if (!PRODUCT_CLASS_WORDS.has(token)) {
      return false;
    }
  }
  return chemistry >= 1 && chemistry < tokens.length;
}

function normalizeProductText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[®™℠]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Exported so the workflow can skip the competitor extraction when this message-only rule fires. */
export function isConversionListAsk(userMessage: string): boolean {
  return CONVERSION_LIST_PATTERNS.some((pattern) => pattern.test(userMessage));
}

/**
 * B0-1056 — exported so `product-tools.ts`'s `recommend_cross_reference` tool case (which has no
 * user message or `resolveBetcoEntity` in scope to run the full `classifyCompetitorSelfReference`
 * pipeline, only the model's own `competitorBrand` tool-call argument) can still catch the cheap,
 * unambiguous case: the model naming Betco/Basic Coatings/EnviroZyme itself as the "competitor".
 */
export function isBetcoBrand(brand: string | null): boolean {
  return BETCO_BRANDS.has(normalizeProductText(brand));
}

function chemistryTermMatch(product: string): string | null {
  const stripped = product.replace(/^(a|an|the)\s+/, '');
  return CHEMISTRY_TERMS.has(stripped) ? stripped : null;
}

/**
 * B0-876 — split a Betco line prefix off the (brand, product) pair. Returns null when neither the
 * brand slot is a line prefix nor the product starts with one. `name` is what is left to resolve
 * ("fight bac rtu"); `full` is the whole normalised phrase ("ge fight bac rtu") for the audit row.
 * Only consulted when no OTHER brand is named — a real competitor brand still settles the turn.
 */
export function splitBetcoLinePrefix(
  brand: string,
  product: string,
): { prefix: string; name: string; full: string } | null {
  for (const prefix of BETCO_LINE_PREFIXES) {
    if (brand === prefix) {
      const name = product.startsWith(`${prefix} `) ? product.slice(prefix.length + 1) : product;
      return { prefix, name: name.trim(), full: `${prefix} ${name}`.trim() };
    }
  }
  if (brand) return null;
  for (const prefix of BETCO_LINE_PREFIXES) {
    // B0-1057 — a bare line name with nothing after it ("Triforce" on its own, no brand slot) is
    // still the line itself, not a competitor product; there's just no further name to resolve.
    if (product === prefix) {
      return { prefix, name: '', full: product };
    }
    if (product.startsWith(`${prefix} `)) {
      return { prefix, name: product.slice(prefix.length + 1).trim(), full: product };
    }
  }
  return null;
}

/** `betco.com` and its subdomains only — never a competitor domain that merely mentions Betco. */
export function isBetcoHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'betco.com' || host.endsWith('.betco.com');
  } catch {
    return false;
  }
}

/**
 * B0-876 — the web-search backstop's TOP result for the "competitor" is a betco.com page: the
 * product is Betco's own (P#19: betco.com/products/ge-fight-bac-rtu-canada). Top result only — a
 * betco.com page further down a genuine competitor's results is not evidence of anything.
 */
export function findBetcoSelfReferenceWebResult<T extends { url: string; title?: string | null }>(
  results: readonly T[],
): T | null {
  const top = results[0];
  return top && isBetcoHost(top.url) ? top : null;
}

async function resolveFailOpen(
  resolve: ClassifyCompetitorSelfReferenceInput['resolveBetcoEntity'],
  name: string,
): Promise<BetcoEntityResolution | null> {
  try {
    return await resolve(name);
  } catch (error) {
    // Fail open: an unavailable alias table must not change today's routing.
    console.warn('[competitor-self-reference] resolver failed; not suppressing', {
      product: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function verdictFromResolution(
  resolution: BetcoEntityResolution,
  matched: string,
): CompetitorSelfReferenceVerdict | null {
  if (resolution.productLineKey && !resolution.ambiguousAlias) {
    return {
      suppressed: true,
      reason: 'betco_product',
      productLineKey: resolution.productLineKey,
      matched,
    };
  }
  /**
   * An alias spanning several product lines (pH7Q resolves to three EPA-registered formulations)
   * is still unambiguously OURS — the ambiguity is about which line, which this check does not
   * need. The resolver returns no key in that case, so read the flag rather than the key.
   */
  if (resolution.ambiguousAlias) {
    return { suppressed: true, reason: 'betco_product', productLineKey: null, matched };
  }
  // Catalog membership last: the weakest signal, and the one that catches the products with no
  // alias row at all (speedex, grease solv, af315).
  if (resolution.catalogMatch) {
    return {
      suppressed: true,
      reason: 'betco_catalog',
      productLineKey: resolution.catalogProductLineKey,
      matched,
    };
  }
  return null;
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
  const brand = normalizeProductText(input.competitorBrand);

  /**
   * B0-875 — "<chemistry> <product class>" is a description, not an identity, whether or not a
   * brand accompanies it ("Diversey" + "quat disinfectant" was cross-referenced to a fuzzy legacy
   * row at 0.675 on the golden run). Checked BEFORE the named-brand rule below because the brand
   * does not identify the product either.
   *
   * B0-887 — also checked BEFORE the `chemistry_term` block below, not after. The B0-786 signal's
   * `competitorIsGenericChemistry` is documented as "a bare chemistry rather than a product", but
   * verified live it also comes back `true` for "quat disinfectant" — a chemistry-class word plus a
   * product-class word, not a bare chemistry. Trusting that signal first (the old order) meant
   * `chemistry = product` fired unconditionally and returned `reason: 'chemistry_term'` before this
   * deterministic shape check ever ran, so "Diversey quat disinfectant" never got the clarifying
   * question and a specific Betco product (with a dilution ratio) was recommended for an unnamed
   * competitor product instead. `isGenericChemistryDescription` requires at least 2 tokens with at
   * least one — but not all — drawn from the chemistry vocabulary, so a truly bare chemistry
   * ("quat", "quats", "chlorine bleach", "hydrogen peroxide", "quaternary ammonium") still returns
   * `false` here and falls through to the `chemistry_term` check unaffected.
   */
  if (isGenericChemistryDescription(product)) {
    return {
      suppressed: true,
      reason: 'generic_chemistry_description',
      productLineKey: null,
      matched: [brand, product].filter(Boolean).join(' '),
    };
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
   * B0-876 — "GE" / "Green Earth" in the brand slot, or leading the product string, is a Betco
   * product line, not a competitor. The rest of the name is resolved for a product line when the
   * catalog has it; the prefix alone still suppresses (catalog-class) when it does not.
   */
  const linePrefixed = splitBetcoLinePrefix(brand, product);
  if (linePrefixed) {
    const resolution = linePrefixed.name
      ? await resolveFailOpen(input.resolveBetcoEntity, linePrefixed.name)
      : null;
    const resolved = resolution ? verdictFromResolution(resolution, linePrefixed.full) : null;
    return (
      resolved ?? {
        suppressed: true,
        reason: 'betco_catalog',
        productLineKey: null,
        matched: linePrefixed.full,
      }
    );
  }

  /**
   * B0-751 follow-up — a named brand that is not one of ours settles it: this is a real competitor,
   * so no amount of product-name matching below may withdraw the cross-reference. Without this,
   * a generic product half ("3M" + "#1 Glass Cleaner") could match a Betco title and suppress the
   * single thing the cross-reference path exists to do.
   */
  if (brand) {
    return { suppressed: false };
  }

  // A pure category description identifies nothing — see GENERIC_PRODUCT_WORDS.
  if (!hasDistinctiveToken(product)) {
    return { suppressed: false };
  }

  const resolution = await resolveFailOpen(input.resolveBetcoEntity, product);
  return (resolution && verdictFromResolution(resolution, product)) ?? { suppressed: false };
}
