import type { RagSearchMatch } from '~/lib/rag/search';

const DEFAULT_MIN_SIMILARITY = 0.2;

export function trimSnippet(text: string, maxLen: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) {
    return t;
  }
  return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * Ranks and trims RAG hits for model consumption. Transitional: dedicated approval flags
 * in corpus metadata should replace similarity-only filtering when available.
 */
export function selectCuratedMatches(
  matches: RagSearchMatch[],
  options: { limit: number; minSimilarity?: number },
): RagSearchMatch[] {
  const min = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const sorted = [...matches].sort((a, b) => b.similarity - a.similarity);
  return sorted.filter((m) => m.similarity >= min).slice(0, options.limit);
}
