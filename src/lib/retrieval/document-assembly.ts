import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * Per-document character cap. Full SDS / product profile documents can be very large,
 * so we truncate when assembling to keep prompts within the LLM context budget.
 */
const DEFAULT_MAX_CHARS_PER_DOCUMENT = 30_000;

type DocumentChunkRow = {
  id: string;
  document_id: string;
  chunk_index: number;
  heading: string | null;
  chunk_text: string;
  token_count: number | null;
};

export type AssembledDocumentBody = {
  documentId: string;
  body: string;
  chunkCount: number;
  totalChars: number;
  truncated: boolean;
  estimatedTokens: number | null;
};

/**
 * Loads every chunk for the supplied documentIds (ordered by chunk_index) and
 * stitches them back into a single document body string per documentId.
 *
 * The original similarity search returns isolated chunks. This is the second-stage
 * fetch that turns those hits into full-document context for the LLM.
 */
export async function assembleDocumentBodies(
  documentIds: string[],
  options?: { maxCharsPerDocument?: number },
): Promise<Map<string, AssembledDocumentBody>> {
  const result = new Map<string, AssembledDocumentBody>();
  const uniqueIds = Array.from(new Set(documentIds.filter(Boolean)));

  if (uniqueIds.length === 0) {
    return result;
  }

  const maxChars = options?.maxCharsPerDocument ?? DEFAULT_MAX_CHARS_PER_DOCUMENT;
  const supabase = getSupabaseServiceRoleClient();

  const { data, error } = await supabase
    .schema('rag')
    .from('document_chunk')
    .select('id, document_id, chunk_index, heading, chunk_text, token_count')
    .in('document_id', uniqueIds)
    .order('document_id', { ascending: true })
    .order('chunk_index', { ascending: true });

  if (error) {
    throw new Error(
      `Failed to load chunks for full-document assembly: ${error.message}`,
    );
  }

  const rows = (data ?? []) as DocumentChunkRow[];
  const grouped = new Map<string, DocumentChunkRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.document_id) ?? [];
    list.push(row);
    grouped.set(row.document_id, list);
  }

  for (const documentId of uniqueIds) {
    const docChunks = (grouped.get(documentId) ?? []).slice().sort(
      (a, b) => a.chunk_index - b.chunk_index,
    );

    if (docChunks.length === 0) {
      result.set(documentId, {
        documentId,
        body: '',
        chunkCount: 0,
        totalChars: 0,
        truncated: false,
        estimatedTokens: null,
      });
      continue;
    }

    const segments: string[] = [];
    let assembled = '';
    let truncated = false;
    let tokenSum = 0;
    let hasAnyTokenCount = false;

    for (const chunk of docChunks) {
      if (typeof chunk.token_count === 'number' && Number.isFinite(chunk.token_count)) {
        tokenSum += chunk.token_count;
        hasAnyTokenCount = true;
      }

      const heading = chunk.heading?.trim();
      const text = (chunk.chunk_text ?? '').trim();
      if (!text && !heading) {
        continue;
      }

      const segment = heading ? `## ${heading}\n${text}` : text;
      const separator = assembled.length === 0 ? '' : '\n\n';
      const candidate = `${assembled}${separator}${segment}`;

      if (candidate.length <= maxChars) {
        assembled = candidate;
        segments.push(segment);
        continue;
      }

      const remaining = Math.max(0, maxChars - assembled.length - separator.length);
      if (remaining > 0) {
        const sliced = segment.slice(0, Math.max(0, remaining - 1));
        if (sliced.length > 0) {
          assembled = `${assembled}${separator}${sliced}…`;
          segments.push(`${sliced}…`);
        }
      }
      truncated = true;
      break;
    }

    result.set(documentId, {
      documentId,
      body: assembled,
      chunkCount: segments.length,
      totalChars: assembled.length,
      truncated,
      estimatedTokens: hasAnyTokenCount ? tokenSum : null,
    });
  }

  return result;
}
