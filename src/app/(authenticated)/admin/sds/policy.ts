import { franc } from 'franc-min';

/**
 * B0-243 — SDS corpus scope policy.
 *
 * Confirmed live (2026-07-24, `rag.document` where `document_kind = 'sds'`, 2,958 rows):
 * this prefix+keyword+locale policy reproduces the ticket's own filename-based split
 * (1,177 in-scope / 1,781 out-of-scope vs. the ticket's 1,179 / 1,779 -- the small
 * delta is expected drift since the ticket's count predates this exact implementation).
 *
 * Critically, cross-checking the 1,177 "in-scope" set against their *actual* extracted
 * PDF text (via `franc`, not just the recorded `language_code`) found 15 documents
 * tagged EN whose real content is French or Spanish -- filed under folder names the
 * old suffix-only heuristic (`-fr.pdf` / `(es).pdf`) never matches, e.g.
 * "Betco SDS/Diluted Product SDS/Diluted Spanish SDS/138 DILSP.pdf" and
 * "Betco SDS/Betco French Canadian SDS/Archive/632 FR Archive.pdf". This is exactly
 * the false-negative risk the ticket warns about ("the 1,779 figure comes from a
 * filename regex") -- so the filename/folder policy below is a fast pre-filter only;
 * `evaluateSdsContentLanguage` (content-based, run against real extracted text) is the
 * authoritative gate for anything that will actually be purged or newly ingested.
 */

export const SDS_POLICY_DEFAULT_INCLUDE_PREFIXES = ['betco sds/'];

/**
 * Folder/name keywords that take a document out of policy scope regardless of the
 * `Betco SDS/` prefix match. The first group mirrors the ticket's named exclusion
 * categories (Raw Materials, Private label, Intermediate/premix, Basic, Prop 65,
 * EnviroZyme, 1950, Battery, Wastewater, Experimental); the second group
 * ("spanish", "french canadian", "mexican form sds") was added after the live
 * content-check above found real ES/FR content living in folders the plain
 * `-fr.pdf` / `-es.pdf` suffix check misses entirely.
 */
export const SDS_POLICY_DEFAULT_EXCLUDE_KEYWORDS = [
  'raw material',
  'private label',
  'intermediate',
  'premix',
  'basic sds',
  'prop 65',
  'envirozyme',
  '1950 sds',
  'battery',
  'wastewater',
  'experimental',
  'spanish',
  'french canadian',
  'mexican form sds',
];

export const SDS_POLICY_DEFAULT_ALLOWED_LOCALES = ['EN', 'CAN'];

function parseListEnv(value: string | undefined, fallback: string[]): string[] {
  if (!value?.trim()) return fallback;
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function getSdsPolicyIncludePrefixes(): string[] {
  return parseListEnv(process.env.SDS_POLICY_INCLUDE_PREFIXES, SDS_POLICY_DEFAULT_INCLUDE_PREFIXES);
}

export function getSdsPolicyExcludeKeywords(): string[] {
  return parseListEnv(process.env.SDS_POLICY_EXCLUDE_KEYWORDS, SDS_POLICY_DEFAULT_EXCLUDE_KEYWORDS);
}

export function getSdsPolicyAllowedLocales(): string[] {
  return parseListEnv(
    process.env.SDS_POLICY_ALLOWED_LOCALES,
    SDS_POLICY_DEFAULT_ALLOWED_LOCALES,
  ).map((entry) => entry.toUpperCase());
}

export type SdsPolicyDecision =
  | { inScope: true }
  | {
      inScope: false;
      reason: 'not_in_include_prefix' | 'exclude_keyword' | 'excluded_locale';
      matched: string;
    };

/** Fast, filename/folder-path pre-filter. Not authoritative for FR/ES exclusion -- see module docs. */
export function evaluateSdsPolicy(relativePath: string, locale: string): SdsPolicyDecision {
  const normalized = relativePath.toLowerCase();

  const includePrefixes = getSdsPolicyIncludePrefixes();
  if (!includePrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return { inScope: false, reason: 'not_in_include_prefix', matched: normalized };
  }

  const excludeKeywords = getSdsPolicyExcludeKeywords();
  const matchedKeyword = excludeKeywords.find((keyword) => normalized.includes(keyword));
  if (matchedKeyword) {
    return { inScope: false, reason: 'exclude_keyword', matched: matchedKeyword };
  }

  const allowedLocales = getSdsPolicyAllowedLocales();
  const normalizedLocale = locale.toUpperCase();
  if (!allowedLocales.includes(normalizedLocale)) {
    return { inScope: false, reason: 'excluded_locale', matched: normalizedLocale };
  }

  return { inScope: true };
}

const FRANC_TO_SDS_LOCALE: Record<string, string> = {
  eng: 'EN',
  fra: 'FR',
  spa: 'ES',
};

export type SdsContentLanguageCheck = {
  /** Our EN/FR/ES scheme, or null when franc couldn't confidently detect a language. */
  detectedLocale: string | null;
  /** Raw franc ISO 639-3 code (e.g. 'eng', 'fra', 'spa', 'und'), kept for observability. */
  francCode: string;
  /**
   * True only for the dangerous direction: content is confidently FR or ES while the
   * expected (filename-derived) locale is EN/CAN. A CAN-expected doc whose content
   * detects as EN is NOT a mismatch (Canadian-English SDS commonly have no French
   * counterpart filed under the same key). `und` (inconclusive -- short/garbled OCR
   * text) is never treated as a mismatch: per org policy, unreadable/inconclusive
   * data must be surfaced, never guessed into a false positive.
   */
  mismatch: boolean;
};

/**
 * Content-based language check against real extracted PDF text -- the "beyond the
 * filename heuristic" validation the ticket requires before any purge decision.
 * Requires the document's already-extracted body text (from ingestion or from a
 * prior parse stored in `rag.document.body_text`), not just its file path.
 */
export function evaluateSdsContentLanguage(
  bodyText: string,
  expectedLocale: string,
): SdsContentLanguageCheck {
  const francCode = franc(bodyText, { minLength: 20 });
  if (francCode === 'und') {
    return { detectedLocale: null, francCode, mismatch: false };
  }

  const detectedLocale = FRANC_TO_SDS_LOCALE[francCode] ?? null;
  const expected = expectedLocale.toUpperCase();
  const mismatch =
    (detectedLocale === 'FR' || detectedLocale === 'ES') && detectedLocale !== expected;

  return { detectedLocale, francCode, mismatch };
}
