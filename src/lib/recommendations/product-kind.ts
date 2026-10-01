/**
 * B0-795 — deterministic product-KIND classification, for the cross-reference confidence scorer.
 *
 * ## Why this exists
 *
 * `scoreRecommendation` combined three signals — top retrieval similarity, spec completeness and
 * mean candidate similarity — all of which are embedding-similarity or metadata-completeness
 * proxies. None of them asked the question a human asks first: *is the proposed Betco product even
 * the same kind of product?* Measured on B0-97's labeled harvest, the resulting score did not rank
 * correct answers above wrong ones (AUC 0.319 on 48 cases). The observed failure mode is exactly
 * the one a kind check catches: Misco `Hang-Tite Plus`, an acid bowl cleaner whose curated
 * equivalent is `Kling 9% HCl`, was answered with `Concentrated Acid Free Bathroom Disinfectant` —
 * materially different chemistry, and completely unpenalised because both read as "restroom
 * cleaner" to an embedding.
 *
 * ## Why a controlled vocabulary rather than `public.product_category`
 *
 * The category tables were evaluated first (that is AC1's ask) and are the wrong tool *for this
 * comparison*, for a structural reason rather than a coverage one:
 *
 *  - `product_category_link` links **product lines**, and its 464 rows split across two
 *    unreconciled taxonomies (`metakeywords`, 240 links / `betco_site_scrape`, 224) that are not
 *    joinable to each other (B0-205). Only one side of this comparison — the Betco candidate — is
 *    in them at all.
 *  - The **competitor** side has no row anywhere by construction: it is a third-party product
 *    described by an LLM-enriched spec. To use the taxonomy at all, the competitor's freeform
 *    `productCategory` would still have to be classified into it by text, which is this module.
 *  - `product_category.aliases` carries no synonyms — every alias is a concatenation of the node's
 *    own path (`Restroom - Acid Cleaner`). So the taxonomy supplies no vocabulary for competitor
 *    language ("bowl cleaner", "degreaser", "extraction") that this module would not have to
 *    supply anyway.
 *
 * What the taxonomy IS good for is the vocabulary's *shape*, and that is what was taken from it:
 * `DOMAIN` values below are the `metakeywords` root categories as they exist live
 * (Restroom / Floor Care / Carpet Care / Industrial / Gen'l Cleaning / Disinfectants / Laundry /
 * Warewash / Wood Floor / Skin Care / Odor / Food Serv / Concrete), and the kinds are its leaves
 * (Acid Cleaner vs Acid Free Cleaner, Sealers, Strippers, Finishes, Spotters, Glass, …). This is a
 * transcription of Betco's own product taxonomy, not an invented one.
 *
 * ## Contract
 *
 * Pure, deterministic, no DB / LLM / network. Classification is first-match-wins over an ordered
 * list, most specific first. An unrecognised text returns `null` — the scorer treats that as
 * "cannot judge" and never as "mismatch", the same no-fabrication rule `checkCategoryConsistency`
 * follows.
 */

export const PRODUCT_DOMAINS = [
  'restroom',
  'floor_care',
  'wood_floor',
  'carpet_care',
  'industrial',
  'general_cleaning',
  'disinfectants',
  'laundry',
  'warewash',
  'skin_care',
  'odor',
  'food_service',
  'concrete',
  'drain',
] as const;

export type ProductDomain = (typeof PRODUCT_DOMAINS)[number];

export type ProductKind = {
  domain: ProductDomain;
  /** Leaf grain, e.g. `bowl_cleaner_acid`. Two kinds in one domain are related, not equivalent. */
  kind: string;
};

type KindRule = ProductKind & { pattern: RegExp };

/**
 * Ordered most-specific-first; the first pattern that matches wins. Ordering is the whole
 * mechanism here — `floor sealer` must be tested before `sealer`, and `acid free` before `acid`.
 */
const KIND_RULES: KindRule[] = [
  // --- Restroom (metakeywords: Restroom / Acid Cleaner | Acid Free Cleaner | Mild Acid Cleaner) ---
  // Acid-free must precede acid: "acid free bowl cleaner" contains "acid".
  {
    domain: 'restroom',
    kind: 'bowl_cleaner_acid_free',
    pattern: /\bacid[-\s]?free\b|\bnon[-\s]?acid\b/i,
  },
  {
    domain: 'restroom',
    kind: 'bowl_cleaner_acid',
    pattern:
      /\b(?:bowl|toilet|urinal)\b[^.]{0,40}\b(?:acid|hcl|hydrochloric|phosphoric|sulfamic)\b|\b(?:acid|hcl|hydrochloric|phosphoric|sulfamic)\b[^.]{0,40}\b(?:bowl|toilet|urinal)\b|\bdelimer\b|\blime\s*(?:and|&)?\s*scale\b|\bscale\s*remover\b/i,
  },
  { domain: 'restroom', kind: 'bowl_cleaner', pattern: /\bbowl\s*cleaner\b|\btoilet\s*bowl\b/i },
  {
    domain: 'restroom',
    kind: 'restroom_cleaner',
    pattern: /\brestroom\b|\bbathroom\b|\bwashroom\b|\bshower\s*(?:room|cleaner)\b|\burinal\b/i,
  },

  // --- Skin care (metakeywords: Skin Care / Bulk | Industrial | Institutional | Countertop) ---
  {
    domain: 'skin_care',
    kind: 'hand_hygiene',
    pattern:
      /\bhand\s*(?:soap|wash|cleaner|sanitiz|scrub)\w*\b|\bbody\s*wash\b|\bshampoo\s*(?:and|&|\/)\s*body\b|\bskin\s*care\b|\bfoam(?:ing)?\s*soap\b|\blotion\s*soap\b/i,
  },

  // --- Warewash / Food service (metakeywords: Warewash / Machine Products | Solids; Food Serv) ---
  {
    domain: 'warewash',
    kind: 'warewash',
    pattern:
      /\bwarewash\w*\b|\bdish\w*\b|\brinse\s*(?:aid|additive)\b|\bpot\s*(?:and|&)\s*pan\b|\bmanual\s*detergent\b|\bpresoak\b|\bglassware\b|\bthird\s*sink\b|\bthree[-\s]?compartment\b/i,
  },
  {
    domain: 'food_service',
    kind: 'food_service_sanitizer',
    // Must actually BE a food-contact sanitizer. "use in food processing areas" is a use hint on a
    // degreaser, not a category, and reading it as one mislabelled 3 of 25 flagged mismatches.
    pattern: /\bfood[-\s]?contact\b[^.]{0,30}\bsanitiz\w*\b|\bsanitiz\w*\b[^.]{0,30}\bfood[-\s]?contact\b/i,
  },

  // --- Laundry (metakeywords: Laundry / Break | Sour & Softener | Spot & Reclaim) ---
  {
    domain: 'laundry',
    kind: 'laundry',
    pattern:
      /\blaundry\b|\blinen\b|\bfabric\s*softener\b|\bsour\b(?!\s*(?:cream|dough))|\bdestainer\b|\bbreak\s*detergent\b/i,
  },

  // --- Carpet care (metakeywords: Carpet Care / Cleaners | Spotters | Defoamers | Pre Sprays) ---
  { domain: 'carpet_care', kind: 'defoamer', pattern: /\bdefoamer\b|\bfoam\s*control\b/i },
  {
    domain: 'carpet_care',
    kind: 'spotter',
    pattern: /\bspotter\b|\bspot\s*(?:remover|and\s*stain)\b|\bstain\s*remover\b/i,
  },
  {
    domain: 'carpet_care',
    kind: 'carpet_cleaner',
    pattern:
      /\bcarpet\b|\bextraction\s*(?:cleaner|detergent)?\b|\bencapsulat\w*\b|\bpre[-\s]?spray\b|\bupholstery\b|\bbonnet\b/i,
  },

  // --- Wood floor (metakeywords: Wood Floor / WB Sealers | Water Based | Oil Modified Maint) ---
  {
    domain: 'wood_floor',
    kind: 'wood_floor',
    pattern: /\bwood\s*floor\b|\bhardwood\b|\bgym\s*floor\b|\bsport\s*floor\b|\bpolyurethane\b/i,
  },

  // --- Floor care (metakeywords: Floor Care / Finishes | Sealers | Strippers | Cleaners) ---
  {
    domain: 'floor_care',
    kind: 'stripper',
    pattern: /\bstripper\b|\bfinish\s*remover\b|\bwax\s*remover\b|\bstripping\b/i,
  },
  {
    domain: 'floor_care',
    kind: 'floor_finish',
    pattern:
      /\bfloor\s*(?:finish|wax|polish)\b|\bfloor\s*coating\b|\bburnish\w*\s*(?:finish|restorer)\b|\backryl\w*\s*(?:finish|polymer)\b/i,
  },
  { domain: 'floor_care', kind: 'floor_sealer', pattern: /\bsealer\b|\bsealant\b|\bundercoat\b/i },
  {
    domain: 'floor_care',
    kind: 'floor_cleaner',
    pattern:
      /\bfloor\s*(?:cleaner|cleaning|maintainer|maintenance|restorer|scrub)\w*\b|\bneutral\s*cleaner\b|\bauto\s*scrubber\s*(?:detergent|cleaner)\b|\bdaily\s*floor\b/i,
  },
  { domain: 'concrete', kind: 'concrete', pattern: /\bconcrete\b|\bterrazzo\b|\bpolished\s*stone\b/i },

  // --- Industrial (metakeywords: Industrial / Aqueous|Butyl|NonButyl|Solvent Dgrsr, Vehicle Washes) ---
  {
    domain: 'industrial',
    kind: 'vehicle_wash',
    pattern: /\bvehicle\s*wash\b|\btruck\s*wash\b|\bcar\s*wash\b/i,
  },
  {
    domain: 'industrial',
    kind: 'degreaser',
    pattern:
      /\bdegreas\w*\b|\bgrease\s*(?:remover|release|cutter)\b|\boil\s*(?:and|&)\s*grease\b|\bsolvent\s*cleaner\b|\bcarbon\s*remover\b/i,
  },

  // --- Drain (metakeywords root: General Cleaning Drain Maint.) ---
  {
    domain: 'drain',
    kind: 'drain_maintenance',
    pattern: /\bdrain\b|\bgrease\s*trap\b|\bseptic\b|\blift\s*station\b/i,
  },

  // --- Disinfectants (metakeywords: Disinfectants / Concentrates | Ready to use) --------------
  // Deliberately AFTER restroom/floor/carpet: a "restroom disinfectant" is a restroom product
  // first. This is what makes the Hang-Tite Plus miss visible rather than collapsing both sides
  // into one "disinfectant" bucket.
  {
    domain: 'disinfectants',
    kind: 'disinfectant',
    pattern: /\bdisinfect\w*\b|\bgermicid\w*\b|\bvirucid\w*\b|\bsanitiz\w*\b|\bsporicid\w*\b/i,
  },

  // --- General cleaning (metakeywords: Gen'l Cleaning / Glass | All Purpose | Polishes) -------
  {
    domain: 'general_cleaning',
    kind: 'glass_cleaner',
    pattern: /\bglass\b|\bwindow\s*cleaner\b|\bmirror\b/i,
  },
  {
    domain: 'general_cleaning',
    kind: 'polish',
    pattern: /\bstainless\s*steel\s*(?:polish|cleaner)\b|\bfurniture\s*polish\b|\bmetal\s*polish\b/i,
  },
  {
    domain: 'general_cleaning',
    kind: 'all_purpose',
    pattern:
      /\ball[-\s]?purpose\b|\bgeneral[-\s]?purpose\b|\bmulti[-\s]?(?:purpose|surface)\b|\bhard\s*surface\s*cleaner\b/i,
  },

  // --- Odor (metakeywords: Odor / Aerosol | Concentrate | Ready To Use) ---------------------
  // LAST, and deliberately narrow. Nearly every cleaning product claims to deodorize, so a bare
  // /deodoriz|fragrance/ rule placed earlier swallowed disinfectants, laundry detergents and bowl
  // cleaners wholesale — it accounted for 10 of the 25 kind "mismatches" on the first measured
  // pass. Only a product whose PURPOSE is odor lands here.
  {
    domain: 'odor',
    kind: 'odor_control',
    pattern:
      /\bair\s*(?:freshener|care)\b|\bmalodor\w*\b|\bodou?r\s*(?:control|counteract\w*|eliminat\w*|neutraliz\w*|manage\w*)\b|\b(?:urinal|deodorant)\s*block\b|\bdeodoriz\w*\s*(?:block|aerosol|spray)\b/i,
  },
];

/** Classify free text into a `{domain, kind}`, or `null` when nothing in the vocabulary matches. */
export function classifyProductKind(text: string | null | undefined): ProductKind | null {
  const source = (text ?? '').trim();
  if (!source) return null;
  for (const rule of KIND_RULES) {
    if (rule.pattern.test(source)) return { domain: rule.domain, kind: rule.kind };
  }
  return null;
}

/**
 * The competitor side: the two enrichment fields that say what the product IS.
 *
 * `keyClaims` and `chemistryClass` are deliberately EXCLUDED. Claims are marketing copy — "pleasant
 * fragrance", "deodorizes", "removes stains" — and folding them in made the classifier read a
 * hospital-grade bowl cleaner as an odor product. Measured: including claims produced 25 domain
 * "mismatches" in 72 comparable cases, the majority of which were this artefact rather than a real
 * category difference.
 */
export function competitorKindText(spec: {
  productCategory: string | null;
  primaryUse: string | null;
}): string {
  return [spec.productCategory, spec.primaryUse]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join('. ');
}

export const KIND_COMPATIBILITY = {
  /** Same domain and same leaf kind. */
  sameKind: 1,
  /** Same domain, different leaf — e.g. a floor sealer offered for a floor finish. Related, not equal. */
  sameDomain: 0.5,
  /** Different domain — a degreaser offered for a bowl cleaner. */
  mismatch: 0,
} as const;

export type KindCompatibility = {
  /** 0–1 compatibility, or `null` when either side could not be classified (never a penalty). */
  score: number | null;
  competitor: ProductKind | null;
  candidate: ProductKind | null;
};

/**
 * Compare the competitor's kind against a Betco candidate's. The candidate is classified from its
 * TITLE first and only falls back to its retrieved evidence text: a title is the product's own
 * identity, whereas a chunk body routinely name-drops neighbouring categories ("safe for use after
 * stripping", "not for use on carpet") and classifying on it first mislabels the candidate.
 */
export function compareProductKind(input: {
  competitorText: string;
  candidateTitle: string;
  candidateEvidence?: string | null;
}): KindCompatibility {
  const competitor = classifyProductKind(input.competitorText);
  const candidate =
    classifyProductKind(input.candidateTitle) ?? classifyProductKind(input.candidateEvidence);

  if (!competitor || !candidate) return { score: null, competitor, candidate };
  if (competitor.domain === candidate.domain) {
    return {
      score: competitor.kind === candidate.kind ? KIND_COMPATIBILITY.sameKind : KIND_COMPATIBILITY.sameDomain,
      competitor,
      candidate,
    };
  }
  return { score: KIND_COMPATIBILITY.mismatch, competitor, candidate };
}
