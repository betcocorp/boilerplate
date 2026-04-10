import { searchProductChunks, type RagSearchMatch } from '~/lib/rag/search';

import {
  selectCuratedMatches,
  trimSnippet,
} from '~/lib/retrieval/source-selection';

export type CuratedSource = {
  documentId: string;
  chunkId: string;
  title: string;
  snippet: string;
  similarity: number;
  productKey: string | null;
};

function toCurated(m: RagSearchMatch): CuratedSource {
  return {
    documentId: m.document_id,
    chunkId: m.chunk_id,
    title: m.document_title || m.heading || m.document_key,
    snippet: trimSnippet(m.chunk_text, 900),
    similarity: m.similarity,
    productKey: m.product_key,
  };
}

export async function ragQueryForProductKnowledge(input: {
  query: string;
  limit?: number;
  productLineKey?: string | null;
}): Promise<CuratedSource[]> {
  const result = await searchProductChunks({
    query: input.query,
    limit: input.limit ?? 8,
    productLineKey: input.productLineKey ?? undefined,
  });

  const curated = selectCuratedMatches(result.matches, {
    limit: input.limit ?? 8,
  });

  return curated.map(toCurated);
}
