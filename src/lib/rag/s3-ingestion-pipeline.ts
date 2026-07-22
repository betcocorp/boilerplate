// Generic S3 discovery -> source_record -> document -> dashboard-status ->
// run-mode-dispatch machinery shared by the S3-backed ingestion admin panels
// (SDS, efficacy, ...). Extracted from admin/sds/pipeline.ts (B0-227) so new
// document kinds can reuse the same batching / status / error-handling
// behavior instead of copy-pasting it. Pipeline-specific concerns (S3 key
// discovery/locale inference, file parsing) stay in each pipeline's own
// config rather than living here.

import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';

import { syncDocumentChunkEmbeddings } from '~/lib/rag/embeddings';
import { summarize } from '~/lib/rag/markdown-chunking';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import type { Json as RagJson } from '~/types/supabase.rag';

const DEFAULT_BATCH_SIZE = 2;
const MAX_BATCH_SIZE = 10;
const MAX_EMBEDDING_RUNS = 25;
const MAX_DASHBOARD_DOCUMENT_ROWS = 300;

export type JsonObject = { [key: string]: RagJson | undefined };

export type S3IngestionSeedDocument = {
  id: string;
  title: string;
  s3Key: string;
  locale: string;
};

export type S3IngestionParsedFile = {
  bodyText: string;
  bodyMarkdown: string | null;
};

export type S3IngestionPipelineConfig<TSeed extends S3IngestionSeedDocument> = {
  /** `rag.source_record.source_schema`, e.g. 'sds' | 'efficacy'. */
  sourceSchema: string;
  /** `rag.source_record.source_table`, e.g. 'sheet' | 'document'. */
  sourceTable: string;
  /** `rag.source_record.source_type`, e.g. 's3_pdf' | 's3_markdown'. */
  sourceType: string;
  /** `rag.document.document_kind`, e.g. 'sds' | 'efficacy'. */
  documentKind: string;
  /** Human label used in warning/error copy, e.g. 'SDS' | 'efficacy'. */
  sourceLabel: string;
  getS3Bucket: () => string;
  getS3Prefix: () => string;
  getS3Client: () => S3Client;
  /** Lists+maps S3 keys to seed docs. Bucket/prefix listing stays pipeline-specific. */
  discoverSeedDocuments: () => Promise<TSeed[]>;
  /** Pluggable per-file parsing step (PDF text extraction, markdown passthrough, ...). */
  parseFile: (buffer: Buffer, seed: TSeed) => Promise<S3IngestionParsedFile>;
  /** Extra fields merged into document.metadata (and source_record ingestion metadata). */
  buildDocumentMetadata?: (seed: TSeed) => Record<string, unknown>;
};

type IngestionMetadata = {
  status?: string;
  s3_key?: string;
  title?: string;
  locale?: string;
  chunk_count?: number;
  checksum?: string;
  source_uri?: string;
  parsed_at?: string;
  last_attempt_at?: string;
  last_error?: string | null;
};

type SourceRecordRow = {
  id: string;
  source_pk: string;
  source_uri: string | null;
  checksum: string | null;
  metadata: JsonObject | null;
  last_seen_at: string;
  updated_at: string;
  is_active: boolean;
};

type DocumentRow = {
  id: string;
  source_record_id: string;
  title: string;
  updated_at: string;
  metadata: JsonObject | null;
};

export type S3IngestionDashboardDocumentStatus =
  | 'missing'
  | 'registered'
  | 'ingested'
  | 'failed';

export type S3IngestionDashboardDocument = {
  id: string;
  title: string;
  s3Key: string;
  locale: string;
  status: S3IngestionDashboardDocumentStatus;
  sourceRecordId: string | null;
  documentId: string | null;
  chunkCount: number;
  checksum: string | null;
  sourceUri: string | null;
  updatedAt: string | null;
  lastError: string | null;
};

export type S3IngestionDashboardStatus = {
  totals: {
    seeded: number;
    registered: number;
    ingested: number;
    failed: number;
    chunks: number;
    embeddedChunks: number;
    pendingChunks: number;
  };
  preview: {
    showing: number;
    hidden: number;
  };
  warning: string | null;
  documents: S3IngestionDashboardDocument[];
};

export type S3IngestionRunMode =
  | 'register-seed'
  | 'ingest-next'
  | 'ingest-all'
  | 'retry-failed'
  | 'embed-next'
  | 'embed-all';

export type S3IngestionRunResult = {
  mode: S3IngestionRunMode;
  processed: number;
  succeeded: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
  errors: Array<{
    id: string;
    message: string;
  }>;
  status: S3IngestionDashboardStatus;
};

function nowIso() {
  return new Date().toISOString();
}

function asJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function computeChecksum(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function createS3IngestionPipeline<TSeed extends S3IngestionSeedDocument>(
  config: S3IngestionPipelineConfig<TSeed>,
) {
  const { sourceSchema, sourceTable, sourceType, documentKind, sourceLabel } = config;

  function clampBatchSize(batchSize?: number) {
    if (!Number.isFinite(batchSize) || !batchSize || batchSize < 1) {
      return DEFAULT_BATCH_SIZE;
    }

    return Math.min(Math.floor(batchSize), MAX_BATCH_SIZE);
  }

  function toSourcePk(seed: TSeed) {
    return seed.id;
  }

  function toDocumentKey(seed: TSeed) {
    return `${documentKind}:${seed.id}`;
  }

  function toSourceUri(seed: TSeed) {
    return `s3://${config.getS3Bucket()}/${seed.s3Key}`;
  }

  function asIngestionMetadata(value: JsonObject | null) {
    const ingestion = asJsonObject(value?.ingestion);
    return (ingestion ?? null) as IngestionMetadata | null;
  }

  function buildSourceMetadata(seed: TSeed, overrides: IngestionMetadata): JsonObject {
    const extra = config.buildDocumentMetadata?.(seed) ?? {};
    return {
      ingestion: {
        s3_key: seed.s3Key,
        source_uri: toSourceUri(seed),
        title: seed.title,
        locale: seed.locale.toUpperCase(),
        ...extra,
        ...overrides,
      },
    } as JsonObject;
  }

  async function getExistingSourceRecords() {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema('rag')
      .from('source_record')
      .select(
        'id, source_pk, source_uri, checksum, metadata, last_seen_at, updated_at, is_active',
      )
      .eq('source_schema', sourceSchema)
      .eq('source_table', sourceTable)
      .eq('source_type', sourceType);

    if (error) {
      throw new Error(`Failed to load ${sourceLabel} source records: ${error.message}`);
    }

    return (data ?? []) as SourceRecordRow[];
  }

  async function ensureSeedSourceRecord(seed: TSeed) {
    const supabase = getSupabaseServiceRoleClient();
    const sourcePk = toSourcePk(seed);
    const timestamp = nowIso();
    const metadata = buildSourceMetadata(seed, {
      status: 'registered',
      last_attempt_at: timestamp,
      last_error: null,
    });

    const { data: existing, error: existingError } = await supabase
      .schema('rag')
      .from('source_record')
      .select('id')
      .eq('source_schema', sourceSchema)
      .eq('source_table', sourceTable)
      .eq('source_type', sourceType)
      .eq('source_pk', sourcePk)
      .maybeSingle();

    if (existingError) {
      throw new Error(
        `Failed to inspect source record ${sourcePk}: ${existingError.message}`,
      );
    }

    if (existing?.id) {
      const { data: updated, error: updateError } = await supabase
        .schema('rag')
        .from('source_record')
        .update({
          is_active: true,
          source_locale: seed.locale.toUpperCase(),
          source_uri: toSourceUri(seed),
          metadata,
          last_seen_at: timestamp,
        })
        .eq('id', existing.id)
        .select('id')
        .single();

      if (updateError || !updated?.id) {
        throw new Error(
          `Failed to update source record ${sourcePk}: ${updateError?.message || 'Unknown error'}`,
        );
      }

      return updated.id;
    }

    const { data: inserted, error: insertError } = await supabase
      .schema('rag')
      .from('source_record')
      .insert({
        source_schema: sourceSchema,
        source_table: sourceTable,
        source_type: sourceType,
        source_pk: sourcePk,
        source_locale: seed.locale.toUpperCase(),
        source_uri: toSourceUri(seed),
        is_active: true,
        metadata,
        last_seen_at: timestamp,
      })
      .select('id')
      .single();

    if (insertError || !inserted?.id) {
      throw new Error(
        `Failed to insert source record ${sourcePk}: ${insertError?.message || 'Unknown error'}`,
      );
    }

    return inserted.id;
  }

  async function upsertDocument(
    sourceRecordId: string,
    seed: TSeed,
    parsed: S3IngestionParsedFile,
  ) {
    const supabase = getSupabaseServiceRoleClient();
    const documentKey = toDocumentKey(seed);
    const metadata = {
      source: documentKind,
      s3_key: seed.s3Key,
      source_uri: toSourceUri(seed),
      ...(config.buildDocumentMetadata?.(seed) ?? {}),
    } as JsonObject;

    const { data: existing, error: existingError } = await supabase
      .schema('rag')
      .from('document')
      .select('id')
      .eq('document_key', documentKey)
      .maybeSingle();

    if (existingError) {
      throw new Error(
        `Failed to inspect document ${documentKey}: ${existingError.message}`,
      );
    }

    if (existing?.id) {
      const { data: updated, error: updateError } = await supabase
        .schema('rag')
        .from('document')
        .update({
          source_record_id: sourceRecordId,
          title: seed.title,
          language_code: seed.locale.toUpperCase(),
          body_text: parsed.bodyText,
          body_markdown: parsed.bodyMarkdown,
          summary: summarize(parsed.bodyText),
          document_kind: documentKind,
          metadata,
        })
        .eq('id', existing.id)
        .select('id')
        .single();

      if (updateError || !updated?.id) {
        throw new Error(
          `Failed to update document ${documentKey}: ${updateError?.message || 'Unknown error'}`,
        );
      }

      return updated.id;
    }

    const { data: inserted, error: insertError } = await supabase
      .schema('rag')
      .from('document')
      .insert({
        source_record_id: sourceRecordId,
        title: seed.title,
        language_code: seed.locale.toUpperCase(),
        body_text: parsed.bodyText,
        body_markdown: parsed.bodyMarkdown,
        summary: summarize(parsed.bodyText),
        document_kind: documentKind,
        metadata,
        document_key: documentKey,
      })
      .select('id')
      .single();

    if (insertError || !inserted?.id) {
      throw new Error(
        `Failed to insert document ${documentKey}: ${insertError?.message || 'Unknown error'}`,
      );
    }

    return inserted.id;
  }

  async function markSourceRecord(
    sourceRecordId: string,
    seed: TSeed,
    params: {
      status: 'registered' | 'ingested' | 'failed';
      checksum?: string | null;
      chunkCount?: number;
      lastError?: string | null;
    },
  ) {
    const supabase = getSupabaseServiceRoleClient();
    const timestamp = nowIso();

    const { error } = await supabase
      .schema('rag')
      .from('source_record')
      .update({
        source_locale: seed.locale.toUpperCase(),
        source_uri: toSourceUri(seed),
        checksum: params.checksum ?? null,
        metadata: buildSourceMetadata(seed, {
          status: params.status,
          checksum: params.checksum ?? undefined,
          chunk_count: params.chunkCount,
          parsed_at: params.status === 'ingested' ? timestamp : undefined,
          last_attempt_at: timestamp,
          last_error: params.lastError ?? null,
        }),
        last_seen_at: timestamp,
        is_active: true,
      })
      .eq('id', sourceRecordId);

    if (error) {
      throw new Error(
        `Failed to update source status for ${seed.id}: ${error.message}`,
      );
    }
  }

  async function ingestSeedDocument(seed: TSeed) {
    const sourceRecordId = await ensureSeedSourceRecord(seed);

    try {
      const s3Client = config.getS3Client();
      const s3Object = await s3Client.send(
        new GetObjectCommand({
          Bucket: config.getS3Bucket(),
          Key: seed.s3Key,
        }),
      );
      const bytes = await s3Object.Body?.transformToByteArray();
      if (!bytes) {
        throw new Error(`S3 object body was empty for key ${seed.s3Key}.`);
      }
      const fileBuffer = Buffer.from(bytes);
      const checksum = computeChecksum(fileBuffer);
      const parsed = await config.parseFile(fileBuffer, seed);
      await upsertDocument(sourceRecordId, seed, parsed);

      await markSourceRecord(sourceRecordId, seed, {
        status: 'ingested',
        checksum,
        chunkCount: 0,
        lastError: null,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unexpected ingestion failure.';
      await markSourceRecord(sourceRecordId, seed, {
        status: 'failed',
        lastError: errorMessage,
      });
      throw error;
    }
  }

  async function loadDocumentRows() {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema('rag')
      .from('document')
      .select('id, source_record_id, title, updated_at, metadata')
      .eq('document_kind', documentKind);

    if (error) {
      throw new Error(`Failed to load ${sourceLabel} documents: ${error.message}`);
    }

    return (data ?? []) as DocumentRow[];
  }

  function sortStatusRows(rows: S3IngestionDashboardDocument[]) {
    const statusWeight: Record<S3IngestionDashboardDocumentStatus, number> = {
      failed: 0,
      missing: 1,
      registered: 2,
      ingested: 3,
    };

    return [...rows].sort((left, right) => {
      const weightDifference = statusWeight[left.status] - statusWeight[right.status];
      if (weightDifference !== 0) {
        return weightDifference;
      }

      const leftUpdated = left.updatedAt ? Date.parse(left.updatedAt) : 0;
      const rightUpdated = right.updatedAt ? Date.parse(right.updatedAt) : 0;

      if (leftUpdated !== rightUpdated) {
        return rightUpdated - leftUpdated;
      }

      return left.title.localeCompare(right.title);
    });
  }

  function toDashboardStatus(
    rows: S3IngestionDashboardDocument[],
  ): S3IngestionDashboardStatus {
    const sortedRows = sortStatusRows(rows);
    const visibleRows = sortedRows.slice(0, MAX_DASHBOARD_DOCUMENT_ROWS);

    return {
      totals: {
        seeded: rows.length,
        registered: rows.filter((row) => row.status !== 'missing').length,
        ingested: rows.filter((row) => row.status === 'ingested').length,
        failed: rows.filter((row) => row.status === 'failed').length,
        chunks: rows.reduce((sum, row) => sum + row.chunkCount, 0),
        embeddedChunks: 0,
        pendingChunks: 0,
      },
      preview: {
        showing: visibleRows.length,
        hidden: Math.max(0, rows.length - visibleRows.length),
      },
      warning: null,
      documents: visibleRows,
    };
  }

  function toFallbackStatus(message: string): S3IngestionDashboardStatus {
    return {
      totals: {
        seeded: 0,
        registered: 0,
        ingested: 0,
        failed: 0,
        chunks: 0,
        embeddedChunks: 0,
        pendingChunks: 0,
      },
      preview: {
        showing: 0,
        hidden: 0,
      },
      warning: message,
      documents: [],
    };
  }

  type ChunkCounts = {
    chunks: number;
    embeddedChunks: number;
    pendingChunks: number;
  };

  async function loadChunkEmbeddingTotals(): Promise<ChunkCounts> {
    const supabase = getSupabaseServiceRoleClient();
    const rag = supabase.schema('rag');
    const chunkKeyPrefix = `${documentKind}:%`;

    const [
      { count: totalCount, error: totalError },
      { count: embeddedCount, error: embeddedError },
    ] = await Promise.all([
      rag
        .from('document_chunk')
        .select('id', { count: 'exact', head: true })
        .like('chunk_key', chunkKeyPrefix),
      (rag.from('document_chunk') as unknown as {
        select(cols: string, opts: { count: 'exact'; head: true }): {
          like(col: string, val: string): {
            not(col: string, op: string, val: null): Promise<{ count: number | null; error: { message: string } | null }>;
          };
        };
      })
        .select('id', { count: 'exact', head: true })
        .like('chunk_key', chunkKeyPrefix)
        .not('embedding_large', 'is', null),
    ]);

    if (totalError) {
      throw new Error(`Failed to count ${sourceLabel} chunks: ${totalError.message}`);
    }

    if (embeddedError) {
      throw new Error(
        `Failed to count embedded ${sourceLabel} chunks: ${embeddedError.message}`,
      );
    }

    const total = totalCount ?? 0;
    const embedded = embeddedCount ?? 0;

    return {
      chunks: total,
      embeddedChunks: embedded,
      pendingChunks: total - embedded,
    };
  }

  async function withChunkEmbeddingTotals(
    status: S3IngestionDashboardStatus,
  ): Promise<S3IngestionDashboardStatus> {
    try {
      const totals = await loadChunkEmbeddingTotals();
      return {
        ...status,
        totals: {
          ...status.totals,
          chunks: totals.chunks,
          embeddedChunks: totals.embeddedChunks,
          pendingChunks: totals.pendingChunks,
        },
      };
    } catch {
      return status;
    }
  }

  async function fallbackStatusFromExistingRecords(message: string) {
    const [sourceRecords, documents] = await Promise.all([
      getExistingSourceRecords(),
      loadDocumentRows(),
    ]);

    if (sourceRecords.length === 0) {
      return toFallbackStatus(message);
    }

    const documentBySourceRecordId = new Map(
      documents.map((row) => [row.source_record_id, row]),
    );

    const rows: S3IngestionDashboardDocument[] = sourceRecords.map((source) => {
      const metadata = asIngestionMetadata(source.metadata);
      const document = documentBySourceRecordId.get(source.id) ?? null;
      const metadataChunkCount = metadata?.chunk_count;
      const chunkCount =
        typeof metadataChunkCount === 'number' && Number.isFinite(metadataChunkCount)
          ? metadataChunkCount
          : 0;
      const metadataStatus = metadata?.status ?? null;

      let status: S3IngestionDashboardDocumentStatus = 'registered';
      if (metadataStatus === 'failed') {
        status = 'failed';
      } else if (metadataStatus === 'ingested' || (document && chunkCount > 0)) {
        status = 'ingested';
      }

      return {
        id: source.source_pk,
        title: asString(metadata?.title) ?? document?.title ?? source.source_pk,
        s3Key: asString(metadata?.s3_key) ?? '',
        locale: asString(metadata?.locale)?.toUpperCase() ?? 'EN',
        status,
        sourceRecordId: source.id,
        documentId: document?.id ?? null,
        chunkCount,
        checksum: source.checksum,
        sourceUri: source.source_uri,
        updatedAt: document?.updated_at ?? source.updated_at,
        lastError: asString(metadata?.last_error) ?? null,
      };
    });

    return withChunkEmbeddingTotals({
      ...toDashboardStatus(rows),
      warning: message,
    });
  }

  async function getStatusRows(seedDocuments: TSeed[]) {
    const [sourceRecords, documents] = await Promise.all([
      getExistingSourceRecords(),
      loadDocumentRows(),
    ]);

    const sourceByPk = new Map(sourceRecords.map((row) => [row.source_pk, row]));
    const documentBySourceRecordId = new Map(
      documents.map((row) => [row.source_record_id, row]),
    );

    return seedDocuments.map((seed) => {
      const source = sourceByPk.get(toSourcePk(seed)) ?? null;
      const document = source
        ? (documentBySourceRecordId.get(source.id) ?? null)
        : null;
      const metadata = asIngestionMetadata(source?.metadata ?? null);
      const metadataChunkCount = metadata?.chunk_count;
      const chunkCount =
        typeof metadataChunkCount === 'number' && Number.isFinite(metadataChunkCount)
          ? metadataChunkCount
          : 0;
      const metadataStatus = metadata?.status ?? null;

      let status: S3IngestionDashboardDocumentStatus = 'missing';
      if (metadataStatus === 'failed') {
        status = 'failed';
      } else if (metadataStatus === 'ingested' || (document && chunkCount > 0)) {
        status = 'ingested';
      } else if (source) {
        status = 'registered';
      }

      return {
        id: seed.id,
        title: seed.title,
        s3Key: seed.s3Key,
        locale: seed.locale.toUpperCase(),
        status,
        sourceRecordId: source?.id ?? null,
        documentId: document?.id ?? null,
        chunkCount,
        checksum: source?.checksum ?? null,
        sourceUri: source?.source_uri ?? null,
        updatedAt: document?.updated_at ?? source?.updated_at ?? null,
        lastError: asString(metadata?.last_error) ?? null,
      } satisfies S3IngestionDashboardDocument;
    });
  }

  async function getDashboardStatus(): Promise<S3IngestionDashboardStatus> {
    try {
      const seedDocuments = await config.discoverSeedDocuments();
      const rows = await getStatusRows(seedDocuments);
      return await withChunkEmbeddingTotals(toDashboardStatus(rows));
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'Unknown S3 discovery failure.';
      const message = `S3 discovery is unavailable right now (${reason}). Showing last known ${sourceLabel} records.`;
      try {
        return await fallbackStatusFromExistingRecords(message);
      } catch {
        return await withChunkEmbeddingTotals(toFallbackStatus(message));
      }
    }
  }

  async function runIngestion(
    mode: S3IngestionRunMode,
    batchSize?: number,
  ): Promise<S3IngestionRunResult> {
    const startedAt = nowIso();
    const errors: S3IngestionRunResult['errors'] = [];
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let status: S3IngestionDashboardStatus;

    if (mode === 'register-seed') {
      const seedDocuments = await config.discoverSeedDocuments();
      for (const seed of seedDocuments) {
        processed += 1;
        try {
          await ensureSeedSourceRecord(seed);
          succeeded += 1;
        } catch (error) {
          failed += 1;
          errors.push({
            id: seed.id,
            message:
              error instanceof Error ? error.message : 'Registration failed.',
          });
        }
      }
      status = await withChunkEmbeddingTotals(
        toDashboardStatus(await getStatusRows(seedDocuments)),
      );
    } else if (mode === 'embed-next' || mode === 'embed-all') {
      let runCount = 0;

      while (runCount < MAX_EMBEDDING_RUNS) {
        const embedResult = await syncDocumentChunkEmbeddings({
          batchSize,
          maxBatches: mode === 'embed-next' ? 1 : 20,
          documentKind,
        });

        runCount += 1;
        processed += embedResult.chunksEmbedded;
        succeeded += embedResult.chunksEmbedded;

        if (
          mode === 'embed-next' ||
          embedResult.remainingChunks === 0 ||
          embedResult.chunksEmbedded === 0
        ) {
          break;
        }
      }
      status = await fallbackStatusFromExistingRecords(
        `S3 discovery was skipped for embedding-only ${sourceLabel} action.`,
      );
    } else {
      const seedDocuments = await config.discoverSeedDocuments();
      const seedById = new Map(seedDocuments.map((seed) => [seed.id, seed]));
      const rows = await getStatusRows(seedDocuments);
      let candidates = rows.filter((row) => row.status !== 'ingested');

      if (mode === 'retry-failed') {
        candidates = rows.filter((row) => row.status === 'failed');
      }

      if (mode === 'ingest-next') {
        candidates = candidates.slice(0, clampBatchSize(batchSize));
      }

      for (const candidate of candidates) {
        const seed = seedById.get(candidate.id);
        if (!seed) {
          continue;
        }

        processed += 1;
        try {
          await ingestSeedDocument(seed);
          succeeded += 1;
        } catch (error) {
          failed += 1;
          errors.push({
            id: seed.id,
            message: error instanceof Error ? error.message : 'Ingestion failed.',
          });
        }
      }
      status = await withChunkEmbeddingTotals(
        toDashboardStatus(await getStatusRows(seedDocuments)),
      );
    }

    return {
      mode,
      processed,
      succeeded,
      failed,
      startedAt,
      finishedAt: nowIso(),
      errors,
      status,
    };
  }

  return {
    getDashboardStatus,
    runIngestion,
  };
}
