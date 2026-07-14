/**
 * B0-27 — Category resolver (Category-First Retrieval Layer).
 *
 * Maps a raw user query to one or more taxonomy nodes with a 0–1 confidence, using layered matching:
 * exact name → exact alias → normalized containment → fuzzy token overlap. Pure function over the
 * taxonomy passed in (no DB / LLM / vector stack), so it is fully unit-testable; the ingested
 * `product_category` table (B0-33) is fed in as `nodes` by the caller.
 *
 * The taxonomy is derivable today from `legacy.prod_line.MetaKeyWords` (e.g. "Floor Care-Finishes-
 * Resilient", "Warewash-Machine Products") + product↔line links, ahead of a betco.com scrape.
 */

export type TaxonomyNode = {
  key: string;
  name: string;
  aliases?: string[];
  parentKey?: string | null;
  /** Ancestor names (root→leaf), for display; not used in matching. */
  path?: string[];
};

export type CategoryMatchType = 'exact' | 'alias' | 'normalized' | 'fuzzy';

export type CategoryMatch = {
  node: TaxonomyNode;
  confidence: number;
  matchType: CategoryMatchType;
};

export type ResolveCategoryOptions = {
  /** Minimum confidence to include a candidate (default 0.34 — the fuzzy floor). */
  minConfidence?: number;
  /** Maximum candidates to return (default 5). */
  limit?: number;
};

const CONFIDENCE = {
  exact: 1,
  alias: 0.95,
  normalized: 0.8,
  fuzzyCap: 0.75,
} as const;

const DEFAULT_MIN_CONFIDENCE = 0.34;
const CONTAINMENT_MIN_LEN = 3;

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/#/g, ' number ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  const n = normalize(value);
  return n ? n.split(' ').filter(Boolean) : [];
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Best match for a single node across its name + aliases. */
function scoreNode(
  queryNorm: string,
  queryTokens: Set<string>,
  node: TaxonomyNode,
): { confidence: number; matchType: CategoryMatchType } {
  let best: { confidence: number; matchType: CategoryMatchType } = {
    confidence: 0,
    matchType: 'fuzzy',
  };
  const candidates: Array<{ text: string; isAlias: boolean }> = [
    { text: node.name, isAlias: false },
    ...(node.aliases ?? []).map((a) => ({ text: a, isAlias: true })),
  ];

  for (const cand of candidates) {
    const candNorm = normalize(cand.text);
    if (!candNorm) continue;

    // Exact
    if (candNorm === queryNorm) {
      return {
        confidence: cand.isAlias ? CONFIDENCE.alias : CONFIDENCE.exact,
        matchType: cand.isAlias ? 'alias' : 'exact',
      };
    }

    // Normalized containment (either direction), guarded against trivial short matches.
    const shorter = candNorm.length <= queryNorm.length ? candNorm : queryNorm;
    if (
      shorter.length >= CONTAINMENT_MIN_LEN &&
      (queryNorm.includes(candNorm) || candNorm.includes(queryNorm))
    ) {
      if (CONFIDENCE.normalized > best.confidence) {
        best = { confidence: CONFIDENCE.normalized, matchType: 'normalized' };
      }
      continue;
    }

    // Fuzzy token overlap
    const score = Math.min(
      jaccard(queryTokens, new Set(tokenize(cand.text))),
      CONFIDENCE.fuzzyCap,
    );
    if (score > best.confidence) {
      best = { confidence: score, matchType: 'fuzzy' };
    }
  }
  return best;
}

/**
 * Resolve a query to ranked taxonomy-node candidates. Returns [] when nothing clears the floor
 * (junk query); returns multiple when the query is ambiguous across categories.
 */
export function resolveCategory(
  query: string,
  nodes: TaxonomyNode[],
  opts: ResolveCategoryOptions = {},
): CategoryMatch[] {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const limit = opts.limit ?? 5;
  const queryNorm = normalize(query);
  if (!queryNorm) return [];
  const queryTokens = new Set(tokenize(query));

  const matches: CategoryMatch[] = [];
  for (const node of nodes) {
    const { confidence, matchType } = scoreNode(queryNorm, queryTokens, node);
    if (confidence >= minConfidence) {
      matches.push({ node, confidence: Math.round(confidence * 100) / 100, matchType });
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence || a.node.name.localeCompare(b.node.name));
  return matches.slice(0, limit);
}
