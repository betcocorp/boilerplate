/**
 * B0-979 — deterministic "closest catalog match" detection for a product-IDENTITY question whose
 * typed spelling differs from the retrieved title and no verified alias fired.
 *
 * "Do you have a product called Hard as Nailz?" retrieved the right label (`Hard As Nails`) but
 * the only disclosure mechanism (`maybeDiscloseAliasFuzzyMatch`) is conditioned on
 * `aliasResolution.outcome === 'alias_fuzzy'`, and `rag.product_alias` has no row for the name
 * (B0-878 reset) — so the outcome was `no_alias_match` and the answer opened "Yes, Betco offers a
 * product called Hard As Nails" as if the typed spelling had matched. These helpers let the
 * backstop compare the typed name against the top `search_product_docs` title instead.
 *
 * Everything here is name-only text handling: no regulated value is read, reformatted or inferred,
 * and the title is always handed back verbatim.
 */

/**
 * The product name the user typed in an identity-shaped question ("do you have / is there a
 * product called X", "does Betco make X?"), or null when the message is not identity-shaped. The
 * capture is returned as typed (quotes and trailing punctuation removed), never normalised.
 */
export function extractIdentityAskName(userMessage: string): string | null {
  const message = userMessage.trim();
  if (!message) return null;
  const identityShaped =
    /\b(?:do you (?:have|carry|sell|make|offer|still (?:have|carry|sell|make))|does betco (?:have|carry|sell|make|offer)|is there|are there|have you got|do you know of)\b/i.test(
      message,
    );
  if (!identityShaped) return null;

  const called = /\b(?:called|named|labell?ed|by the name of|branded)\s+["“'‘]?([^"”'’?.!]+?)["”'’]?\s*[?.!]*\s*$/i.exec(
    message,
  );
  const direct = called
    ? null
    : /\b(?:do you|does betco)\s+(?:have|carry|sell|make|offer|still (?:have|carry|sell|make))\s+(?:a\s+|an\s+|any\s+|the\s+)?["“'‘]?([^"”'’?.!]+?)["”'’]?\s*[?.!]*\s*$/i.exec(
        message,
      );
  const raw = (called?.[1] ?? direct?.[1] ?? '').trim();
  if (!raw || raw.length > 80) return null;
  // A direct object that is itself a generic noun ("a product", "anything for grout") is not a name.
  if (!called && /^(?:a |an |any |the )?(?:product|products|item|items|something|anything|one)\b/i.test(raw)) {
    return null;
  }
  return raw;
}

/** Lowercase, strip ®/™/© and their ASCII spellings, drop punctuation, collapse whitespace. */
export function normalizeProductIdentityName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[®™©]|\((?:r|tm|c)\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Classic Levenshtein distance on the two strings as given. */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The corpus transliterates ® as a trailing "r" and ™ as a trailing "T" on some titles
 * ("Hard As Nailsr", "DefenderT"). Strip that one trailing letter from a title token when doing so
 * makes it equal the typed token — never otherwise, so "stripper" is not shortened to "strippe".
 */
function stripTransliteratedMarks(titleTokens: string[], typedTokens: string[]): string[] {
  return titleTokens.map((token, index) => {
    const typed = typedTokens[index];
    if (!typed || token === typed) return token;
    if (/[rt]$/i.test(token) && token.slice(0, -1) === typed) return token.slice(0, -1);
    return token;
  });
}

export type IdentityTitleComparison = 'exact' | 'near' | 'different';

/** Max edit distance (after normalisation) for a title to count as the typed name's near-miss. */
export const IDENTITY_TITLE_MAX_DISTANCE = 2;

/**
 * How the typed product name relates to a retrieved title:
 *  - `exact`  — the title (or its leading tokens, when it carries a pack-size / product-type suffix
 *               such as "Hard As Nails Floor Finish (4 - 1 GAL Bottles)") IS the typed name once
 *               case, ®/™ and their "r"/"T" transliterations are ignored → nothing to disclose;
 *  - `near`   — within `IDENTITY_TITLE_MAX_DISTANCE` edits of it ("Hard as Nailz" → "Hard As Nails");
 *  - `different` — anything else (a different product, e.g. the line profile "Hard Film Floor Finish").
 */
export function compareIdentityNameToTitle(typedName: string, title: string): IdentityTitleComparison {
  const typed = normalizeProductIdentityName(typedName);
  const normalizedTitle = normalizeProductIdentityName(title);
  if (!typed || !normalizedTitle) return 'different';

  const typedTokens = typed.split(' ');
  const titleTokens = normalizedTitle.split(' ');
  const candidates = new Set<string>([normalizedTitle]);
  if (titleTokens.length > typedTokens.length) {
    candidates.add(titleTokens.slice(0, typedTokens.length).join(' '));
  }
  for (const candidate of [...candidates]) {
    candidates.add(stripTransliteratedMarks(candidate.split(' '), typedTokens).join(' '));
  }

  if (candidates.has(typed)) return 'exact';
  // Very short names have too little signal for an edit-distance verdict; treat as different.
  if (typed.length < 4) return 'different';
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    best = Math.min(best, levenshteinDistance(typed, candidate));
  }
  return best <= IDENTITY_TITLE_MAX_DISTANCE ? 'near' : 'different';
}
