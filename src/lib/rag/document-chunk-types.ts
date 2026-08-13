import type { Json } from '~/types/supabase.rag';

/**
 * Synthetic source id used for the structured "Verified Product Facts" source (B0-196).
 * It is NOT a real `rag.document` row — the facts block is carried inline in the source
 * snippet, so it must never be looked up by uuid in the document-chunk inspect route.
 */
export const VERIFIED_FACTS_SOURCE_ID = 'verified-facts';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** rag.document / rag.document_chunk ids are uuids; synthetic sources (e.g. verified-facts) are not. */
export function isRagRowId(id: string | null | undefined): boolean {
  return !!id && UUID_RE.test(id);
}

export type RagDocumentChunkApiDocument = {
  id: string;
  title: string;
  document_key: string;
  document_kind: string;
  language_code: string;
  summary: string | null;
  body_text: string;
  body_markdown: string | null;
  metadata: Json;
  token_count: number | null;
  created_at: string;
  updated_at: string;
  entity_id: string | null;
  source_record_id: string;
};

export type RagDocumentChunkApiChunk = {
  id: string;
  document_id: string;
  chunk_index: number;
  chunk_key: string;
  chunk_text: string;
  heading: string | null;
  section_path: string[];
  token_count: number | null;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type RagDocumentChunkApiResponse = {
  document: RagDocumentChunkApiDocument;
  chunk: RagDocumentChunkApiChunk | null;
};
