import { z } from 'zod';

import type { RagSearchMatch } from '~/lib/rag/search';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/** Whether a supplied GUID is a `rag.document_chunk.id` or a `rag.document.id`. */
export const ragIdLookupTargetSchema = z.enum(['chunk', 'document']);

export type RagIdLookupTarget = z.infer<typeof ragIdLookupTargetSchema>;

export const ragIdLookupInputSchema = z.object({
  id: z.string().uuid(),
  target: ragIdLookupTargetSchema,
});

export type RagIdLookupInput = z.infer<typeof ragIdLookupInputSchema>;

/** B0-1017 — a document can hold thousands of chunks; cap what the admin grid renders. */
export const RAG_ID_LOOKUP_MAX_CHUNKS = 200;

export type RagIdLookupResult = {
  target: RagIdLookupTarget;
  id: string;
  /** Rows in the same shape semantic search returns; `similarity` is always 0 (not meaningful for a direct read). */
  matches: RagSearchMatch[];
  /** Total chunks the document has, when target is 'document' and the result was capped. */
  totalChunkCount: number;
  found: boolean;
};

type ChunkRow = {
  id: string;
  chunk_key: string;
  chunk_index: number;
  heading: string | null;
  chunk_text: string;
  section_path: string[] | null;
  section_type: string | null;
  token_count: number | null;
  document_id: string;
};

type DocumentRow = {
  id: string;
  document_key: string;
  title: string | null;
  document_kind: string;
  source_record_id: string | null;
  entity_id: string | null;
};

type EntityRow = {
  id: string;
  product_key: string | null;
  sku: string | null;
  product_line_key: string | null;
};

type SourceRecordRow = {
  source_pk: string | null;
};

const CHUNK_COLUMNS =
  'id, chunk_key, chunk_index, heading, chunk_text, section_path, section_type, token_count, document_id';
const DOCUMENT_COLUMNS = 'id, document_key, title, document_kind, source_record_id, entity_id';

/**
 * B0-1017 — the `rag` schema is absent from the generated default types, so queries are cast to
 * narrow local shapes exactly like `admin/products/rag/documents/[id]/page.tsx` does.
 */
type MaybeSingleSelect<T> = {
  select(cols: string): {
    eq(col: string, val: string): {
      maybeSingle(): Promise<{ data: T | null; error: { message: string } | null }>;
    };
  };
};

type OrderedListSelect<T> = {
  select(cols: string): {
    eq(col: string, val: string): {
      order(
        col: string,
        opts: { ascending: boolean },
      ): {
        limit(count: number): Promise<{
          data: T[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

type CountSelect = {
  select(
    cols: string,
    opts: { count: 'exact'; head: true },
  ): {
    eq(
      col: string,
      val: string,
    ): Promise<{ count: number | null; error: { message: string } | null }>;
  };
};

function toMatch(
  chunk: ChunkRow,
  document: DocumentRow,
  entity: EntityRow | null,
  sourcePk: string | null,
): RagSearchMatch {
  return {
    chunk_id: chunk.id,
    chunk_key: chunk.chunk_key,
    chunk_index: chunk.chunk_index,
    heading: chunk.heading,
    chunk_text: chunk.chunk_text,
    section_path: chunk.section_path,
    section_type: chunk.section_type,
    token_count: chunk.token_count,
    document_id: document.id,
    document_key: document.document_key,
    document_title: document.title ?? '',
    entity_id: entity?.id ?? null,
    product_key: entity?.product_key ?? null,
    sku: entity?.sku ?? null,
    product_line_key: entity?.product_line_key ?? null,
    source_pk: sourcePk ?? '',
    document_kind: document.document_kind,
    // A direct id read has no query vector to score against, so similarity carries no meaning.
    similarity: 0,
  };
}

type SupabaseServiceClient = ReturnType<typeof getSupabaseServiceRoleClient>;

async function fetchDocument(
  supabase: SupabaseServiceClient,
  documentId: string,
): Promise<DocumentRow | null> {
  const { data, error } = await (
    supabase.schema('rag').from('document') as unknown as MaybeSingleSelect<DocumentRow>
  )
    .select(DOCUMENT_COLUMNS)
    .eq('id', documentId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

/** Resolves a document's optional entity and source_record joins, mirroring `rag.match_corpus_chunks`. */
async function fetchDocumentJoins(supabase: SupabaseServiceClient, document: DocumentRow) {
  const [entityResult, sourceRecordResult] = await Promise.all([
    document.entity_id
      ? (supabase.schema('rag').from('entity') as unknown as MaybeSingleSelect<EntityRow>)
          .select('id, product_key, sku, product_line_key')
          .eq('id', document.entity_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    document.source_record_id
      ? (
          supabase
            .schema('rag')
            .from('source_record') as unknown as MaybeSingleSelect<SourceRecordRow>
        )
          .select('source_pk')
          .eq('id', document.source_record_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (entityResult.error) {
    throw new Error(entityResult.error.message);
  }

  if (sourceRecordResult.error) {
    throw new Error(sourceRecordResult.error.message);
  }

  return {
    entity: entityResult.data,
    sourcePk: sourceRecordResult.data?.source_pk ?? null,
  };
}

/**
 * B0-1017 — direct GUID read of a `rag.document_chunk` row or of every chunk in a `rag.document`,
 * shaped exactly like a semantic-search match so the admin grid can render either interchangeably.
 */
export async function lookupRagChunksById(input: {
  id: string;
  target: RagIdLookupTarget;
}): Promise<RagIdLookupResult> {
  const supabase = getSupabaseServiceRoleClient();
  const empty: RagIdLookupResult = {
    target: input.target,
    id: input.id,
    matches: [],
    totalChunkCount: 0,
    found: false,
  };

  if (input.target === 'chunk') {
    const { data: chunk, error } = await (
      supabase.schema('rag').from('document_chunk') as unknown as MaybeSingleSelect<ChunkRow>
    )
      .select(CHUNK_COLUMNS)
      .eq('id', input.id)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (!chunk) {
      return empty;
    }

    const document = await fetchDocument(supabase, chunk.document_id);

    if (!document) {
      return empty;
    }

    const { entity, sourcePk } = await fetchDocumentJoins(supabase, document);

    return {
      target: 'chunk',
      id: input.id,
      matches: [toMatch(chunk, document, entity, sourcePk)],
      totalChunkCount: 1,
      found: true,
    };
  }

  const document = await fetchDocument(supabase, input.id);

  if (!document) {
    return empty;
  }

  const { entity, sourcePk } = await fetchDocumentJoins(supabase, document);

  const [chunksResult, countResult] = await Promise.all([
    (
      supabase.schema('rag').from('document_chunk') as unknown as OrderedListSelect<ChunkRow>
    )
      .select(CHUNK_COLUMNS)
      .eq('document_id', document.id)
      .order('chunk_index', { ascending: true })
      .limit(RAG_ID_LOOKUP_MAX_CHUNKS),
    (supabase.schema('rag').from('document_chunk') as unknown as CountSelect)
      .select('*', { count: 'exact', head: true })
      .eq('document_id', document.id),
  ]);

  if (chunksResult.error) {
    throw new Error(chunksResult.error.message);
  }

  if (countResult.error) {
    throw new Error(countResult.error.message);
  }

  const chunks = chunksResult.data ?? [];

  return {
    target: 'document',
    id: input.id,
    matches: chunks.map((chunk) => toMatch(chunk, document, entity, sourcePk)),
    totalChunkCount: countResult.count ?? chunks.length,
    found: true,
  };
}
