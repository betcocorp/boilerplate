/**
 * Surface-form normalizers for entity recall.
 *
 * Entity recall compares a human-written ground-truth value (`EPA Reg. No. 1839-95`, `1:64`,
 * `10 minutes`) against raw chunk text pulled out of the corpus. Neither side is written in a
 * canonical form, and on a regulated corpus the difference between the two is usually formatting
 * rather than fact: a label prints `2 oz/gal`, the SDS prints `1:64`, and the answer is the same
 * dilution. String equality would score that as a miss and the metric would then be measuring
 * typography, not retrieval.
 *
 * So every kind in {@link EntityKind} gets a normalizer that returns two things:
 *
 * 1. a **canonical string**, safe to compare with `===`, and
 * 2. a **structured value** (`ozPerGallon`, `seconds`, the parsed registration parts) where the kind
 *    has one.
 *
 * The structured value is not decoration. A caller that reports `2 oz/gal` matched `1:64` has to be
 * able to show it matched *numerically* — otherwise a reviewer cannot tell a real equivalence from
 * a canonicalization accident, and the first time the normalizer is wrong nobody notices.
 *
 * Everything here is pure: no DB, no network, no clock, no randomness.
 *
 * ## Extraction vs normalization
 *
 * Normalizing a ground-truth value is not enough, because the other side is a whole chunk of prose.
 * {@link extractEntities} scans free text for every occurrence of a kind and normalizes each one,
 * so `1:64` (required) can be matched against a paragraph that only ever says `2 oz per gallon`.
 * {@link normalizedMatches} then decides equivalence per kind, numerically where that applies.
 */

import type { EntityKind } from './types';

/* -------------------------------------------------------------------------------------------- */
/* Tolerances and constants                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** Fluid ounces in a US gallon. Betco is a US-first corpus; imperial gallons are not assumed. */
export const US_FL_OZ_PER_GALLON = 128;

/**
 * Relative tolerance for comparing two dilutions expressed in oz/gal — 2%.
 *
 * Explicit, and not an epsilon, because the two sides are frequently derived by *different* people
 * doing *different* rounding. `1:100` is 1.28 oz/gal; labels routinely print that as `1.3 oz/gal`,
 * which is 1.6% away. A float epsilon would call that a miss and the metric would punish retrieval
 * for a printing convention.
 *
 * 2% is also comfortably below the gap between adjacent standard dilutions, which is what the
 * tolerance must not swallow: 1:64 (2.0) vs 1:60 (2.133) is 6.7% apart, 1:128 (1.0) vs 1:120 (1.067)
 * likewise 6.7%. So the tolerance absorbs rounding and cannot merge two real dilutions.
 *
 * Comparison is relative rather than absolute so it behaves the same at 0.5 oz/gal and at 32 oz/gal;
 * {@link DILUTION_ABSOLUTE_FLOOR} keeps it from collapsing to nothing near zero.
 */
export const DILUTION_RELATIVE_TOLERANCE = 0.02;

/** Absolute floor for the dilution tolerance, so very small oz/gal values still tolerate rounding. */
export const DILUTION_ABSOLUTE_FLOOR = 0.005;

/**
 * Contact time is compared **exactly** in seconds, with no tolerance.
 *
 * Contact time is a regulated claim: a disinfectant is registered at a stated dwell time and
 * "10 minutes" and "9 minutes" are different products' labels, not rounding of one another. Every
 * unit involved (seconds, minutes, hours) converts to seconds by an exact integer factor, so there
 * is no representation error to absorb either. A tolerance here would only ever create false
 * positives on the exact claim the eval exists to protect.
 */
export const CONTACT_TIME_EXACT = true;

/* -------------------------------------------------------------------------------------------- */
/* Result shapes                                                                                   */
/* -------------------------------------------------------------------------------------------- */

type NormalizedBase = {
  /** The input exactly as it was seen, for reporting which surface form matched. */
  raw: string;
  /** Comparable canonical form. Two values of the same kind with equal canonicals are equal. */
  canonical: string;
};

export type NormalizedEpaRegistration = NormalizedBase & {
  kind: 'epa_registration';
  /** Company number — the first segment. Null when the value did not parse as a registration. */
  company: string | null;
  /** Product number — the second segment. */
  product: string | null;
  /** Distributor sub-registration — the third segment, when present. */
  subRegistration: string | null;
  /** `company-product`, i.e. the registration this one is a sub-registration of (or itself). */
  parent: string | null;
};

export type NormalizedDin = NormalizedBase & {
  kind: 'din';
  /** The bare 8 digits, or null when the value did not parse as a DIN. */
  din: string | null;
};

export type NormalizedDilution = NormalizedBase & {
  kind: 'dilution';
  /** Canonical strength in US fluid ounces of concentrate per gallon of water, when derivable. */
  ozPerGallon: number | null;
  /** The ratio form, reduced, when the value was written as one. */
  ratio: { concentrate: number; water: number } | null;
};

export type NormalizedContactTime = NormalizedBase & {
  kind: 'contact_time';
  /** Canonical duration in seconds, when derivable. */
  seconds: number | null;
};

export type NormalizedLiteral = NormalizedBase & {
  kind: 'literal';
};

export type Normalized =
  | NormalizedEpaRegistration
  | NormalizedDin
  | NormalizedDilution
  | NormalizedContactTime
  | NormalizedLiteral;

/* -------------------------------------------------------------------------------------------- */
/* Literal                                                                                         */
/* -------------------------------------------------------------------------------------------- */

const CURLY_SINGLE = /[‘’‚‛′´`]/g;
const CURLY_DOUBLE = /[“”„‟″«»]/g;
const DASHES = /[‐‑‒–—―−⁃]/g;
const FRACTION_SLASH = /[⁄∕]/g;
// `\s` already covers NBSP, the en-quad..hair-space run, NNBSP, MMSP, ideographic space and BOM in
// JS; zero-width space is the one separator it misses, so it is added explicitly.
const WHITESPACE = /[\s\u200b]+/g;
const TRIM_PUNCTUATION = /^[.,;:!?"'()[\]{}]+|[.,;:!?"'()[\]{}]+$/g;

/**
 * Fold a string to a comparable literal form: NFKC, lowercase, curly quotes and every dash variant
 * folded to ASCII, all whitespace collapsed to single spaces, surrounding punctuation stripped.
 *
 * **No stemming, no lemmatization, no synonym expansion — deliberately.** The values this metric
 * checks are regulated claims (`kills norovirus`, `not for use on food contact surfaces`), and the
 * two error directions are not symmetric. A false negative under-credits retrieval and shows up as
 * a suspiciously low score that someone investigates. A false positive says the corpus contains a
 * claim it does not contain, and it looks exactly like a pass. Stemming buys a little recall and
 * pays for it by merging `disinfect`/`disinfectant`, `dilute`/`dilution` and, worse,
 * `use`/`uses`/`used` in claim text where the grammatical form carries the restriction. Whitespace,
 * case and typography are safe to fold because they cannot change a claim; word forms can.
 */
export const foldLiteral = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(CURLY_SINGLE, "'")
    .replace(CURLY_DOUBLE, '"')
    .replace(DASHES, '-')
    .replace(FRACTION_SLASH, '/')
    .replace(WHITESPACE, ' ')
    .trim()
    .replace(TRIM_PUNCTUATION, '')
    .trim();

export const normalizeLiteral = (value: string): NormalizedLiteral => ({
  kind: 'literal',
  raw: value,
  canonical: foldLiteral(value),
});

/* -------------------------------------------------------------------------------------------- */
/* EPA registration                                                                                */
/* -------------------------------------------------------------------------------------------- */

/** `1839-95`, `1839-95-10352`, optionally behind an `EPA Reg. No.`-style label. */
const EPA_PATTERN =
  /(?:epa\s*)?(?:reg(?:istration)?\.?\s*)?(?:n[o0]\.?|number|#)?\s*:?\s*\b(\d{2,7})-(\d{1,5})(?:-(\d{1,6}))?\b/gi;

/**
 * A full ISO date has the same shape as a three-segment registration, so an unlabelled
 * `2024-01-15` would otherwise parse as one. The guard is deliberately narrow — only the complete
 * `YYYY-MM-DD` form, and only when the match carried no `EPA`/`Reg` label — because the two-segment
 * form it would otherwise also swallow is exactly the common registration shape (`1839-95` is
 * itself `\d{4}-\d{2}`).
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HAS_LABEL = /[a-z]/i;

/**
 * Normalize an EPA registration number.
 *
 * **A sub-registration does not match its parent.** `1839-95-10352` is a distributor's product sold
 * under its own brand: same formulation as `1839-95`, but a different label, different directions
 * for use and, in practice, a different answer to "what is the contact time for this product".
 * Treating the sub as the parent would let retrieval satisfy a question about one product by
 * surfacing another product's document, which is the precise failure entity recall exists to catch.
 * The relationship is still visible — {@link NormalizedEpaRegistration.parent} carries
 * `company-product` — so a caller that genuinely wants family-level matching can opt in explicitly,
 * on the record, rather than getting it silently from the normalizer.
 *
 * Canonical form is the full hyphenated number with any label prefix and internal spacing removed.
 * A value that does not parse falls back to the literal fold, so it can still match by string.
 */
export const normalizeEpaRegistration = (value: string): NormalizedEpaRegistration => {
  const found = firstEpaMatch(value);
  if (!found) {
    return {
      kind: 'epa_registration',
      raw: value,
      canonical: foldLiteral(value),
      company: null,
      product: null,
      subRegistration: null,
      parent: null,
    };
  }
  return found;
};

const buildEpa = (
  raw: string,
  company: string,
  product: string,
  sub: string | undefined,
): NormalizedEpaRegistration => {
  const parent = `${stripLeadingZeros(company)}-${stripLeadingZeros(product)}`;
  const canonical = sub === undefined ? parent : `${parent}-${stripLeadingZeros(sub)}`;
  return {
    kind: 'epa_registration',
    raw,
    canonical,
    company: stripLeadingZeros(company),
    product: stripLeadingZeros(product),
    subRegistration: sub === undefined ? null : stripLeadingZeros(sub),
    parent,
  };
};

/** Registration segments are printed with and without padding; `095` and `95` are one product. */
const stripLeadingZeros = (segment: string): string => segment.replace(/^0+(?=\d)/, '');

const firstEpaMatch = (value: string): NormalizedEpaRegistration | null => {
  const all = extractEpaRegistrations(value);
  return all[0] ?? null;
};

export const extractEpaRegistrations = (text: string): NormalizedEpaRegistration[] => {
  const out: NormalizedEpaRegistration[] = [];
  const source = text.normalize('NFKC').replace(DASHES, '-');
  for (const match of source.matchAll(EPA_PATTERN)) {
    const whole = match[0].trim();
    const bare = `${match[1]}-${match[2]}${match[3] === undefined ? '' : `-${match[3]}`}`;
    if (!HAS_LABEL.test(whole) && ISO_DATE.test(bare)) continue;
    out.push(buildEpa(whole, match[1] as string, match[2] as string, match[3]));
  }
  return out;
};

/* -------------------------------------------------------------------------------------------- */
/* DIN                                                                                             */
/* -------------------------------------------------------------------------------------------- */

/** Health Canada Drug Identification Number: exactly 8 digits, with or without a `DIN` label. */
const DIN_PATTERN = /(?:\bdin\b\s*(?:n[o0]\.?|number|#)?\s*:?\s*)?(?<!\d)(\d{8})(?!\d)/gi;

/**
 * Normalize a Canadian DIN to its bare 8 digits.
 *
 * The `DIN` prefix, punctuation and spacing are dropped; the digits are the identity. Exactly eight
 * digits are required — a 7- or 9-digit run is not a DIN and is left to the literal fallback rather
 * than being padded or truncated into one.
 */
export const normalizeDin = (value: string): NormalizedDin => {
  const found = extractDins(value)[0];
  if (!found) {
    return { kind: 'din', raw: value, canonical: foldLiteral(value), din: null };
  }
  return found;
};

export const extractDins = (text: string): NormalizedDin[] => {
  const out: NormalizedDin[] = [];
  for (const match of text.normalize('NFKC').matchAll(DIN_PATTERN)) {
    const digits = match[1] as string;
    out.push({ kind: 'din', raw: match[0].trim(), canonical: digits, din: digits });
  }
  return out;
};

/* -------------------------------------------------------------------------------------------- */
/* Dilution                                                                                        */
/* -------------------------------------------------------------------------------------------- */

const RATIO_PATTERN = /(\d+(?:\.\d+)?)\s*(?::|\bto\b)\s*(\d+(?:\.\d+)?)/gi;

const OZ_PER_GALLON_PATTERN =
  /(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)\s*(?:fl\.?\s*)?(?:oz\b\.?|ounces?\b)\s*(?:\/|\bper\b|\bp\/)\s*(?:gal\b\.?|gallons?\b|gl\b)/gi;

/**
 * Normalize a dilution to US fluid ounces of concentrate per gallon of water where that is
 * derivable, and keep the ratio form where it is not.
 *
 * Ratios use the cleaning-industry convention the Betco labels are printed in: `1:64` means one part
 * concentrate to 64 parts water and is printed on the same label as `2 oz/gal`, i.e.
 * `128 / 64 = 2`. That is `US_FL_OZ_PER_GALLON * concentrate / water` — the concentrate volume is
 * not added to the gallon. Adopting the strict volumetric reading instead (128/65) would put every
 * conversion ~1.5% off the number actually printed on the product, which is the number a human
 * labeller will have written into the ground truth.
 *
 * A value containing both forms — `1:64 (2 oz/gal)`, the common label style — parses to the
 * oz/gal figure with the ratio retained alongside it, so both are reported.
 *
 * Values with no numeric reading at all (`per label directions`) fall back to the literal fold and
 * match by string only.
 */
export const normalizeDilution = (value: string): NormalizedDilution => {
  const parsed = extractDilutions(value);
  const withOz = parsed.find((entry) => entry.ozPerGallon !== null);
  const chosen = withOz ?? parsed[0];
  if (!chosen) {
    return {
      kind: 'dilution',
      raw: value,
      canonical: foldLiteral(value),
      ozPerGallon: null,
      ratio: null,
    };
  }
  // A single value may state both forms; merge so the report shows the ratio and the strength.
  const ratio = chosen.ratio ?? parsed.find((entry) => entry.ratio !== null)?.ratio ?? null;
  const ozPerGallon =
    chosen.ozPerGallon ?? parsed.find((entry) => entry.ozPerGallon !== null)?.ozPerGallon ?? null;
  return {
    kind: 'dilution',
    raw: value,
    canonical: dilutionCanonical(ozPerGallon, ratio, value),
    ozPerGallon,
    ratio,
  };
};

const dilutionCanonical = (
  ozPerGallon: number | null,
  ratio: NormalizedDilution['ratio'],
  raw: string,
): string => {
  if (ozPerGallon !== null) return `ozpg:${round(ozPerGallon, 4)}`;
  if (ratio) return `ratio:${round(ratio.concentrate, 4)}:${round(ratio.water, 4)}`;
  return foldLiteral(raw);
};

/** Parse `2`, `1/2` or the NFKC expansion of `½` into a number. */
const parseAmount = (token: string): number | null => {
  const cleaned = token.replace(WHITESPACE, '');
  if (cleaned.includes('/')) {
    const [numerator, denominator] = cleaned.split('/');
    const n = Number(numerator);
    const d = Number(denominator);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
    return n / d;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

export const extractDilutions = (text: string): NormalizedDilution[] => {
  const source = text.normalize('NFKC').replace(FRACTION_SLASH, '/').replace(DASHES, '-');
  const out: NormalizedDilution[] = [];

  for (const match of source.matchAll(OZ_PER_GALLON_PATTERN)) {
    const amount = parseAmount(match[1] as string);
    if (amount === null) continue;
    out.push({
      kind: 'dilution',
      raw: match[0].trim(),
      canonical: `ozpg:${round(amount, 4)}`,
      ozPerGallon: amount,
      ratio: null,
    });
  }

  for (const match of source.matchAll(RATIO_PATTERN)) {
    const concentrate = Number(match[1]);
    const water = Number(match[2]);
    if (!Number.isFinite(concentrate) || !Number.isFinite(water) || water === 0) continue;
    const ozPerGallon = (US_FL_OZ_PER_GALLON * concentrate) / water;
    out.push({
      kind: 'dilution',
      raw: match[0].trim(),
      canonical: `ozpg:${round(ozPerGallon, 4)}`,
      ozPerGallon,
      ratio: { concentrate, water },
    });
  }

  return out;
};

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** True when two oz/gal strengths agree within {@link DILUTION_RELATIVE_TOLERANCE}. */
export const dilutionsAgree = (a: number, b: number): boolean => {
  const tolerance = Math.max(
    DILUTION_ABSOLUTE_FLOOR,
    DILUTION_RELATIVE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b)),
  );
  return Math.abs(a - b) <= tolerance;
};

/* -------------------------------------------------------------------------------------------- */
/* Contact time                                                                                    */
/* -------------------------------------------------------------------------------------------- */

const UNIT_SECONDS: Record<string, number> = {
  second: 1,
  seconds: 1,
  sec: 1,
  secs: 1,
  minute: 60,
  minutes: 60,
  min: 60,
  mins: 60,
  hour: 3600,
  hours: 3600,
  hr: 3600,
  hrs: 3600,
};

const CONTACT_TIME_PATTERN =
  /(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/gi;

/**
 * Normalize a contact / dwell time to seconds.
 *
 * Single-letter unit abbreviations (`10 m`, `10 s`) are **not** accepted. In SDS and label text `m`
 * is metres far more often than minutes and `s` is almost never seconds, so accepting them buys a
 * handful of real matches and a stream of false ones on a claim where a false positive is the
 * expensive error. Comparison is exact — see {@link CONTACT_TIME_EXACT}.
 */
export const normalizeContactTime = (value: string): NormalizedContactTime => {
  const found = extractContactTimes(value)[0];
  if (!found) {
    return { kind: 'contact_time', raw: value, canonical: foldLiteral(value), seconds: null };
  }
  return found;
};

export const extractContactTimes = (text: string): NormalizedContactTime[] => {
  const out: NormalizedContactTime[] = [];
  for (const match of text.normalize('NFKC').matchAll(CONTACT_TIME_PATTERN)) {
    const amount = Number(match[1]);
    const factor = UNIT_SECONDS[(match[2] as string).toLowerCase()];
    if (!Number.isFinite(amount) || factor === undefined) continue;
    const seconds = amount * factor;
    out.push({
      kind: 'contact_time',
      raw: match[0].trim(),
      canonical: `s:${round(seconds, 3)}`,
      seconds,
    });
  }
  return out;
};

/* -------------------------------------------------------------------------------------------- */
/* Dispatch                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** Normalize one human-written surface form according to its {@link EntityKind}. */
export const normalizeFor = (kind: EntityKind, value: string): Normalized => {
  switch (kind) {
    case 'epa_registration':
      return normalizeEpaRegistration(value);
    case 'din':
      return normalizeDin(value);
    case 'dilution':
      return normalizeDilution(value);
    case 'contact_time':
      return normalizeContactTime(value);
    case 'literal':
      return normalizeLiteral(value);
  }
};

/**
 * Every occurrence of `kind` in free text, normalized.
 *
 * `literal` has no occurrences to enumerate — the whole text is folded and returned as one value, so
 * a caller can substring-search it. Every other kind returns zero or more parsed occurrences.
 */
export const extractEntities = (kind: EntityKind, text: string): Normalized[] => {
  switch (kind) {
    case 'epa_registration':
      return extractEpaRegistrations(text);
    case 'din':
      return extractDins(text);
    case 'dilution':
      return extractDilutions(text);
    case 'contact_time':
      return extractContactTimes(text);
    case 'literal':
      return [normalizeLiteral(text)];
  }
};

/**
 * Kind-aware equivalence between a required value and an occurrence found in text.
 *
 * Numeric kinds compare on their structured value so `2 oz/gal` matches `1:64` on the arithmetic
 * rather than on a canonical string collision; when either side failed to parse the comparison
 * degrades to canonical-string equality. `literal` is a containment test, because the "occurrence"
 * for a literal is the entire folded chunk.
 */
export const normalizedMatches = (required: Normalized, candidate: Normalized): boolean => {
  if (required.kind !== candidate.kind) return false;

  switch (required.kind) {
    case 'dilution': {
      const other = candidate as NormalizedDilution;
      if (required.ozPerGallon !== null && other.ozPerGallon !== null) {
        return dilutionsAgree(required.ozPerGallon, other.ozPerGallon);
      }
      return required.canonical === other.canonical;
    }
    case 'contact_time': {
      const other = candidate as NormalizedContactTime;
      if (required.seconds !== null && other.seconds !== null) {
        return required.seconds === other.seconds;
      }
      return required.canonical === other.canonical;
    }
    case 'literal': {
      const other = candidate as NormalizedLiteral;
      if (required.canonical.length === 0) return false;
      return other.canonical.includes(required.canonical);
    }
    default:
      // epa_registration and din are identity codes: exact canonical equality, and for EPA that
      // deliberately means a sub-registration does not satisfy its parent.
      return required.canonical === candidate.canonical;
  }
};

/**
 * Does any accepted surface form of an entity occur in this text?
 *
 * Returns the surface form that matched (the ground-truth string, not the text's rendering) so the
 * report can say which alternative hit, or null when none did.
 */
export const findMatchingValue = (
  kind: EntityKind,
  values: readonly string[],
  text: string,
): string | null => {
  const occurrences = extractEntities(kind, text);
  if (occurrences.length === 0) return null;
  for (const value of values) {
    const required = normalizeFor(kind, value);
    if (occurrences.some((occurrence) => normalizedMatches(required, occurrence))) return value;
  }
  return null;
};
