/**
 * B0-1032 — substrate (floor surface) ranking preference for `knowledge`-corpus retrieval.
 *
 * WHY THIS EXISTS: `get_floor_asset` asked for `surfaceType: "VCT"` and got back the substrate-
 * agnostic "floor maintenance frequency guide" (185 tokens) instead of "vct floor maintenance
 * frequency betco standard" (1,085 tokens), whose body is literally "How Often Should VCT Floors Be
 * Cleaned, Top Scrubbed, or Stripped?". Both live in the same `v1-markdown-files/vct/` ingest folder,
 * so `deriveKnowledgeCategoryFromS3Key` / `resolveKnowledgeCategoryExclusions` (B0-780) cannot tell
 * them apart, and the short generic chunk wins on embedding similarity against the denser specific
 * document.
 *
 * WHAT SIGNAL THIS USES AND WHY: the obvious substrate tag does not exist. Verified live
 * (2026-09-17): `rag.document` has no `surface_type` / `knowledge_category` column, and NOT ONE of
 * the 1,608 `knowledge` chunks carries `metadata.surface_type` — so the RPC-side
 * `rag.chunk_metadata_boost(...)` surface lever (B0-686, `filter_surface_type`) has nothing to fire
 * on (and `RAG_BOOST_ENABLED` is `false`, zeroing its weights anyway). The only per-document
 * substrate signal that actually exists is the DOCUMENT TITLE, which mirrors the ingested filename
 * (`vct-floor-maintenance-frequency-betco-standard.md`); 25 of the 38 `vct`-folder documents name
 * their substrate in the title.
 *
 * WHY SUBSTRATE ALONE IS NOT ENOUGH: measured on the live corpus, a title-mentions-VCT preference
 * alone still ranks the wanted document 9th (several higher-similarity VCT documents about coverage,
 * solids and green certification sit in front of it). The preference therefore scores substrate AND
 * the caller's own procedure/topic wording, which is what separates "vct floor maintenance FREQUENCY
 * betco standard" from "VCT Green Certified".
 *
 * ORDER-ONLY, like every other boost in this module (B0-686): this reorders candidates and NEVER
 * touches `similarity`. A document that matches nothing keeps its place relative to its peers, and a
 * preference no candidate matches is an exact no-op — this is a ranking preference, never a filter,
 * so it can never turn a weak answer into a decline.
 */

/**
 * Substrate families whose members should be treated as the same surface. Matching is by phrase, so
 * a caller's "vinyl composition tile" and a document titled "VCT ..." resolve to the same family.
 * Deliberately conservative: generic words ("tile", "floor") are NOT family members — "tile" alone
 * would make a ceramic-tile question match every vinyl-composition-tile document.
 */
const SURFACE_ALIAS_FAMILIES: readonly (readonly string[])[] = [
  // `vat` (vinyl ASBESTOS tile) is deliberately NOT a member: it is a different substrate with its
  // own handling rules, and the corpus has documents about telling the two apart.
  ['vct', 'vinyl composition tile', 'vinyl composition', 'vinyl tile', 'resilient tile'],
  ['wood', 'hardwood', 'maple', 'gym', 'gymnasium', 'sport', 'sports', 'sportszone'],
  ['concrete', 'cement', 'cementitious', 'polished concrete'],
  ['terrazzo'],
  ['stone', 'marble', 'granite', 'slate'],
  ['grout', 'ceramic', 'porcelain', 'quarry'],
  ['carpet'],
  ['rubber'],
  ['linoleum'],
];

/**
 * Words that carry no substrate information. Dropped from the surface term set so a `surfaceType`
 * like "sealed concrete floor" resolves to `concrete`, not to every document with "floor" in its
 * title.
 */
const SURFACE_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'floor',
  'floors',
  'flooring',
  'surface',
  'surfaces',
  'tile',
  'tiles',
  'sealed',
  'unsealed',
  'finished',
  'unfinished',
  'type',
  'care',
  'new',
  'old',
]);

/**
 * Words too common in this corpus to distinguish one procedure document from another. A topic term
 * that survives this list is something like `frequency`, `stripping`, `scrub`, `recoat`, `burnish`.
 */
const TOPIC_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'how',
  'often',
  'should',
  'what',
  'when',
  'are',
  'from',
  'out',
  'into',
  'per',
  'floor',
  'floors',
  'flooring',
  'care',
  'guide',
  'betco',
  'product',
  'products',
  'surface',
  'surfaces',
]);

/** Minimum token length kept as a matchable term. */
const MIN_TERM_LENGTH = 3;

/** Minimum term length allowed to match on a word-start prefix ("scrub" -> "scrubbing"). */
const MIN_PREFIX_MATCH_LENGTH = 4;

export type SubstrateRankingInput = {
  /** The caller's requested surface, e.g. `"VCT"`, `"wood gym floor"`, `"sealed concrete"`. */
  surfaceType?: string | null;
  /** The caller's procedure / topic wording, e.g. `"top scrub and stripping frequency"`. */
  topic?: string | null;
};

export type ResolvedSubstratePreference = {
  /** The caller's raw `surfaceType`, echoed for the retrieval trace. */
  surfaceType: string;
  /** Normalized surface phrases, family-expanded. */
  surfaceTerms: string[];
  /** Normalized topic tokens, stopword-filtered. */
  topicTerms: string[];
};

/** Lowercases, strips punctuation, and space-pads so word/phrase matches can be exact. */
function normalizeForMatch(value: string): string {
  const collapsed = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed ? ` ${collapsed} ` : '';
}

function toTerms(value: string, stopwords: Set<string>): string[] {
  const normalized = normalizeForMatch(value).trim();
  if (!normalized) return [];
  const seen = new Set<string>();
  for (const token of normalized.split(' ')) {
    if (token.length < MIN_TERM_LENGTH || stopwords.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

/** True when `haystack` (already normalized + space-padded) contains `term` as a whole word/phrase. */
function containsTerm(haystack: string, term: string): boolean {
  if (!haystack || !term) return false;
  if (haystack.includes(` ${term} `)) return true;
  // Word-start prefix so "scrub" matches "scrubbing" and "strip" matches "stripping". Kept off
  // short tokens, where a prefix match is mostly coincidence ("vat" would hit "vatted").
  return term.length >= MIN_PREFIX_MATCH_LENGTH && haystack.includes(` ${term}`);
}

/**
 * Resolves the caller's surface/topic wording into matchable terms, or `null` when no usable
 * substrate signal was supplied (no `surfaceType`, or one made entirely of generic words). A `null`
 * preference means the ranking step is skipped entirely.
 */
export function resolveSubstratePreference(
  input: SubstrateRankingInput | null | undefined,
): ResolvedSubstratePreference | null {
  const surfaceType = input?.surfaceType?.trim() ?? '';
  if (!surfaceType) return null;

  const normalizedSurface = normalizeForMatch(surfaceType);
  const surfaceTerms = new Set(toTerms(surfaceType, SURFACE_STOPWORDS));

  for (const family of SURFACE_ALIAS_FAMILIES) {
    const hit = family.some((alias) => containsTerm(normalizedSurface, alias));
    if (!hit) continue;
    for (const alias of family) surfaceTerms.add(alias);
  }

  if (surfaceTerms.size === 0) return null;

  return {
    surfaceType,
    surfaceTerms: [...surfaceTerms],
    topicTerms: toTerms(input?.topic ?? '', TOPIC_STOPWORDS),
  };
}

/**
 * Preference score for one document title. `0` means "no substrate match" — the document keeps its
 * incoming position relative to its peers. A title that names the substrate scores `1`, plus one for
 * each distinct topic term it also names, so a substrate-specific document about the asked-for
 * procedure outranks a substrate-specific document about something else.
 *
 * A title matching the topic but NOT the substrate scores `0` on purpose: that is exactly the
 * generic document this ticket exists to stop winning.
 */
export function scoreSubstrateRelevance(
  documentTitle: string,
  preference: ResolvedSubstratePreference,
): number {
  const title = normalizeForMatch(documentTitle);
  if (!title) return 0;

  const surfaceMatched = preference.surfaceTerms.some((term) => containsTerm(title, term));
  if (!surfaceMatched) return 0;

  const topicMatches = preference.topicTerms.filter((term) => containsTerm(title, term)).length;
  return 1 + topicMatches;
}

/**
 * Reorders candidates so substrate-specific documents come first, highest preference score first.
 * ORDER-ONLY: the returned objects are the same references, untouched — no score, similarity or body
 * is rewritten — and ties keep the caller's incoming order (so the underlying similarity/rerank
 * ranking still decides everything the preference does not).
 */
export function rankBySubstratePreference<T extends { document_title: string }>(
  matches: T[],
  preference: ResolvedSubstratePreference | null,
): { ranked: T[]; boostedCount: number } {
  if (!preference || matches.length === 0) {
    return { ranked: matches, boostedCount: 0 };
  }

  const scored = matches.map((match, index) => ({
    match,
    index,
    score: scoreSubstrateRelevance(match.document_title, preference),
  }));

  const boostedCount = scored.filter((entry) => entry.score > 0).length;
  if (boostedCount === 0) {
    return { ranked: matches, boostedCount: 0 };
  }

  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return { ranked: scored.map((entry) => entry.match), boostedCount };
}
