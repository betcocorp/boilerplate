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
  /**
   * B0-1131 — the same stitched chunks with the text each contributed to `body` (heading line
   * included, a truncated final chunk as sliced), so a regulated claim grounded against `body`
   * can be bound back to the `rag.document_chunk` row that carries its evidence.
   */
  chunks?: Array<{ chunkId: string; text: string }>;
};

export type DocumentSectionChunk = DocumentChunkRow & {
  chunkKey: string;
  sectionPath: string[] | null;
  sectionType: string;
};

export type AssembledDocumentSection = {
  body: AssembledDocumentBody;
  chunks: DocumentSectionChunk[];
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
      chunks: [],
    };
  }

  const segments: string[] = [];
  const chunkIds: string[] = [];
  const chunks: Array<{ chunkId: string; text: string }> = [];
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
      chunks.push({ chunkId: chunk.id, text: segment });
      continue;
    }

    const remaining = Math.max(0, maxChars - assembled.length - separator.length);
    if (remaining > 0) {
      const sliced = segment.slice(0, Math.max(0, remaining - 1));
      if (sliced.length > 0) {
        assembled = `${assembled}${separator}${sliced}…`;
        segments.push(`${sliced}…`);
        chunkIds.push(chunk.id);
        chunks.push({ chunkId: chunk.id, text: `${sliced}…` });
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
    chunks,
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

/**
 * Loads all chunks for one fine-grained SDS section in each supplied document. The result remains
 * keyed by parent document so retrieval can replace only that document's generic matched window.
 */
export async function assembleDocumentSectionBodies(
  documentIds: string[],
  sectionType: string,
  options?: { maxCharsPerDocument?: number },
): Promise<Map<string, AssembledDocumentSection>> {
  const result = new Map<string, AssembledDocumentSection>();
  const uniqueIds = Array.from(new Set(documentIds.filter(Boolean)));
  const normalizedSectionType = sectionType.trim();
  if (uniqueIds.length === 0 || !normalizedSectionType) return result;

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('rag')
    .from('document_chunk')
    .select(
      'id, document_id, chunk_key, chunk_index, heading, chunk_text, section_path, section_type, token_count',
    )
    .in('document_id', uniqueIds)
    .eq('section_type', normalizedSectionType)
    .order('document_id', { ascending: true })
    .order('chunk_index', { ascending: true });

  if (error) {
    throw new Error(`Failed to load document section chunks: ${error.message}`);
  }

  type SectionRow = DocumentChunkRow & {
    chunk_key: string;
    section_path: string[] | null;
    section_type: string;
  };
  const grouped = new Map<string, SectionRow[]>();
  for (const row of (data ?? []) as SectionRow[]) {
    const list = grouped.get(row.document_id) ?? [];
    list.push(row);
    grouped.set(row.document_id, list);
  }

  const maxChars = options?.maxCharsPerDocument ?? DEFAULT_MAX_CHARS_PER_DOCUMENT;
  for (const documentId of uniqueIds) {
    const rows = (grouped.get(documentId) ?? []).slice().sort(
      (a, b) => a.chunk_index - b.chunk_index,
    );
    if (rows.length === 0) continue;
    result.set(documentId, {
      body: stitchChunkRows(documentId, rows, maxChars),
      chunks: rows.map((row) => ({
        id: row.id,
        document_id: row.document_id,
        chunk_index: row.chunk_index,
        heading: row.heading,
        chunk_text: row.chunk_text,
        token_count: row.token_count,
        chunkKey: row.chunk_key,
        sectionPath: row.section_path,
        sectionType: row.section_type,
      })),
    });
  }

  return result;
}

export type DocumentPassageRequest = {
  documentId: string;
  documentKind: string;
  sectionTypes: string[];
  query?: string;
};

export type AssembledDocumentPassage = AssembledDocumentSection & {
  selectedSectionTypes: string[];
};

const LABEL_SECTION_MARKER = /<!--\s*section_type:\s*([a-z0-9_-]+)\s*-->/i;

export function labelSectionTypeFromHeading(heading: string | null): string | null {
  const match = heading?.match(LABEL_SECTION_MARKER);
  return match?.[1]?.toLowerCase() ?? null;
}

const LABEL_SECTION_ALIASES: Array<[RegExp, string]> = [
  [/\b(direction|instruction|use direction)/i, 'directions'],
  [/\b(dilution|mixing|mix rate)/i, 'dilution'],
  [/\b(surface|use site)/i, 'surfaces'],
  [/\b(epa claim|claim|efficacy)/i, 'epa_claims'],
  [/\b(hazard|warning|precaution)/i, 'hazards'],
  [/\b(first aid|medical)/i, 'first_aid'],
  [/\b(storage|disposal)/i, 'storage_disposal'],
  [/\b(technical|physical propert)/i, 'technical_properties'],
];

function inferLabelSectionTypeFromMetadata(
  heading: string | null,
  sectionPath: string[] | null,
): string | null {
  const marker = labelSectionTypeFromHeading(heading);
  if (marker) return marker;
  const metadata = [...(sectionPath ?? []), heading ?? '']
    .join(' ')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ');
  return LABEL_SECTION_ALIASES.find(([pattern]) => pattern.test(metadata))?.[1] ?? null;
}

const PASSAGE_RANKING_TERMS: Record<string, string[]> = {
  directions: ['directions', 'use', 'apply', 'wet', 'contact time'],
  dilution: ['dilution', 'dilute', 'mix', 'ratio', 'per gallon', 'oz/gal'],
  surfaces: ['surface', 'upholstery', 'curtain', 'fabric', 'textile'],
  epa_claims: ['epa', 'claim', 'effective against', 'kills'],
  hazards: ['danger', 'warning', 'hazard', 'corrosive', 'protective'],
  first_aid: ['first aid', 'swallowed', 'inhaled', 'eyes', 'skin'],
  storage_disposal: ['storage', 'store', 'disposal', 'dispose'],
  technical_properties: ['ph', 'physical', 'specific gravity', 'viscosity'],
};

/**
 * Hydrates fine-grained passages from already-selected SDS and label documents. SDS selectors use
 * the stored `section_type`; label selectors use the converter's heading marker because label rows
 * deliberately retain the coarse database type `label`.
 */
export async function assembleSelectedDocumentPassages(
  requests: DocumentPassageRequest[],
  options?: { maxCharsPerDocument?: number },
): Promise<Map<string, AssembledDocumentPassage>> {
  const result = new Map<string, AssembledDocumentPassage>();
  const merged = new Map<string, DocumentPassageRequest>();

  for (const request of requests) {
    const documentId = request.documentId.trim();
    const sectionTypes = request.sectionTypes.map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (!documentId || sectionTypes.length === 0) continue;
    const existing = merged.get(documentId);
    merged.set(documentId, {
      documentId,
      documentKind: request.documentKind.toLowerCase(),
      sectionTypes: [...new Set([...(existing?.sectionTypes ?? []), ...sectionTypes])],
      query: existing?.query ?? request.query,
    });
  }

  if (merged.size === 0) return result;

  type PassageRow = DocumentChunkRow & {
    chunk_key: string;
    section_path: string[] | null;
    section_type: string;
  };

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('rag')
    .from('document_chunk')
    .select(
      'id, document_id, chunk_key, chunk_index, heading, chunk_text, section_path, section_type, token_count',
    )
    .in('document_id', [...merged.keys()])
    .order('document_id', { ascending: true })
    .order('chunk_index', { ascending: true });

  if (error) {
    throw new Error(`Failed to load selected document passages: ${error.message}`);
  }

  const rowsByDocument = new Map<string, PassageRow[]>();
  for (const row of (data ?? []) as PassageRow[]) {
    if (!merged.has(row.document_id) || isNonEnglishMarkedChunk(row.chunk_text)) continue;
    const list = rowsByDocument.get(row.document_id) ?? [];
    list.push(row);
    rowsByDocument.set(row.document_id, list);
  }

  const maxChars = options?.maxCharsPerDocument ?? DEFAULT_MAX_CHARS_PER_DOCUMENT;
  for (const [documentId, request] of merged) {
    const documentRows = (rowsByDocument.get(documentId) ?? [])
      .slice()
      .sort((a, b) => a.chunk_index - b.chunk_index);
    let carriedSection: string | null = null;
    const resolvedRows = documentRows.map((row) => {
      if (request.documentKind === 'label') {
        const directSection = inferLabelSectionTypeFromMetadata(row.heading, row.section_path);
        if (directSection) carriedSection = directSection;
        return { ...row, resolvedSectionType: directSection ?? carriedSection };
      }

      const directSection = row.section_type?.trim().toLowerCase() || null;
      if (request.documentKind === 'sds' && directSection && directSection !== 'sds') {
        carriedSection = directSection;
      }
      return {
        ...row,
        resolvedSectionType:
          request.documentKind === 'sds' && directSection === 'sds'
            ? carriedSection ?? directSection
            : directSection,
      };
    });
    let ordered = resolvedRows
      .filter(
        (row): row is PassageRow & { resolvedSectionType: string } =>
          row.resolvedSectionType !== null && request.sectionTypes.includes(row.resolvedSectionType),
      )
      .sort(
        (a, b) =>
          request.sectionTypes.indexOf(a.resolvedSectionType) -
            request.sectionTypes.indexOf(b.resolvedSectionType) ||
          a.chunk_index - b.chunk_index,
      );

    // Older label conversions do not always carry section markers. Rank a small same-document set
    // by passage-family terms instead of widening to an unrelated document.
    if (ordered.length === 0 && request.documentKind === 'label') {
      const rankingTerms = request.sectionTypes.flatMap(
        (sectionType) => PASSAGE_RANKING_TERMS[sectionType] ?? [],
      );
      const queryTerms = (request.query?.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(
        (term) => !['what', 'when', 'using', 'does', 'need', 'with', 'such', 'that', 'this'].includes(term),
      );
      ordered = resolvedRows
        .map((row) => {
          const text = `${row.heading ?? ''} ${(row.section_path ?? []).join(' ')} ${row.chunk_text}`.toLowerCase();
          const sectionHits = rankingTerms.filter((term) => text.includes(term)).length;
          const queryHits = queryTerms.filter((term) => text.includes(term)).length;
          return { ...row, resolvedSectionType: 'ranked_same_document', score: sectionHits * 10 + queryHits };
        })
        .filter((row) => row.score >= 10)
        .sort((a, b) => b.score - a.score || a.chunk_index - b.chunk_index)
        .slice(0, 3)
        .sort((a, b) => a.chunk_index - b.chunk_index);
    }

    if (ordered.length === 0) continue;
    const body = stitchChunkRows(documentId, ordered, maxChars);
    const includedChunkIds = new Set(body.chunkIds);
    const includedRows = ordered.filter((row) => includedChunkIds.has(row.id));
    result.set(documentId, {
      body,
      chunks: includedRows.map((row) => ({
        id: row.id,
        document_id: row.document_id,
        chunk_index: row.chunk_index,
        heading: row.heading,
        chunk_text: row.chunk_text,
        token_count: row.token_count,
        chunkKey: row.chunk_key,
        sectionPath: row.section_path,
        sectionType: row.resolvedSectionType,
      })),
      selectedSectionTypes: [
        ...new Set(includedRows.map((row) => row.resolvedSectionType)),
      ],
    });
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
