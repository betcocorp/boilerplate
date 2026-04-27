import type { Json } from '~/types/supabase.rag';

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
