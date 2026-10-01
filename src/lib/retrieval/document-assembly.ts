import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * Per-document character cap. Full SDS / product profile documents can be very large,
 * so we truncate when assembling to keep prompts within the LLM context budget.
 */
const DEFAULT_MAX_CHARS_PER_DOCUMENT = 30_000;

/**
 * B0-543: label-to-markdown conversion marks non-English sections it deliberately
 * excluded from English RAG with this literal sentinel (e.g. "> French label text (not
 * for English RAG ingestion):" / "> Spanish label text (not for English RAG
 * ingestion):"). The match_* RPCs (rag/search.ts) now filter these out of similarity
 * results, but this module fetches `rag.document_chunk` rows directly (neighbor-window
 * and full-document stitching), bypassing those RPCs entirely -- so a marked chunk
 * could still be stitched into assembled context as a neighbor of a legitimate English
 * match. Same exclusion, applied here too.
 */
const NON_ENGLISH_CHUNK_MARKER = /not for English RAG ingestion/i;

function isNonEnglishMarkedChunk(chunkText: string | null | undefined): boolean {
  return typeof chunkText === 'string' && NON_ENGLISH_CHUNK_MARKER.test(chunkText);
}

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
  /**
   * B0-13: ordered `rag.document_chunk.id`s actually stitched into `body` (including a
   * partially-included final chunk when `truncated`), so a response can be audited after the
   * fact for exactly which chunks reached the model -- e.g. confirming whether a specific
   * section (like a label's "Directions for Use") was retrieved or dropped by truncation.
   */
  chunkIds: string[];
};

/** Provenance pointer for a `rag.document` row, used to cite the exact source PDF/markdown (B0-257). */
export type DocumentSourceRef = {
  documentId: string;
  /** `metadata->>'s3_key'`, e.g. "labels/betco/67804_touch-up.md". */
  s3Key: string | null;
  /** `metadata->>'source_uri'`, e.g. "s3://retool-360/labels/betco/67804_touch-up.md". */
  sourceUri: string | null;
};

function readMetadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Fetch `s3_key` / `source_uri` provenance for a set of document ids (label/SDS/etc.
 * documents carry these in `metadata`). Degrades to an empty map on error so citation
 * enrichment never blocks retrieval.
 */
export async function fetchDocumentSourceRefs(
  documentIds: string[],
): Promise<Map<string, DocumentSourceRef>> {
  const result = new Map<string, DocumentSourceRef>();
  const uniqueIds = Array.from(new Set(documentIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return result;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('rag')
    .from('document')
    .select('id, metadata')
    .in('id', uniqueIds);

  if (error || !data) {
    return result;
  }

  for (const row of data as Array<{ id: string; metadata: unknown }>) {
    result.set(row.id, {
      documentId: row.id,
      s3Key: readMetadataString(row.metadata, 's3_key'),
      sourceUri: readMetadataString(row.metadata, 'source_uri'),
    });
  }

  return result;
}

/** Typed escape hatch shared by both queries below -- see the comment at the first call site. */
type LooseSelectInClient = {
  select(cols: string): {
    in(
      col: string,
      values: string[],
    ): Promise<{
      data: Array<Record<string, unknown>> | null;
      error: { message: string } | null;
    }>;
  };
};

/**
 * B0-1075/B0-1077: fetch derived betco.com product-page URLs for a set of product line keys
 * (`rag.product_line_web_url`, B0-1074), withholding any URL whose latest B0-1077 link check
 * (`rag.product_line_web_url_check`) came back `soft_404` or `error`. Keys are normalised to
 * uppercase before both the query and the map's keys, matching how `rag.entity.product_line_key`
 * and the view itself store them. Degrades to an empty map on error so citation enrichment never
 * blocks retrieval.
 *
 * Judgment call (B0-1077): a product line with NO check row yet (never verified) is still
 * surfaced -- withholding every URL until the first weekly checker run would silently hide the
 * entire feature between the view landing and the first cron tick. Only a URL actively CONFIRMED
 * broken is withheld.
 */
export async function fetchProductLineWebUrls(
  productLineKeys: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const uniqueKeys = Array.from(
    new Set(productLineKeys.filter(Boolean).map((key) => key.toUpperCase())),
  );
  if (uniqueKeys.length === 0) {
    return result;
  }

  const supabase = getSupabaseServiceRoleClient();
  // B0-1074/B0-1077: neither `rag.product_line_web_url` nor `rag.product_line_web_url_check` is
  // yet in the generated Supabase types (the local `types:supabase:rag` CLI is unauthenticated in
  // this environment -- see `pnpm run types:supabase:rag`); typed the same way other
  // pre-regen/ad-hoc `rag` queries are in this codebase (e.g. `~/lib/rag/corpus-config-actions.ts`)
  // until a real regen lands.
  const rag = supabase.schema('rag') as unknown as {
    from(table: string): LooseSelectInClient;
  };

  const [urlsResponse, checksResponse] = await Promise.all([
    rag.from('product_line_web_url').select('product_line_key, web_url').in(
      'product_line_key',
      uniqueKeys,
    ),
    rag.from('product_line_web_url_check').select('product_line_key, status').in(
      'product_line_key',
      uniqueKeys,
    ),
  ]);

  if (urlsResponse.error || !urlsResponse.data) {
    return result;
  }

  // Absence in this map means "never checked" -- treated as surfaceable, per the judgment call
  // documented above. Only an explicit non-'ok' status withholds the URL.
  const statusByKey = new Map<string, string>();
  if (!checksResponse.error && checksResponse.data) {
    for (const row of checksResponse.data as Array<{ product_line_key: string; status: string }>) {
      statusByKey.set(row.product_line_key.toUpperCase(), row.status);
    }
  }

  for (const row of urlsResponse.data as Array<{ product_line_key: string; web_url: string }>) {
    const key = row.product_line_key.toUpperCase();
    const status = statusByKey.get(key);
    if (status === 'soft_404' || status === 'error') {
      continue;
    }
    result.set(key, row.web_url);
  }

  return result;
}

/** Stitches one document's already-ordered chunk rows into a capped `AssembledDocumentBody`. */
function stitchChunkRows(
  documentId: string,
  docChunks: DocumentChunkRow[],
  maxChars: number,
): AssembledDocumentBody {
  if (docChunks.length === 0) {
    return {
      documentId,
      body: '',
      chunkCount: 0,
      totalChars: 0,
      truncated: false,
      estimatedTokens: null,
      chunkIds: [],
    };
  }

  const segments: string[] = [];
  const chunkIds: string[] = [];
  let assembled = '';
  let truncated = false;
  let tokenSum = 0;
  let hasAnyTokenCount = false;

  for (const chunk of docChunks) {
    // B0-543: skip chunks marked as non-English label text -- never stitch untranslated
    // French/Spanish safety text into English-scoped assembled context.
    if (isNonEnglishMarkedChunk(chunk.chunk_text)) {
      continue;
    }

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
      chunkIds.push(chunk.id);
      continue;
    }

    const remaining = Math.max(0, maxChars - assembled.length - separator.length);
    if (remaining > 0) {
      const sliced = segment.slice(0, Math.max(0, remaining - 1));
      if (sliced.length > 0) {
        assembled = `${assembled}${separator}${sliced}…`;
        segments.push(`${sliced}…`);
        chunkIds.push(chunk.id);
      }
    }
    truncated = true;
    break;
  }

  return {
    documentId,
    body: assembled,
    chunkCount: segments.length,
    totalChars: assembled.length,
    truncated,
    estimatedTokens: hasAnyTokenCount ? tokenSum : null,
    chunkIds,
  };
}

/**
 * Loads every chunk for the supplied documentIds (ordered by chunk_index) and
 * stitches them back into a single document body string per documentId.
 *
 * The original similarity search returns isolated chunks. This is the second-stage
 * fetch that turns those hits into full-document context for the LLM.
 *
 * B0-547: the product-support retrieval tools no longer call this (see
 * `assembleNeighborChunkBodies` below) — full-document assembly sent far more text than the
 * matched chunk needed. Kept as a general-purpose utility for callers that do want the whole
 * document (e.g. a future admin corpus viewer); not otherwise wired into any tool payload today.
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
    result.set(documentId, stitchChunkRows(documentId, docChunks, maxChars));
  }

  return result;
}

/** How many chunks on each side of the matched chunk `assembleNeighborChunkBodies` includes by default. */
export const NEIGHBOR_CHUNK_RADIUS = 1;

export type ChunkWindowRequest = {
  documentId: string;
  /** `chunk_index` (within its parent document) of the chunk that produced the similarity match. */
  chunkIndex: number;
};

/** Key `assembleNeighborChunkBodies` results are stored/looked up under. */
export function chunkWindowKey(request: ChunkWindowRequest): string {
  return `${request.documentId}:${request.chunkIndex}`;
}

/**
 * B0-547 — fetches only the matched chunk plus `radius` chunks immediately before/after it (by
 * `chunk_index`) per request, instead of every chunk in the document (`assembleDocumentBodies`).
 * Reduces what a retrieval tool sends per source from a whole document (up to the 30k assembly
 * cap) to a small window around the actual hit.
 *
 * Keyed by `chunkWindowKey` (`documentId:chunkIndex`), not documentId alone: curation can select
 * more than one matched chunk from the same document (`maxPerDocument` > 1 in
 * `classifyRetrievalIntent`), each needing its own window.
 *
 * Still a single round trip for every request: chunk_index is scoped per document, so the
 * per-request ranges are combined into one `or(and(...), and(...), ...)` PostgREST filter rather
 * than one query per document. Safe here (unlike free-text `.or()` filters elsewhere in this
 * codebase) because both filter values are system-generated (`document_id` uuids, integer
 * `chunk_index`), never user-supplied text that could contain a comma/paren.
 */
export async function assembleNeighborChunkBodies(
  requests: ChunkWindowRequest[],
  options?: { maxCharsPerDocument?: number; radius?: number },
): Promise<Map<string, AssembledDocumentBody>> {
  const result = new Map<string, AssembledDocumentBody>();
  const uniqueRequests = [...new Map(requests.map((r) => [chunkWindowKey(r), r])).values()].filter(
    (r) => r.documentId,
  );

  if (uniqueRequests.length === 0) {
    return result;
  }

  const radius = options?.radius ?? NEIGHBOR_CHUNK_RADIUS;
  const maxChars = options?.maxCharsPerDocument ?? DEFAULT_MAX_CHARS_PER_DOCUMENT;
  const supabase = getSupabaseServiceRoleClient();

  const orFilter = uniqueRequests
    .map((r) => {
      const low = Math.max(0, r.chunkIndex - radius);
      const high = r.chunkIndex + radius;
      return `and(document_id.eq.${r.documentId},chunk_index.gte.${low},chunk_index.lte.${high})`;
    })
    .join(',');

  const { data, error } = await supabase
    .schema('rag')
    .from('document_chunk')
    .select('id, document_id, chunk_index, heading, chunk_text, token_count')
    .or(orFilter)
    .order('document_id', { ascending: true })
    .order('chunk_index', { ascending: true });

  if (error) {
    throw new Error(`Failed to load neighbor chunks for windowed assembly: ${error.message}`);
  }

  const rows = (data ?? []) as DocumentChunkRow[];
  const byDocument = new Map<string, DocumentChunkRow[]>();
  for (const row of rows) {
    const list = byDocument.get(row.document_id) ?? [];
    list.push(row);
    byDocument.set(row.document_id, list);
  }

  for (const request of uniqueRequests) {
    const low = Math.max(0, request.chunkIndex - radius);
    const high = request.chunkIndex + radius;
    const windowRows = (byDocument.get(request.documentId) ?? [])
      .filter((row) => row.chunk_index >= low && row.chunk_index <= high)
      .slice()
      .sort((a, b) => a.chunk_index - b.chunk_index);
    result.set(chunkWindowKey(request), stitchChunkRows(request.documentId, windowRows, maxChars));
  }

  return result;
}

/**
 * B0-874 — ONE stitched body for a SINGLE document covering every index in `chunkIndexes` plus
 * `radius` chunks on either side of each (union, deduplicated, chunk order). Unlike
 * `assembleNeighborChunkBodies` (one window per matched chunk, keyed per request) this produces a
 * single evidence block, which is what a source that is being widened to its sibling chunks needs:
 * the FAQ-style knowledge documents behind the B0-874 items are short (typically 8–15 chunks of
 * 30–200 tokens), and the mandated detail sits in a sibling of the chunk similarity picked (SZ#11
 * matched the "Avoid" chunk while the humidity range lives in chunk 1 of the same guide).
 *
 * Reads `rag.document_chunk` directly (like the two assemblers above), so it applies the same
 * `NON_ENGLISH_CHUNK_MARKER` exclusion via `stitchChunkRows`. Both filter values are
 * system-generated (a uuid and integers), never user text.
 */
export async function assembleChunkIndexSetBody(
  request: { documentId: string; chunkIndexes: number[] },
  options?: { maxChars?: number; radius?: number },
): Promise<AssembledDocumentBody> {
  const radius = options?.radius ?? NEIGHBOR_CHUNK_RADIUS;
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS_PER_DOCUMENT;

  const wanted = new Set<number>();
  for (const index of request.chunkIndexes) {
    if (!Number.isInteger(index) || index < 0) {
      continue;
    }
    for (let i = Math.max(0, index - radius); i <= index + radius; i += 1) {
      wanted.add(i);
    }
  }

  if (!request.documentId || wanted.size === 0) {
    return stitchChunkRows(request.documentId, [], maxChars);
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('rag')
    .from('document_chunk')
    .select('id, document_id, chunk_index, heading, chunk_text, token_count')
    .eq('document_id', request.documentId)
    .in('chunk_index', [...wanted].sort((a, b) => a - b))
    .order('chunk_index', { ascending: true });

  if (error) {
    throw new Error(`Failed to load sibling chunks for knowledge expansion: ${error.message}`);
  }

  const rows = ((data ?? []) as DocumentChunkRow[])
    .slice()
    .sort((a, b) => a.chunk_index - b.chunk_index);
  return stitchChunkRows(request.documentId, rows, maxChars);
}
