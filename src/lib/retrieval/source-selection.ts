import type { RagSearchMatch } from '~/lib/rag/search';
import { normalizeForDedupe } from '~/lib/utils';

/**
 * B0-493 — exported so callers can report the applied floor rather than an absence. This value is
 * silently substituted whenever `selectCuratedMatches` is called with no `minSimilarity` override
 * (every call site in `product-knowledge.ts` today), so a retrieval-parameters record that omitted
 * it would misreport "no floor" instead of "the 0.2 default floor was applied".
 */
export const DEFAULT_MIN_SIMILARITY = 0.2;

export function trimSnippet(text: string, maxLen: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) {
    return t;
  }
  return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
}

function nearDuplicateKey(match: RagSearchMatch) {
  return [
    normalizeForDedupe(match.document_title || ''),
    String(match.chunk_index),
    normalizeForDedupe(match.chunk_text).slice(0, 220),
  ].join('|');
}

function kindEquals(match: RagSearchMatch, expectedKind: string) {
  return (
    typeof match.document_kind === 'string' &&
    match.document_kind.toLowerCase() === expectedKind.toLowerCase()
  );
}

/**
 * Ranks and trims RAG hits for model consumption. Transitional: dedicated approval flags
 * in corpus metadata should replace similarity-only filtering when available.
 */
export function selectCuratedMatches(
  matches: RagSearchMatch[],
  options: {
    limit: number;
    minSimilarity?: number;
    /**
     * If present, try to include at least one match for each kind when available
     * in the candidate set (for example: product profile + SDS coverage).
     */
    requiredDocumentKinds?: string[];
    /** Diversity limit so a single document cannot dominate the context. */
    maxPerDocument?: number;
    /**
     * B0-974 — `false` when the question is NOT product-anchored (no product named, no line
     * locked: the unfiltered broad pass). Then a `product_line_profile` required-kind slot is not
     * reserved when the best profile candidate ranks below the best `knowledge` candidate: on
     * "How often should a wood sport floor be recoated?" the reservation handed a slot to
     * "Oil-Based Wood Sport Finish" (raw rank 12) and displaced the rank-2 knowledge chunk holding
     * the only "annual recoats" sentence in the corpus. Default `true` keeps every existing caller's
     * reservation exactly as before; a profile that genuinely outranks the knowledge pool is still
     * reserved either way.
     */
    productAnchored?: boolean;
  },
): RagSearchMatch[] {
  const min = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const sorted = [...matches].sort((a, b) => b.similarity - a.similarity);
  const filtered = sorted.filter((m) => m.similarity >= min);
  const requiredKinds = options.requiredDocumentKinds ?? [];
  const maxPerDocument = options.maxPerDocument ?? Number.POSITIVE_INFINITY;
  const bestKnowledge =
    options.productAnchored === false
      ? filtered.find((match) => kindEquals(match, 'knowledge'))
      : undefined;

  const selected: RagSearchMatch[] = [];
  const selectedKeys = new Set<string>();
  const duplicateKeys = new Set<string>();
  const perDocumentCounts = new Map<string, number>();

  const trySelect = (candidate: RagSearchMatch) => {
    if (selected.length >= options.limit) {
      return;
    }
    const key = `${candidate.document_id}:${candidate.chunk_id}`;
    if (selectedKeys.has(key)) {
      return;
    }
    const dupKey = nearDuplicateKey(candidate);
    if (duplicateKeys.has(dupKey)) {
      return;
    }
    const currentDocCount = perDocumentCounts.get(candidate.document_id) ?? 0;
    if (currentDocCount >= maxPerDocument) {
      return;
    }
    selected.push(candidate);
    selectedKeys.add(key);
    duplicateKeys.add(dupKey);
    perDocumentCounts.set(candidate.document_id, currentDocCount + 1);
  };

  for (const kind of requiredKinds) {
    const candidate = filtered.find((match) => kindEquals(match, kind));
    if (!candidate) {
      continue;
    }
    // B0-974 — see `productAnchored`: an unanchored question's profile slot yields to a knowledge
    // chunk that similarity ranked above it. The profile still competes in the plain pass below.
    if (
      bestKnowledge &&
      kindEquals(candidate, 'product_line_profile') &&
      bestKnowledge.similarity > candidate.similarity
    ) {
      continue;
    }
    trySelect(candidate);
  }

  for (const candidate of filtered) {
    trySelect(candidate);
  }

  return selected;
}
