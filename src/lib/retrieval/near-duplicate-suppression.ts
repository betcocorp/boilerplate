import type { RagSearchMatch } from '~/lib/rag/search';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-257 (scope addition, 2026-07-20 design review): "Near-duplicate suppression
 * across sources... when product/SDS/label chunks exceed a cosine-similarity
 * threshold for the same product_id + section_type, keep the highest
 * authority_rank. Ensures overlapping ingredients/hazards/first-aid content
 * surfaces once, from SDS."
 *
 * This is a retrieval-time backstop, applied to the full eligible candidate set
 * *before* selectCuratedMatches' top-N/diversity pass (source-selection.ts) --
 * that existing pass already does exact-ish text dedup (nearDuplicateKey) but
 * has no concept of authority: it keeps whichever candidate has the highest
 * similarity to the query, even if that's a lower-authority marketing/product
 * description chunk saying nearly the same thing as an SDS chunk. This backstop
 * groups candidates by (product, section_type), finds near-duplicates via real
 * embedding cosine similarity (rag.compute_chunk_pairwise_similarity), and keeps
 * only the highest-authority survivor per near-duplicate cluster.
 */

/** SDS is the source of record for hazards/first-aid/ingredients; label is next; everything else is lower authority. */
const DOCUMENT_KIND_AUTHORITY_RANK: Record<string, number> = {
  sds: 3,
  label: 2,
};
const DEFAULT_AUTHORITY_RANK = 1;

function authorityRankFor(match: RagSearchMatch): number {
  const kind = match.document_kind?.toLowerCase() ?? '';
  return DOCUMENT_KIND_AUTHORITY_RANK[kind] ?? DEFAULT_AUTHORITY_RANK;
}

function getNearDuplicateSimilarityThreshold(): number {
  const raw = process.env.BEX_NEAR_DUPLICATE_SIMILARITY_THRESHOLD;
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.92;
}

/** Groups by (product identifier, section_type). Matches with no resolvable product identifier are never grouped/suppressed. */
function groupKeyFor(match: RagSearchMatch): string | null {
  const productId = match.product_key ?? match.product_line_key ?? match.entity_id;
  if (!productId) return null;
  const sectionType = match.section_type ?? '__no_section__';
  return `${productId}::${sectionType}`;
}

type PairwiseSimilarityRow = {
  chunk_id_a: string;
  chunk_id_b: string;
  cosine_similarity: number;
};

// rag.compute_chunk_pairwise_similarity is not yet in the generated Supabase RPC
// types (regenerate via `pnpm run types:supabase:rag` once CLI-authenticated);
// cast the client narrowly for this one call, same pattern used in rag/search.ts
// for other RPCs added ahead of a codegen refresh.
type PairwiseSimilarityRpcClient = {
  rpc: (
    fn: 'compute_chunk_pairwise_similarity',
    args: { p_chunk_ids: string[] },
  ) => Promise<{ data: PairwiseSimilarityRow[] | null; error: { message: string } | null }>;
};

async function fetchPairwiseSimilarity(
  chunkIds: string[],
): Promise<Map<string, number>> {
  if (chunkIds.length < 2) return new Map();

  const rag = getSupabaseServiceRoleClient().schema('rag');
  const { data, error } = await (rag as unknown as PairwiseSimilarityRpcClient).rpc(
    'compute_chunk_pairwise_similarity',
    { p_chunk_ids: chunkIds },
  );

  if (error || !data) {
    // Degrade to "no suppression" rather than block retrieval on an RPC failure.
    return new Map();
  }

  const bySortedPair = new Map<string, number>();
  for (const row of data) {
    bySortedPair.set(`${row.chunk_id_a}:${row.chunk_id_b}`, row.cosine_similarity);
  }
  return bySortedPair;
}

function pairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

/**
 * Suppresses lower-authority near-duplicate chunks within each (product,
 * section_type) group, using real embedding cosine similarity. Returns the
 * surviving matches in their original relative order. Degrades to a no-op
 * (returns all matches unchanged) if the similarity RPC is unavailable.
 */
export async function suppressNearDuplicateMatches(
  matches: RagSearchMatch[],
): Promise<RagSearchMatch[]> {
  if (matches.length < 2) return matches;

  const groups = new Map<string, RagSearchMatch[]>();
  for (const match of matches) {
    const key = groupKeyFor(match);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(match);
    groups.set(key, list);
  }

  const candidateGroups = [...groups.values()].filter((group) => group.length > 1);
  if (candidateGroups.length === 0) return matches;

  const allCandidateChunkIds = candidateGroups.flatMap((group) => group.map((m) => m.chunk_id));
  const similarityByPair = await fetchPairwiseSimilarity(allCandidateChunkIds);
  if (similarityByPair.size === 0) return matches;

  const threshold = getNearDuplicateSimilarityThreshold();
  const suppressedChunkIds = new Set<string>();

  for (const group of candidateGroups) {
    // Highest authority first; within equal authority, prefer the chunk more
    // relevant to the query (its own similarity-to-query score).
    const ranked = [...group].sort((a, b) => {
      const rankDiff = authorityRankFor(b) - authorityRankFor(a);
      return rankDiff !== 0 ? rankDiff : b.similarity - a.similarity;
    });

    const kept: RagSearchMatch[] = [];
    for (const candidate of ranked) {
      const isNearDuplicateOfKept = kept.some((keptMatch) => {
        const sim = similarityByPair.get(pairKey(candidate.chunk_id, keptMatch.chunk_id));
        return sim != null && sim >= threshold;
      });
      if (isNearDuplicateOfKept) {
        suppressedChunkIds.add(candidate.chunk_id);
      } else {
        kept.push(candidate);
      }
    }
  }

  if (suppressedChunkIds.size === 0) return matches;
  return matches.filter((match) => !suppressedChunkIds.has(match.chunk_id));
}
