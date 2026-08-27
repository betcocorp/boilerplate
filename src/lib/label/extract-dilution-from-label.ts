/**
 * B0-264 — deterministic dilution extractor for already-ingested product labels.
 *
 * Regulated-data contract (EPA/GHS label data):
 *  - Printed values are transcribed VERBATIM into `display`. Nothing is rounded or reworded.
 *  - The ONLY sanctioned derivation is `128 / N` for a printed `1:N` ratio (one US gallon = 128 oz),
 *    matching 20260715090100_backfill_product_line_fact_from_entity.sql and
 *    20260724120000_extract_dilution_from_directions_text.sql.
 *  - No unit conversion, ever. Metric-only (Canadian) labels are skipped, not converted.
 *  - Ambiguity is resolved by SKIPPING. "No verified data" is a safe answer; a wrong number is not.
 *
 * This module is pure (no network, no DB) so it can be unit-tested and reused by
 * scripts/extract-label-dilution.mjs and by any future ingestion pass.
 */

/** Why a label yielded no defensible dilution value. Mirrors the skip rules in the B0-264 pass 1 migration header. */
export type DilutionSkipReason =
  | 'no_directions_section'
  | 'no_dilution_language'
  | 'ready_to_use'
  | 'conflicting_use_modes'
  | 'multi_tier_range'
  | 'other_product_ratio'
  | 'metric_only'
  | 'capacity_dosing'
  | 'non_per_gallon_dose'
  | 'not_a_water_dilution'
  | 'word_form_ratio'
  | 'single_mode_of_many'
  | 'unreadable_value';

export type DilutionMentionKind =
  | 'oz_per_gal'
  | 'ratio'
  | 'range'
  | 'metric'
  | 'non_per_gallon'
  | 'unreadable';

export interface DilutionMention {
  kind: DilutionMentionKind;
  /** Exact printed text, verbatim, as it appears on the label. */
  raw: string;
  /** Parsed oz/gal for `oz_per_gal`; the N of a printed `1:N` for `ratio`; null otherwise. */
  value: number | null;
  index: number;
  /** The sentence-ish window the mention was found in, used by the skip rules. */
  context: string;
}

export type DilutionExtraction =
  | {
      status: 'extracted';
      /** Numeric oz per US gallon. Null when the printed value is a range/weight the column cannot hold. */
      ozPerGal: number | null;
      /** Verbatim printed text for `product_line_fact.dilution_display`. */
      display: string;
      mention: DilutionMention;
    }
  | { status: 'skipped'; reason: DilutionSkipReason; detail?: string };

export interface ExtractDilutionOptions {
  /**
   * Document/product title, used by the `other_product_ratio` rule to tell "this product's ratio"
   * from "a different named product referenced in a prep step".
   */
  productTitle?: string;
  /**
   * When true (default) and the directions block contains the English marker `DIRECTIONS FOR USE`,
   * only the text from that marker onward is considered. Betco labels interleave FR/ES panels
   * ahead of the English directions, and those panels are metric-first.
   */
  preferEnglishWindow?: boolean;
}

const CONTEXT_RADIUS = 160;

/** Capacity/weight dosing — not a water dilution. */
const CAPACITY_PATTERNS: RegExp[] = [
  /cubic\s*(?:feet|foot|ft)/i,
  /grease\s*trap/i,
  /septic\s*tank/i,
  /drain\s*line|drainline|down\s*pipe/i,
  /pipe\s*size/i,
  /per\s*\d+\s*(?:lb|lbs|pound)/i,
  /solution\s*tank/i,
  /per\s*(?:week|wk|day|daily)/i,
];

/** Multi-tier soil-load language with no tier marked as the general-use default. */
const TIER_WORDS = /light|medium|moderate|heavy|normal|maximum|minimum/i;

/**
 * A printed CEILING ("up to 12 ounces", "will not allow for more than 12 ounces per gallon") is not
 * a use dilution, and "per gallon of <finish>" is a dose into another product, not into water.
 */
const CEILING_PATTERNS: RegExp[] = [/\bup\s+to\b/i, /\bmore\s+than\b/i, /\bat\s+most\b/i, /\bmaximum\s+of\b/i];
const NON_WATER_PER_GALLON =
  /per\s+gallon\s+of\s+(?!water|warm\s+water|cool\s+water|cold\s+water|hot\s+water|clean\s+water)/i;

/**
 * Ratios written in words ("Dilute with equal parts of water", "one part cleaner to two parts
 * water", "may be diluted with up to 100 parts water"). Turning these into oz/gal is an inference,
 * not the sanctioned `128 / N` arithmetic on a printed `1:N`, so they are skipped.
 */
const WORD_FORM_RATIO_PATTERNS: RegExp[] = [
  /\bequal\s+parts?\b/i,
  /\b(?:one|two|three|four|1|2|3|4)\s+parts?\b[^.]{0,60}\bparts?\s+water\b/i,
  /\bparts?\s+water\b/i,
];

/**
 * Betco labels split directions into ALL-CAPS use-mode headings ("SHOWERS:", "GLASS/MIRROR
 * CLEANER:", "TRIGGER SPRAYERS:"). When several modes exist and only ONE prints a dilution, the
 * other modes are direct/undiluted application and the single figure is mode-specific — promoting
 * it to the line would tell a customer to dilute a product that its own label says to apply neat.
 * This is the inverse of the B0-265 defect and is treated the same way: abstain.
 */
const USE_MODE_HEADING_RE = /(?:^|[\n>.]|<br\s*\/?>)\s*(?:<\/?strong>\s*)?([A-Z][A-Z0-9 /&'-]{2,40}):/g;
const NON_MODE_HEADINGS = new Set(
  [
    'DIRECTIONS FOR USE',
    'DIRECTIONS',
    'FIRST AID',
    'CAUTION',
    'WARNING',
    'DANGER',
    'NOTE',
    'IMPORTANT',
    'PRECAUTIONS',
    'PRECAUTIONARY STATEMENTS',
    'CONTACT TIME',
    'AREAS OF USE',
    'SURFACES',
    'DISPOSAL',
    'DISPOSAL OF INFECTIOUS MATERIAL',
    'DISPOSAL OF INFECTIOUS MATERIALS',
    'PERSONAL PROTECTION',
    'CLEANING PROCEDURE',
    'SPECIAL INSTRUCTIONS',
    'WHERE TO USE',
    'SAFETY',
    'ATTENTION',
    'STORAGE',
    'BACTERICIDAL',
    'VIRUCIDAL',
    'FUNGICIDAL',
    'MYCOBACTERICIDAL',
    'SANITIZER',
    'DISPENSER DIRECTIONS',
    'USE',
    'CONTAINS',
  ].map((h) => h.trim()),
);

const RTU_PATTERNS: RegExp[] = [
  /do\s*not\s*dilute/i,
  /ready[\s-]*to[\s-]*use/i,
  /use\s*(?:full\s*strength|undiluted)/i,
  /no\s*dilution\s*(?:is\s*)?(?:required|necessary)/i,
];

/**
 * A ratio printed on the label for some OTHER product used in a prep step, e.g.
 *   "Mix Squeaky Cleaner at 32 oz./gal…"            (this product is a floor finish)
 *   "Mixwood finish maintenance cleaner at 32 oz./gal…"  (OCR ran the words together)
 *   "Saturate stained area with … Betco Densiclean at 0.5 oz. per gallon (1:256)"
 * Two detectors, because label OCR destroys both casing and word boundaries:
 *  1. an explicitly `Betco `-branded name in the mention's context, and
 *  2. a prep verb followed by a noun phrase ending in a product noun.
 * Both are ignored when the name is this document's own product.
 */
const BETCO_BRANDED_RE = /\bBetco\s+([A-Z][A-Za-z0-9®™-]{2,})/g;
const PREP_VERB_RE =
  /\b(?:mix|use|clean(?:ed)?\s+with|pre-?clean\s+with|prepare[d]?(?:\s+with)?|saturate[^.\n]{0,40}?\s+with|apply[^.\n]{0,40}?\s+with|fill[^.\n]{0,40}?\s+using)\s*/gi;
/**
 * Case-INSENSITIVE on purpose: OCR flattens "Wood Finish Maintenance Cleaner" to lowercase and even
 * glues it to the verb. Determiner-led phrases ("this cleaner", "the product") are excluded so a
 * label describing itself is not mistaken for a reference to something else.
 */
const PRODUCT_NAME_RE =
  /^(?:Betco\s+)?((?!(?:this|that|the|a|an|our|product|it)\b)[A-Za-z0-9®™'-]+(?:\s+[A-Za-z0-9®™'-]+){0,3}\s*(?:cleaner|finish|stripper|soap|detergent|concentrate|sealer|remover))\b/i;

/** Parses "13", "0.5", "1/2", "25.6" as printed. No rounding. */
function parsePrintedNumber(raw: string): number | null {
  const fraction = raw.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    if (!denominator) return null;
    return Number(fraction[1]) / denominator;
  }
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function contextAround(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index - CONTEXT_RADIUS), Math.min(text.length, index + length + CONTEXT_RADIUS));
}

/**
 * Pulls the directions/dilution block out of an ingested label's `body_markdown`.
 * Label markdown carries `<!-- section_type: directions -->` markers (see
 * 20260725100000 label ingestion output); falls back to matching the heading text.
 */
export function extractDirectionsSection(bodyMarkdown: string | null | undefined): string | null {
  if (!bodyMarkdown) return null;
  const blocks = bodyMarkdown.split(/\n(?=##\s)/g);
  for (const block of blocks) {
    const heading = block.split('\n', 1)[0] ?? '';
    if (!heading.startsWith('##')) continue;
    if (/section_type:\s*(?:directions|dilution)/i.test(heading) || /directions|dilution/i.test(heading)) {
      return block;
    }
  }

  // `product_line_profile` documents use plain `Label:` sections rather than markdown headings.
  // Only the Directions block counts — a dilution stated in `Description:` marketing prose is not
  // a directions-for-use statement and must not be promoted to a fact.
  const profileMatch = bodyMarkdown.match(
    /(?:^|\n)(Directions for use|Dilution)\s*:[ \t]*\n?([\s\S]*?)(?=\n[A-Z][A-Za-z /&]{2,40}\s*:[ \t]*\n|$)/,
  );
  if (profileMatch) return `${profileMatch[1]}:\n${profileMatch[2]}`;

  return null;
}

/** All dilution-shaped mentions in a block of directions text, in document order. */
export function findDilutionMentions(text: string): DilutionMention[] {
  const mentions: DilutionMention[] = [];

  // Doses stated per MULTIPLE gallons ("3 fl. oz. per 10 gallons", "2 ounces to 5 gallons"). Never
  // divided down to a per-gallon figure — that would be a conversion of a printed regulated value.
  const perManyGalRe =
    /(\d+(?:\.\d+)?)\s*(?:fl\.?\s*)?(?:oz|ounce)s?\.?[^\n]{0,30}?(?:\/|per|to|in)\s*(\d+)\s*(?:gallons?|gals?\.?)/gi;
  for (const match of text.matchAll(perManyGalRe)) {
    if (Number(match[2]) === 1) continue; // "per 1 gallon" is a normal per-gallon dose
    mentions.push({
      kind: 'non_per_gallon',
      raw: match[0],
      value: null,
      index: match.index ?? 0,
      context: contextAround(text, match.index ?? 0, match[0].length),
    });
  }

  // Ranges next ("4 - 8 ounces per gallon", "1 or 2 ounces per gallon") so they aren't mis-read as
  // single values. `or` matters: "1 or 2 ounces per gallon" is two printed alternatives, not 2 oz/gal.
  // Intervening words are tolerated ("use 12 - 16 oz. of this product per gallon of water") because
  // a missed range is a wrong number, while an over-eager range is only a skip.
  const rangeRe =
    /(\d+(?:\.\d+)?)\s*(?:-|–|to|or)\s*(\d+(?:\.\d+)?)\s*(?:fl\.?\s*)?(?:oz|ounce)s?\.?[^\n]{0,30}?(?:\/|per)?\s*(?:US\s*)?(?:gallons?|gals?\.?)/gi;
  for (const match of text.matchAll(rangeRe)) {
    mentions.push({
      kind: 'range',
      raw: match[0],
      value: null,
      index: match.index ?? 0,
      context: contextAround(text, match.index ?? 0, match[0].length),
    });
  }

  const ozRe = /(\d+(?:\.\d+)?|\d+\s*\/\s*\d+)\s*(?:fl\.?\s*)?(?:oz|ounce)s?\.?\s*(?:\/|per)\s*(?:US\s*)?(?:gallons?|gals?\.?)/gi;
  for (const match of text.matchAll(ozRe)) {
    const index = match.index ?? 0;
    if (
      mentions.some(
        (m) =>
          (m.kind === 'range' || m.kind === 'non_per_gallon') &&
          index >= m.index &&
          index < m.index + m.raw.length,
      )
    ) {
      continue;
    }
    const value = parsePrintedNumber((match[1] ?? '').replace(/\s+/g, ''));
    mentions.push({
      kind: value === null ? 'unreadable' : 'oz_per_gal',
      raw: match[0],
      value,
      index,
      context: contextAround(text, index, match[0].length),
    });
  }

  const ratioRe = /\b1\s*:\s*(\d{1,4})\b/g;
  for (const match of text.matchAll(ratioRe)) {
    const index = match.index ?? 0;
    mentions.push({
      kind: 'ratio',
      raw: match[0],
      value: Number(match[1]),
      index,
      context: contextAround(text, index, match[0].length),
    });
  }

  const metricRe = /(\d+(?:\.\d+)?)\s*m[Ll]\s*(?:\/|per)\s*(?:\d+\s*)?[Ll](?:itre|iter)?\b/g;
  for (const match of text.matchAll(metricRe)) {
    const index = match.index ?? 0;
    mentions.push({
      kind: 'metric',
      raw: match[0],
      value: null,
      index,
      context: contextAround(text, index, match[0].length),
    });
  }

  return mentions.sort((a, b) => a.index - b.index);
}

/**
 * Splits directions into ALL-CAPS use-mode segments and reports how many exist and how many print a
 * dilution figure. Returns null when the text is not organised into such modes.
 */
export function countUseModeSegments(text: string): { modes: number; modesWithDilution: number } | null {
  USE_MODE_HEADING_RE.lastIndex = 0;
  const marks: Array<{ heading: string; index: number }> = [];
  for (const match of text.matchAll(USE_MODE_HEADING_RE)) {
    const heading = (match[1] ?? '').trim();
    if (NON_MODE_HEADINGS.has(heading)) continue;
    marks.push({ heading, index: (match.index ?? 0) + match[0].length });
  }
  if (marks.length < 2) return null;

  let modesWithDilution = 0;
  for (let i = 0; i < marks.length; i += 1) {
    const segment = text.slice(marks[i]!.index, marks[i + 1]?.index ?? text.length);
    if (findDilutionMentions(segment).length > 0) modesWithDilution += 1;
  }
  return { modes: marks.length, modesWithDilution };
}

function isCapacityDosing(mention: DilutionMention): boolean {
  return CAPACITY_PATTERNS.some((pattern) => pattern.test(mention.context));
}

function referencesOtherProduct(mention: DilutionMention, productTitle: string | undefined): boolean {
  const title = (productTitle ?? '').toLowerCase();
  /** True when `named` is not this document's own product. */
  const isForeign = (named: string): boolean =>
    Boolean(named) && !(title && (title.includes(named) || named.includes(title)));

  BETCO_BRANDED_RE.lastIndex = 0;
  for (const branded of mention.context.matchAll(BETCO_BRANDED_RE)) {
    if (isForeign((branded[1] ?? '').toLowerCase())) return true;
  }

  PREP_VERB_RE.lastIndex = 0;
  for (const verb of mention.context.matchAll(PREP_VERB_RE)) {
    const tail = mention.context.slice((verb.index ?? 0) + verb[0].length);
    const named = tail.match(PRODUCT_NAME_RE)?.[1]?.toLowerCase().trim();
    if (!named) continue;
    if (isForeign(named)) return true;
  }
  return false;
}

/**
 * An EXPLICIT printed ready-to-use statement, e.g. "Product is ready to use. DO NOT DILUTE." or a
 * spec line reading `Dilution: RTU`. Returns the verbatim statement only when the WHOLE document
 * also carries no dilution figure of any kind — a product with both an RTU mode and a printed
 * ratio somewhere is ambiguous, and B0-265 showed exactly that trap ("Ready-to-Use Deodorizing
 * Liquid" prints a real 13 oz./gal. trigger-sprayer dilution). Absence of a ratio is what makes
 * "Ready to use" an answer rather than a guess.
 */
export function extractRtuStatement(
  bodyMarkdown: string | null | undefined,
): { rtu: true; statement: string } | null {
  const body = bodyMarkdown ?? '';
  if (!body) return null;

  const explicit =
    body.match(/DO\s+NOT\s+DILUTE/i) ??
    body.match(/Dilution:\s*RTU\b/i) ??
    body.match(/Product\s+is\s+ready\s+to\s+use\.?/i);
  if (!explicit) return null;

  // Any dilution figure anywhere in the document disqualifies the RTU reading.
  if (findDilutionMentions(body).length > 0) return null;
  if (WORD_FORM_RATIO_PATTERNS.some((pattern) => pattern.test(body))) return null;

  return { rtu: true, statement: explicit[0] };
}

/**
 * Deterministic dilution extraction from an ingested label's markdown body.
 * Returns `{status:'skipped'}` for every case the B0-264 rule set says must not be guessed.
 */
export function extractDilutionFromLabel(
  bodyMarkdown: string | null | undefined,
  options: ExtractDilutionOptions = {},
): DilutionExtraction {
  const { productTitle, preferEnglishWindow = true } = options;

  const section = extractDirectionsSection(bodyMarkdown);
  if (!section) return { status: 'skipped', reason: 'no_directions_section' };

  let text = section;
  if (preferEnglishWindow) {
    const englishMarker = text.search(/DIRECTIONS\s+FOR\s+USE/i);
    if (englishMarker >= 0) text = text.slice(englishMarker);
  }

  const allMentions = findDilutionMentions(text);
  if (allMentions.length === 0) {
    if (RTU_PATTERNS.some((pattern) => pattern.test(text))) {
      return { status: 'skipped', reason: 'ready_to_use' };
    }
    if (WORD_FORM_RATIO_PATTERNS.some((pattern) => pattern.test(text))) {
      return { status: 'skipped', reason: 'word_form_ratio' };
    }
    return { status: 'skipped', reason: 'no_dilution_language' };
  }

  if (allMentions.some((m) => m.kind === 'unreadable')) {
    return {
      status: 'skipped',
      reason: 'unreadable_value',
      detail: allMentions.find((m) => m.kind === 'unreadable')?.raw,
    };
  }

  // Capacity/weight dosing mentions are not water dilutions — drop them, then re-decide.
  const dosing = allMentions.filter((m) => !isCapacityDosing(m));
  if (dosing.length === 0) {
    return { status: 'skipped', reason: 'capacity_dosing' };
  }

  const otherProduct = dosing.filter((m) => !referencesOtherProduct(m, productTitle));
  if (otherProduct.length === 0) {
    return { status: 'skipped', reason: 'other_product_ratio' };
  }

  // A printed ceiling, or a dose "per gallon of <finish>", is not a use dilution in water.
  const usable = otherProduct.filter(
    (m) => !CEILING_PATTERNS.some((p) => p.test(m.context)) && !NON_WATER_PER_GALLON.test(m.context),
  );
  if (usable.length === 0) {
    return { status: 'skipped', reason: 'not_a_water_dilution', detail: otherProduct[0]?.raw };
  }

  if (usable.some((m) => m.kind === 'range')) {
    return { status: 'skipped', reason: 'multi_tier_range', detail: usable.find((m) => m.kind === 'range')?.raw };
  }

  const ozMentions = usable.filter((m) => m.kind === 'oz_per_gal');
  const ratioMentions = usable.filter((m) => m.kind === 'ratio');
  const metricMentions = usable.filter((m) => m.kind === 'metric');
  const perManyGalMentions = usable.filter((m) => m.kind === 'non_per_gallon');

  if (ozMentions.length === 0 && metricMentions.length > 0) {
    // Metric-only (Canadian) directions — skip, never convert. This holds EVEN when a `1:N` also
    // appears: on a metric label the ratio is claim-support (e.g. "1:64 dilution providing 600 ppm
    // of active quaternary" in an HIV-1 contact-time statement), not the printed use dose.
    return { status: 'skipped', reason: 'metric_only', detail: metricMentions[0]?.raw };
  }

  if (ozMentions.length === 0 && ratioMentions.length === 0) {
    if (perManyGalMentions.length > 0) {
      // "3 fl. oz. per 10 gallons" — dividing to a per-gallon figure would be a conversion.
      return { status: 'skipped', reason: 'non_per_gallon_dose', detail: perManyGalMentions[0]?.raw };
    }
    if (metricMentions.length > 0) {
      // Canadian metric-only label — skip, never convert.
      return { status: 'skipped', reason: 'metric_only', detail: metricMentions[0]?.raw };
    }
    return { status: 'skipped', reason: 'no_dilution_language' };
  }

  if (perManyGalMentions.length > 0) {
    // A per-gallon figure alongside a per-N-gallons figure is two different printed doses.
    return { status: 'skipped', reason: 'conflicting_use_modes', detail: perManyGalMentions[0]?.raw };
  }

  const modeCounts = countUseModeSegments(text);
  if (modeCounts && modeCounts.modes >= 2 && modeCounts.modesWithDilution === 1) {
    return {
      status: 'skipped',
      reason: 'single_mode_of_many',
      detail: `${modeCounts.modesWithDilution} of ${modeCounts.modes} use-modes print a dilution`,
    };
  }

  const distinctOz = Array.from(new Set(ozMentions.map((m) => m.value)));
  if (distinctOz.length > 1) {
    return {
      status: 'skipped',
      reason: 'conflicting_use_modes',
      detail: distinctOz.map((value) => String(value)).join(' vs '),
    };
  }

  if (distinctOz.length === 1) {
    const mention = ozMentions[0]!;
    // A single value that sits in explicit soil-tier language has no marked default.
    const distinctRatio = Array.from(new Set(ratioMentions.map((m) => m.value)));
    if (distinctRatio.length > 1) {
      return { status: 'skipped', reason: 'conflicting_use_modes', detail: distinctRatio.join(' vs ') };
    }
    // Printed oz/gal wins over a computed one, per the regulated-data rule.
    return { status: 'extracted', ozPerGal: mention.value, display: mention.raw.trim(), mention };
  }

  const distinctRatio = Array.from(new Set(ratioMentions.map((m) => m.value)));
  if (distinctRatio.length > 1) {
    return { status: 'skipped', reason: 'conflicting_use_modes', detail: distinctRatio.join(' vs ') };
  }
  const ratio = ratioMentions[0]!;
  if (!ratio.value || ratio.value <= 0) {
    return { status: 'skipped', reason: 'unreadable_value', detail: ratio.raw };
  }
  if (TIER_WORDS.test(ratio.context) && ratioMentions.length > 1) {
    return { status: 'skipped', reason: 'multi_tier_range', detail: ratio.raw };
  }
  // The one sanctioned derivation: 128 oz per US gallon / N.
  const ozPerGal = Math.round((128 / ratio.value) * 1000) / 1000;
  return { status: 'extracted', ozPerGal, display: ratio.raw.replace(/\s+/g, ''), mention: ratio };
}
