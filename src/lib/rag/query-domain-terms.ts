import { NAMED_SURFACE_TERMS } from '~/lib/orchestrator/surface-vocabulary';

/**
 * B0-975 — the discriminating "domain terms" of a retrieval query: the surface/material it names,
 * the floor type, the product form, any SKU/code-like token, and any acronym the user typed in
 * capitals. Two queries whose domain-term sets differ must NOT share a cached query embedding, no
 * matter how similar they are as strings: `find_similar_search_embedding` matched "how soon can
 * people walk on the VCT floor after the last coat?" to the cached "…walk on the floor after the
 * last coat?" at trigram 0.9286 (above `APPROX_QUERY_THRESHOLD_LONG = 0.9`) and silently dropped
 * "VCT" — the one token that decides which corpus category answers the question.
 *
 * Deliberately a closed, hand-maintained list: surfaces come from `NAMED_SURFACE_TERMS` (the
 * single source of truth the classifier and the early-decline gate already share), the rest are the
 * floor-care / product-form nouns the corpus is organised around. Product NAMES are not enumerated
 * here (9,000+ rows, and this runs synchronously on the search path); they are covered by the
 * code-like-token and acronym rules, and by the fact that a product name substitution rarely stays
 * above 0.9 trigram similarity anyway.
 */
const RETRIEVAL_DOMAIN_TERMS = [
  'wood',
  'gym',
  'sport',
  'sports',
  'court',
  'maple',
  'hardwood',
  'vinyl',
  'sealer',
  'finish',
  'stripper',
  'cleaner',
  'degreaser',
  'disinfectant',
  'sanitizer',
  'deodorizer',
  'sds',
  'label',
  'rtu',
  'concentrate',
  'restroom',
  'bathroom',
  'kitchen',
  'toilet',
  'urinal',
  'glass',
  'epa',
  'din',
] as const;

/**
 * Multi-word forms the LLM query rewrite expands acronyms into (`rewriteQueryWithLlm`,
 * `~/lib/rag/search.ts`). Folded back to the acronym so a rewritten cache row and a raw query can
 * still be compared on the same term set.
 */
const CANONICAL_TERM_FORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bvinyl composition tiles?\b/g, 'vct'],
  [/\bluxury vinyl tiles?\b/g, 'lvt'],
  [/\bready[- ]to[- ]use\b/g, 'rtu'],
  [/\bsafety data sheets?\b/g, 'sds'],
];

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DOMAIN_TERM_PATTERN = new RegExp(
  `\\b(?:${[...NAMED_SURFACE_TERMS, ...RETRIEVAL_DOMAIN_TERMS]
    .map(escapeRegExp)
    // Longest alternatives first so "vinyl composition tile" wins over "tile".
    .sort((a, b) => b.length - a.length)
    .join('|')})s?\\b`,
  'gi',
);

/** SKU / product-code / percentage-like tokens: anything with a digit in it. */
const CODE_LIKE_TOKEN_PATTERN = /\b[a-z0-9][a-z0-9-]*\d[a-z0-9-]*\b/gi;

/** Acronyms the user typed in capitals (VCT, RTU, SDS, GHS, LVT, PPE…). */
const ACRONYM_PATTERN = /\b[A-Z]{2,6}\b/g;
/** Generic metadata acronyms that are not discriminating retrieval-domain terms. */
const NON_DOMAIN_ACRONYMS = new Set(['sku']);

/**
 * Singular-ish, lowercased form of a matched term so "tiles"/"tile" and "VCT"/"vct" compare equal.
 * Only strips a trailing plural `s` when the term without it is itself a known term.
 */
function normalizeTerm(raw: string, known: ReadonlySet<string>): string {
  const lower = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (lower.endsWith('s') && known.has(lower.slice(0, -1))) {
    return lower.slice(0, -1);
  }
  return lower;
}

const KNOWN_TERMS: ReadonlySet<string> = new Set<string>([
  ...NAMED_SURFACE_TERMS,
  ...RETRIEVAL_DOMAIN_TERMS,
]);

/** The domain-term set of `query` (see the module doc). Exported for tests and diagnostics. */
export function extractQueryDomainTerms(query: string): Set<string> {
  const terms = new Set<string>();
  // Acronyms are read off the ORIGINAL casing before anything is lowercased.
  for (const acronym of query.match(ACRONYM_PATTERN) ?? []) {
    const normalized = acronym.toLowerCase();
    if (!NON_DOMAIN_ACRONYMS.has(normalized)) {
      terms.add(normalized);
    }
  }
  let canonical = query.toLowerCase();
  for (const [pattern, replacement] of CANONICAL_TERM_FORMS) {
    canonical = canonical.replace(pattern, replacement);
  }
  for (const match of canonical.match(DOMAIN_TERM_PATTERN) ?? []) {
    terms.add(normalizeTerm(match, KNOWN_TERMS));
  }
  for (const token of canonical.match(CODE_LIKE_TOKEN_PATTERN) ?? []) {
    terms.add(token.toLowerCase());
  }
  return terms;
}

/**
 * True when both queries name exactly the same domain terms — the precondition for reusing one's
 * cached embedding for the other. Two queries with NO domain terms at all are trivially identical
 * here (the trigram threshold alone decides them, exactly as before B0-975).
 */
export function haveIdenticalDomainTerms(a: string, b: string): boolean {
  const termsA = extractQueryDomainTerms(a);
  const termsB = extractQueryDomainTerms(b);
  if (termsA.size !== termsB.size) {
    return false;
  }
  for (const term of termsA) {
    if (!termsB.has(term)) {
      return false;
    }
  }
  return true;
}
