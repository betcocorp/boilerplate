const COHERE_RERANK_ENDPOINT = 'https://api.cohere.com/v2/rerank';

type RerankableChunk = {
  chunk_id: string;
  heading: string | null;
  chunk_text: string;
};

type CohereRerankResponse = {
  results: { index: number; relevance_score: number }[];
};

function documentText(c: RerankableChunk): string {
  return c.heading ? `${c.heading}\n\n${c.chunk_text}` : c.chunk_text;
}

/**
 * Calls the Cohere rerank API to re-order `candidates` by relevance to `query`.
 * Returns an ordered array of `{ chunk_id, relevance_score }` on success,
 * or `null` when the API key is absent or the request fails — callers should
 * fall back to the original cosine order in that case.
 */
export async function rerankChunks(
  query: string,
  candidates: RerankableChunk[],
): Promise<{ chunk_id: string; relevance_score: number }[] | null> {
  if (candidates.length === 0) return [];

  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) return null;

  const model = process.env.COHERE_RERANK_MODEL ?? 'rerank-v3.5';

  let resp: Response;
  try {
    resp = await fetch(COHERE_RERANK_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        query,
        documents: candidates.map(documentText),
      }),
    });
  } catch {
    return null;
  }

  if (!resp.ok) return null;

  let body: CohereRerankResponse;
  try {
    body = (await resp.json()) as CohereRerankResponse;
  } catch {
    return null;
  }

  return body.results.map(({ index, relevance_score }) => ({
    chunk_id: candidates[index]!.chunk_id,
    relevance_score,
  }));
}
