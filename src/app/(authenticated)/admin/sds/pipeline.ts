import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

import { syncDocumentChunkEmbeddings, syncDocumentChunkEmbeddingsLarge } from '~/lib/rag/embeddings';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import type { Json as RagJson } from '~/types/supabase.rag';

import {
  SDS_FILE_OVERRIDES,
  SDS_S3_BUCKET_DEFAULT,
  SDS_S3_PREFIX_DEFAULT,
  type SdsSeedDocument,
} from './manifest';

const SOURCE_SCHEMA = 'sds';
const SOURCE_TABLE = 'sheet';
const SOURCE_TYPE = 's3_pdf';
const DOCUMENT_KIND = 'sds';
const DEFAULT_BATCH_SIZE = 2;
const MAX_BATCH_SIZE = 10;
const MAX_EMBEDDING_RUNS = 25;
const MAX_CHARS_PER_CHUNK = 2200;
const CHUNK_OVERLAP_CHARS = 250;
const MAX_DASHBOARD_DOCUMENT_ROWS = 300;

type JsonObject = { [key: string]: RagJson | undefined };

type SdsIngestionMetadata = {
  status?: string;
  s3_key?: string;
  title?: string;
  locale?: string;
  product_code?: string | null;
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

type SdsDashboardDocumentStatus =
  | 'missing'
  | 'registered'
  | 'ingested'
  | 'failed';

export type SdsDashboardDocument = {
  id: string;
  title: string;
  s3Key: string;
  locale: string;
  status: SdsDashboardDocumentStatus;
  sourceRecordId: string | null;
  documentId: string | null;
  chunkCount: number;
  checksum: string | null;
  sourceUri: string | null;
  updatedAt: string | null;
  lastError: string | null;
};

export type SdsDashboardStatus = {
  totals: {
    seeded: number;
    registered: number;
    ingested: number;
    failed: number;
    chunks: number;
    embeddedChunks: number;
    pendingChunks: number;
    embeddedLargeChunks: number;
    pendingLargeChunks: number;
  };
  preview: {
    showing: number;
    hidden: number;
  };
  warning: string | null;
  documents: SdsDashboardDocument[];
};

export type SdsIngestionRunMode =
  | 'register-seed'
  | 'ingest-next'
  | 'ingest-all'
  | 'retry-failed'
  | 'embed-next'
  | 'embed-all'
  | 'embed-next-large'
  | 'embed-all-large';

export type SdsIngestionRunResult = {
  mode: SdsIngestionRunMode;
  processed: number;
  succeeded: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
  errors: Array<{
    id: string;
    message: string;
  }>;
  status: SdsDashboardStatus;
};

function normalizeRelativePath(value: string) {
  return value.replaceAll('\\', '/').toLowerCase();
}

function inferLocale(relativePath: string) {
  const lower = relativePath.toLowerCase();

  if (
    lower.includes('/fr/') ||
    lower.includes('-fr.pdf') ||
    lower.includes('(fr).pdf')
  ) {
    return 'FR';
  }

  if (
    lower.includes('/es/') ||
    lower.includes('/spanish') ||
    lower.includes('-es.pdf') ||
    lower.includes('(es).pdf')
  ) {
    return 'ES';
  }

  return 'EN';
}

function inferProductCode(fileName: string) {
  const match = fileName.match(/([a-z]{0,4}\d{2,}[a-z0-9-]*)/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function inferTitle(fileNameWithoutExtension: string) {
  const normalized = fileNameWithoutExtension
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return normalized || fileNameWithoutExtension;
}

function getS3Bucket() {
  return process.env.AWS_S3_BUCKET_NAME?.trim() || SDS_S3_BUCKET_DEFAULT;
}

function getS3Prefix() {
  const prefix = process.env.SDS_S3_PREFIX?.trim() || SDS_S3_PREFIX_DEFAULT;
  if (!prefix) {
    return '';
  }
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

function getAwsCredentials() {
  const accessKeyId =
    process.env.AWS_ACCESS_READ_KEY_ID?.trim() ||
    process.env.AWS_ACCESS_KEY_ID?.trim() ||
    process.env.AWS_ACCESS_WRITE_KEY_ID?.trim();
  const secretAccessKey =
    process.env.AWS_SECRET_READ_ACCESS_KEY?.trim() ||
    process.env.AWS_SECRET_ACCESS_KEY?.trim() ||
    process.env.AWS_SECRET_WRITE_ACCESS_KEY?.trim();

  if (!accessKeyId || !secretAccessKey) {
    return undefined;
  }

  return { accessKeyId, secretAccessKey };
}

function getS3Client() {
  const region =
    process.env.SDS_S3_REGION?.trim() ||
    process.env.AWS_REGION?.trim() ||
    'us-east-1';
  const credentials = getAwsCredentials();
  return new S3Client({
    region,
    ...(credentials ? { credentials } : {}),
  });
}

function keyToRelativePath(s3Key: string, prefix: string) {
  if (prefix && s3Key.startsWith(prefix)) {
    return s3Key.slice(prefix.length);
  }
  if (s3Key.startsWith('sds/')) {
    return s3Key.slice('sds/'.length);
  }
  return s3Key;
}

async function listS3PdfKeys(client: S3Client, bucket: string, prefix: string) {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const item of page.Contents ?? []) {
      const key = item.Key?.trim();
      if (!key || key.endsWith('/')) {
        continue;
      }
      if (extname(key).toLowerCase() === '.pdf') {
        keys.push(key);
      }
    }

    continuationToken = page.NextContinuationToken;
  } while (continuationToken);

  keys.sort((left, right) => left.localeCompare(right));
  return keys;
}

async function discoverSdsSeedDocuments() {
  const bucket = getS3Bucket();
  const prefix = getS3Prefix();
  const client = getS3Client();
  const discoveredKeys = await listS3PdfKeys(client, bucket, prefix);

  return discoveredKeys.map((s3Key) => {
    const relativePath = normalizeRelativePath(
      keyToRelativePath(s3Key, prefix),
    );
    const fileName = basename(s3Key);
    const fileNameWithoutExtension = fileName.slice(
      0,
      -extname(fileName).length,
    );
    const override = SDS_FILE_OVERRIDES[relativePath];
    const inferredTitle = inferTitle(fileNameWithoutExtension);
    const inferredProductCode = inferProductCode(fileNameWithoutExtension);
    const locale = (
      override?.locale || inferLocale(relativePath)
    ).toUpperCase();

    return {
      id: createHash('sha1').update(s3Key).digest('hex').slice(0, 20),
      title: override?.title || inferredTitle,
      productCode: override?.productCode || inferredProductCode,
      s3Key,
      locale,
    } satisfies SdsSeedDocument;
  });
}

function asJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asSdsMetadata(value: JsonObject | null) {
  const ingestion = asJsonObject(value?.ingestion);

  return (ingestion ?? null) as SdsIngestionMetadata | null;
}

function toSourcePk(seed: SdsSeedDocument) {
  return seed.id;
}

function toDocumentKey(seed: SdsSeedDocument) {
  return `sds:${seed.id}`;
}

function toSourceUri(seed: SdsSeedDocument) {
  return `s3://${getS3Bucket()}/${seed.s3Key}`;
}

function nowIso() {
  return new Date().toISOString();
}

function clampBatchSize(batchSize?: number) {
  if (!Number.isFinite(batchSize) || !batchSize || batchSize < 1) {
    return DEFAULT_BATCH_SIZE;
  }

  return Math.min(Math.floor(batchSize), MAX_BATCH_SIZE);
}

function normalizePdfText(rawText: string) {
  return rawText
    .replaceAll('\r', '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function summarize(text: string) {
  if (text.length <= 280) {
    return text;
  }

  return `${text.slice(0, 277).trim()}...`;
}

function chunkText(text: string) {
  if (!text.trim()) {
    return [];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const end = Math.min(text.length, cursor + MAX_CHARS_PER_CHUNK);
    let chunk = text.slice(cursor, end);

    if (end < text.length) {
      const splitAt = Math.max(
        chunk.lastIndexOf('\n\n'),
        chunk.lastIndexOf('. '),
        chunk.lastIndexOf(' '),
      );
      if (splitAt > Math.floor(MAX_CHARS_PER_CHUNK * 0.6)) {
        chunk = chunk.slice(0, splitAt + 1);
      }
    }

    const normalizedChunk = chunk.trim();
    if (normalizedChunk) {
      chunks.push(normalizedChunk);
    }

    if (end >= text.length) {
      break;
    }

    cursor = Math.max(end - CHUNK_OVERLAP_CHARS, cursor + 1);
  }

  return chunks;
}

function buildSourceMetadata(
  seed: SdsSeedDocument,
  overrides: SdsIngestionMetadata,
) {
  return {
    ingestion: {
      s3_key: seed.s3Key,
      source_uri: toSourceUri(seed),
      title: seed.title,
      locale: seed.locale.toUpperCase(),
      product_code: seed.productCode,
      ...overrides,
    },
  } as JsonObject;
}

function computeChecksum(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function parsePdf(buffer: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
  });
  const pdfDocument = await loadingTask.promise;
  const pageCount = pdfDocument.numPages;
  const pageTexts: string[] = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const content = await page.getTextContent();
    const textParts: string[] = [];

    for (const item of content.items) {
      if (typeof item === 'object' && item !== null && 'str' in item) {
        const candidate = (item as { str?: unknown }).str;
        if (typeof candidate === 'string' && candidate.trim()) {
          textParts.push(candidate);
        }
      }
    }

    pageTexts.push(textParts.join(' '));
    page.cleanup();
  }
  await pdfDocument.destroy();

  const text = normalizePdfText(pageTexts.join('\n\n'));

  if (!text) {
    throw new Error('PDF parsing returned empty text.');
  }

  return {
    text,
    numPages: pageCount > 0 ? pageCount : null,
  };
}

async function getExistingSdsSourceRecords() {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('rag')
    .from('source_record')
    .select(
      'id, source_pk, source_uri, checksum, metadata, last_seen_at, updated_at, is_active',
    )
    .eq('source_schema', SOURCE_SCHEMA)
    .eq('source_table', SOURCE_TABLE)
    .eq('source_type', SOURCE_TYPE);

  if (error) {
    throw new Error(`Failed to load SDS source records: ${error.message}`);
  }

  return (data ?? []) as SourceRecordRow[];
}

async function ensureSeedSourceRecord(seed: SdsSeedDocument) {
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
    .eq('source_schema', SOURCE_SCHEMA)
    .eq('source_table', SOURCE_TABLE)
    .eq('source_type', SOURCE_TYPE)
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
      source_schema: SOURCE_SCHEMA,
      source_table: SOURCE_TABLE,
      source_type: SOURCE_TYPE,
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
  seed: SdsSeedDocument,
  bodyText: string,
) {
  const supabase = getSupabaseServiceRoleClient();
  const documentKey = toDocumentKey(seed);
  const metadata = {
    source: 'sds',
    s3_key: seed.s3Key,
    source_uri: toSourceUri(seed),
    product_code: seed.productCode,
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
        body_text: bodyText,
        body_markdown: null,
        summary: summarize(bodyText),
        document_kind: DOCUMENT_KIND,
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
      body_text: bodyText,
      body_markdown: null,
      summary: summarize(bodyText),
      document_kind: DOCUMENT_KIND,
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

async function replaceDocumentChunks(
  documentId: string,
  documentKey: string,
  bodyText: string,
) {
  const supabase = getSupabaseServiceRoleClient();
  const chunks = chunkText(bodyText);
  const { error: deleteError } = await supabase
    .schema('rag')
    .from('document_chunk')
    .delete()
    .eq('document_id', documentId);

  if (deleteError) {
    throw new Error(
      `Failed to clear existing chunks for ${documentKey}: ${deleteError.message}`,
    );
  }

  if (chunks.length === 0) {
    return 0;
  }

  const { error: insertError } = await supabase
    .schema('rag')
    .from('document_chunk')
    .insert(
      chunks.map((chunk, index) => ({
        document_id: documentId,
        chunk_index: index,
        chunk_key: `${documentKey}#${index}`,
        chunk_text: chunk,
        heading: index === 0 ? 'SDS content' : null,
        section_path: ['body'],
        metadata: {
          source: 'sds',
          strategy: 'char-window',
          max_chars: MAX_CHARS_PER_CHUNK,
          overlap_chars: CHUNK_OVERLAP_CHARS,
        },
      })),
    );

  if (insertError) {
    throw new Error(
      `Failed to insert chunks for ${documentKey}: ${insertError.message}`,
    );
  }

  return chunks.length;
}

async function markSourceRecord(
  sourceRecordId: string,
  seed: SdsSeedDocument,
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

async function ingestSeedDocument(seed: SdsSeedDocument) {
  const sourceRecordId = await ensureSeedSourceRecord(seed);

  try {
    const s3Client = getS3Client();
    const s3Object = await s3Client.send(
      new GetObjectCommand({
        Bucket: getS3Bucket(),
        Key: seed.s3Key,
      }),
    );
    const bytes = await s3Object.Body?.transformToByteArray();
    if (!bytes) {
      throw new Error(`S3 object body was empty for key ${seed.s3Key}.`);
    }
    const fileBuffer = Buffer.from(bytes);
    const checksum = computeChecksum(fileBuffer);
    const parsed = await parsePdf(fileBuffer);
    const documentId = await upsertDocument(sourceRecordId, seed, parsed.text);
    const chunkCount = await replaceDocumentChunks(
      documentId,
      toDocumentKey(seed),
      parsed.text,
    );

    await markSourceRecord(sourceRecordId, seed, {
      status: 'ingested',
      checksum,
      chunkCount,
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

async function loadSdsDocumentRows() {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('rag')
    .from('document')
    .select('id, source_record_id, title, updated_at, metadata')
    .eq('document_kind', DOCUMENT_KIND);

  if (error) {
    throw new Error(`Failed to load SDS documents: ${error.message}`);
  }

  return (data ?? []) as DocumentRow[];
}

function sortStatusRows(rows: SdsDashboardDocument[]) {
  const statusWeight: Record<SdsDashboardDocumentStatus, number> = {
    failed: 0,
    missing: 1,
    registered: 2,
    ingested: 3,
  };

  return [...rows].sort((left, right) => {
    const weightDifference =
      statusWeight[left.status] - statusWeight[right.status];
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

function toDashboardStatus(rows: SdsDashboardDocument[]): SdsDashboardStatus {
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
      embeddedLargeChunks: 0,
      pendingLargeChunks: 0,
    },
    preview: {
      showing: visibleRows.length,
      hidden: Math.max(0, rows.length - visibleRows.length),
    },
    warning: null,
    documents: visibleRows,
  };
}

function toFallbackStatus(message: string): SdsDashboardStatus {
  return {
    totals: {
      seeded: 0,
      registered: 0,
      ingested: 0,
      failed: 0,
      chunks: 0,
      embeddedChunks: 0,
      pendingChunks: 0,
      embeddedLargeChunks: 0,
      pendingLargeChunks: 0,
    },
    preview: {
      showing: 0,
      hidden: 0,
    },
    warning: message,
    documents: [],
  };
}

type SdsChunkCounts = {
  chunks: number;
  embeddedChunks: number;
  pendingChunks: number;
  embeddedLargeChunks: number;
  pendingLargeChunks: number;
};

async function loadSdsChunkEmbeddingTotals(): Promise<SdsChunkCounts> {
  const supabase = getSupabaseServiceRoleClient();
  const rag = supabase.schema('rag');

  const [
    { count: totalCount, error: totalError },
    { count: embeddedCount, error: embeddedError },
    { count: embeddedLargeCount, error: embeddedLargeError },
  ] = await Promise.all([
    rag
      .from('document_chunk')
      .select('id', { count: 'exact', head: true })
      .like('chunk_key', 'sds:%'),
    rag
      .from('document_chunk')
      .select('id', { count: 'exact', head: true })
      .like('chunk_key', 'sds:%')
      .not('embedding', 'is', null),
    (rag.from('document_chunk') as unknown as {
      select(cols: string, opts: { count: 'exact'; head: true }): {
        like(col: string, val: string): {
          not(col: string, op: string, val: null): Promise<{ count: number | null; error: { message: string } | null }>;
        };
      };
    })
      .select('id', { count: 'exact', head: true })
      .like('chunk_key', 'sds:%')
      .not('embedding_large', 'is', null),
  ]);

  if (totalError) {
    throw new Error(`Failed to count SDS chunks: ${totalError.message}`);
  }

  if (embeddedError) {
    throw new Error(`Failed to count embedded SDS chunks: ${embeddedError.message}`);
  }

  if (embeddedLargeError) {
    throw new Error(`Failed to count large-embedded SDS chunks: ${embeddedLargeError.message}`);
  }

  const total = totalCount ?? 0;
  const embedded = embeddedCount ?? 0;
  const embeddedLarge = embeddedLargeCount ?? 0;

  return {
    chunks: total,
    embeddedChunks: embedded,
    pendingChunks: total - embedded,
    embeddedLargeChunks: embeddedLarge,
    pendingLargeChunks: total - embeddedLarge,
  };
}

async function withSdsChunkEmbeddingTotals(
  status: SdsDashboardStatus,
): Promise<SdsDashboardStatus> {
  try {
    const totals = await loadSdsChunkEmbeddingTotals();
    return {
      ...status,
      totals: {
        ...status.totals,
        chunks: totals.chunks,
        embeddedChunks: totals.embeddedChunks,
        pendingChunks: totals.pendingChunks,
        embeddedLargeChunks: totals.embeddedLargeChunks,
        pendingLargeChunks: totals.pendingLargeChunks,
      },
    };
  } catch {
    return status;
  }
}

async function fallbackStatusFromExistingRecords(message: string) {
  const [sourceRecords, documents] = await Promise.all([
    getExistingSdsSourceRecords(),
    loadSdsDocumentRows(),
  ]);

  if (sourceRecords.length === 0) {
    return toFallbackStatus(message);
  }

  const documentBySourceRecordId = new Map(
    documents.map((row) => [row.source_record_id, row]),
  );

  const rows: SdsDashboardDocument[] = sourceRecords.map((source) => {
    const metadata = asSdsMetadata(source.metadata);
    const document = documentBySourceRecordId.get(source.id) ?? null;
    const metadataChunkCount = metadata?.chunk_count;
    const chunkCount =
      typeof metadataChunkCount === 'number' && Number.isFinite(metadataChunkCount)
        ? metadataChunkCount
        : 0;
    const metadataStatus = metadata?.status ?? null;

    let status: SdsDashboardDocumentStatus = 'registered';
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

  return withSdsChunkEmbeddingTotals({
    ...toDashboardStatus(rows),
    warning: message,
  });
}

async function getSdsStatusRows(seedDocuments: SdsSeedDocument[]) {
  const [sourceRecords, documents] = await Promise.all([
    getExistingSdsSourceRecords(),
    loadSdsDocumentRows(),
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
    const metadata = asSdsMetadata(source?.metadata ?? null);
    const metadataChunkCount = metadata?.chunk_count;
    const chunkCount =
      typeof metadataChunkCount === 'number' &&
      Number.isFinite(metadataChunkCount)
        ? metadataChunkCount
        : 0;
    const metadataStatus = metadata?.status ?? null;

    let status: SdsDashboardDocumentStatus = 'missing';
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
    } satisfies SdsDashboardDocument;
  });
}

export async function getSdsDashboardStatus(): Promise<SdsDashboardStatus> {
  try {
    const seedDocuments = await discoverSdsSeedDocuments();
    const rows = await getSdsStatusRows(seedDocuments);
    return await withSdsChunkEmbeddingTotals(toDashboardStatus(rows));
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'Unknown S3 discovery failure.';
    const message = `S3 discovery is unavailable right now (${reason}). Showing last known SDS records.`;
    try {
      return await fallbackStatusFromExistingRecords(message);
    } catch {
      return await withSdsChunkEmbeddingTotals(toFallbackStatus(message));
    }
  }
}

export async function runSdsIngestion(
  mode: SdsIngestionRunMode,
  batchSize?: number,
): Promise<SdsIngestionRunResult> {
  const startedAt = nowIso();
  const errors: SdsIngestionRunResult['errors'] = [];
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let status: SdsDashboardStatus;

  if (mode === 'register-seed') {
    const seedDocuments = await discoverSdsSeedDocuments();
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
    status = await withSdsChunkEmbeddingTotals(
      toDashboardStatus(await getSdsStatusRows(seedDocuments)),
    );
  } else if (mode === 'embed-next' || mode === 'embed-all') {
    let runCount = 0;

    while (runCount < MAX_EMBEDDING_RUNS) {
      const embedResult = await syncDocumentChunkEmbeddings({
        batchSize,
        maxBatches: mode === 'embed-next' ? 1 : 20,
        documentKind: DOCUMENT_KIND,
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
      'S3 discovery was skipped for embedding-only SDS action.',
    );
  } else if (mode === 'embed-next-large' || mode === 'embed-all-large') {
    let runCount = 0;

    while (runCount < MAX_EMBEDDING_RUNS) {
      const embedResult = await syncDocumentChunkEmbeddingsLarge({
        batchSize,
        maxBatches: mode === 'embed-next-large' ? 1 : 20,
        documentKind: DOCUMENT_KIND,
      });

      runCount += 1;
      processed += embedResult.chunksEmbedded;
      succeeded += embedResult.chunksEmbedded;

      if (
        mode === 'embed-next-large' ||
        embedResult.remainingChunks === 0 ||
        embedResult.chunksEmbedded === 0
      ) {
        break;
      }
    }
    status = await fallbackStatusFromExistingRecords(
      'S3 discovery was skipped for embedding-only SDS action.',
    );
  } else {
    const seedDocuments = await discoverSdsSeedDocuments();
    const seedById = new Map(seedDocuments.map((seed) => [seed.id, seed]));
    const rows = await getSdsStatusRows(seedDocuments);
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
    status = await withSdsChunkEmbeddingTotals(
      toDashboardStatus(await getSdsStatusRows(seedDocuments)),
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
