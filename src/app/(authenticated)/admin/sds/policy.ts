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

/**
 * B0-794 -- filename-suffix language markers.
 *
 * The folder-keyword list above still had a false-negative class: 364 Spanish, French
 * and Italian SDS filed inside ordinary `Betco SDS/Chemtrec SDS files ready to transfer/`,
 * `Betco SDS/Archive SDS/` and `Betco SDS/Specials/` folders, recorded as
 * `language_code = 'EN'`, chunked and live in the retrievable corpus. Nothing in their
 * folder path says "spanish" or "french"; the only path-level signal is a language
 * suffix on the filename stem (`609FR.pdf`, `065_FR.pdf`, `188 DRAW FR.pdf`,
 * `795SP (2).pdf`, `781SP Archive.pdf`, `GTS305EU_IT.pdf`).
 *
 * The token list is deliberately NOT the obvious one. Calibrated against all 3,159 real
 * `document_kind = 'sds'` filenames cross-checked against their detected body language:
 *
 *  - `ES` is EXCLUDED on purpose. It is not Spanish here, it is the private-label
 *    customer Essendant: all 14 `<code> ES.pdf` files live under
 *    `Private label SDS/Essendant Co ES1040 (Boardwalk)/` and every one of them is
 *    English by content. Adding `ES` would wrongly exclude legitimate English sheets.
 *  - `IT` is included but survives only because of the boundary rule below: nine real
 *    English filenames end in "Kit" (`F02857 FastPak kit`, `F091874 Water Hardness Test
 *    Kit`, ...). Requiring a digit/space/underscore/hyphen before the token -- never
 *    another letter -- rejects all nine and keeps the one genuine `GTS305EU_IT`.
 *
 * Measured on the live corpus: 0 false positives among the 1,526 retrievable SDS, and
 * 2 across all 3,159 (`696 BRI SP`, `470 BRI SP` -- English sheets mis-suffixed by the
 * supplier, both already out of scope under the `private label` keyword). It catches 360
 * of the 364; the 4 it misses (`SNF390 SP Wexford Only`, `248SP(RSFMAIZ)`,
 * `247 DIL (1_100)SP`) carry the token mid-name or before a parenthetical. Widening the
 * pattern to reach them re-introduces false positives, so they are deliberately left to
 * `evaluateSdsContentLanguage`, which remains the authoritative gate. This check is a
 * cheap pre-filter that stops the common shape re-entering, not a replacement for it.
 */
export const SDS_POLICY_DEFAULT_LANGUAGE_SUFFIXES = ['fr', 'sp', 'mx', 'it'];

export function getSdsPolicyLanguageSuffixes(): string[] {
  return parseListEnv(
    process.env.SDS_POLICY_LANGUAGE_SUFFIXES,
    SDS_POLICY_DEFAULT_LANGUAGE_SUFFIXES,
  );
}

/**
 * Trailing bookkeeping decorations that sit after the language suffix in real filenames:
 * "781SP Archive", "795SP (2)", "533FR - Copy".
 */
function stripFilenameDecorations(stem: string): string {
  let current = stem.trim();
  for (let i = 0; i < 5; i += 1) {
    const next = current
      .replace(/\s*\(\d+\)$/, '')
      .replace(/[\s_-]*archive$/, '')
      .replace(/[\s_-]*copy$/, '')
      .trim();
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** The lowercased filename stem of a path, with extension and trailing decorations removed. */
function normalizedFilenameStem(normalizedPath: string): string {
  const base = normalizedPath.split('/').pop() ?? '';
  return stripFilenameDecorations(base.replace(/\.[a-z0-9]+$/, ''));
}

/**
 * Returns the matched language suffix (e.g. 'fr') when the filename stem ends in one,
 * or null. The token must be preceded by a digit, space, underscore or hyphen -- never
 * by another letter -- which is what keeps "...Kit" from matching `it`.
 */
export function matchSdsFilenameLanguageSuffix(relativePath: string): string | null {
  const stem = normalizedFilenameStem(relativePath.toLowerCase());
  for (const suffix of getSdsPolicyLanguageSuffixes()) {
    if (new RegExp(`(?:^|[0-9 _-])${suffix}$`).test(stem)) return suffix;
  }
  return null;
}

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
      reason:
        | 'not_in_include_prefix'
        | 'exclude_keyword'
        | 'language_filename_suffix'
        | 'excluded_locale';
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

  // B0-794: a language suffix on the filename stem, for the FR/SP/MX/IT sheets that sit
  // in ordinary transfer/archive folders no keyword above can see.
  const matchedSuffix = matchSdsFilenameLanguageSuffix(normalized);
  if (matchedSuffix) {
    return { inScope: false, reason: 'language_filename_suffix', matched: matchedSuffix };
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
