import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

import { syncDocumentChunkEmbeddings } from '~/lib/rag/embeddings';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import type { Json as RagJson } from '~/types/supabase.rag';

import {
  KNOWLEDGE_FILE_OVERRIDES,
  KNOWLEDGE_FOLDER_SPECIALIST,
  KNOWLEDGE_S3_BUCKET_DEFAULT,
  KNOWLEDGE_S3_PREFIX_DEFAULT,
  type KnowledgeDocType,
  type KnowledgeSeedDocument,
  type KnowledgeSpecialist,
} from './manifest';

const SOURCE_SCHEMA = 'knowledge';
const SOURCE_TABLE = 'file';
const SOURCE_TYPE = 's3_markdown';
const DOCUMENT_KIND = 'knowledge';
const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 25;
const MAX_EMBEDDING_RUNS = 25;
const MAX_DASHBOARD_DOCUMENT_ROWS = 300;
const CHUNK_CHAR_BUDGET = 3200; // ~800 tokens

type JsonObject = { [key: string]: RagJson | undefined };

export type KnowledgeIngestionRunMode =
  | 'register-seed'
  | 'ingest-next'
  | 'ingest-all'
  | 'retry-failed'
  | 'embed-next'
  | 'embed-all';

type KnowledgeDocumentStatus = 'missing' | 'registered' | 'ingested' | 'failed';

export type KnowledgeDashboardDocument = {
  id: string;
  title: string;
  specialist: KnowledgeSpecialist;
  docType: KnowledgeDocType;
  s3Key: string;
  status: KnowledgeDocumentStatus;
  sourceRecordId: string | null;
  documentId: string | null;
  chunkCount: number;
  updatedAt: string | null;
  lastError: string | null;
};

export type KnowledgeDashboardStatus = {
  totals: {
    seeded: number;
    registered: number;
    ingested: number;
    failed: number;
    chunks: number;
    embeddedChunks: number;
    pendingChunks: number;
  };
  preview: { showing: number; hidden: number };
  warning: string | null;
  documents: KnowledgeDashboardDocument[];
};

export type KnowledgeIngestionRunResult = {
  mode: KnowledgeIngestionRunMode;
  processed: number;
  succeeded: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
  errors: Array<{ id: string; message: string }>;
  status: KnowledgeDashboardStatus;
};

// --------------------------------------------------------------------------
// S3 (retool-360, us-east-1). Read creds prefer AWS_360_READ_*, fall back to
// AWS_360_WRITE_* (the keys lib/tests/storage.ts already uses for uploads).
// --------------------------------------------------------------------------
function getS3Bucket() {
  return process.env.KNOWLEDGE_S3_BUCKET?.trim() || KNOWLEDGE_S3_BUCKET_DEFAULT;
}

function getS3Prefix() {
  const prefix = process.env.KNOWLEDGE_S3_PREFIX?.trim() || KNOWLEDGE_S3_PREFIX_DEFAULT;
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

function getAwsCredentials() {
  // Prefer the documented AWS_360_* keys, then fall back to the generic read
  // keys actually configured in .env.local (AWS_ACCESS_READ_KEY_ID /
  // AWS_SECRET_READ_ACCESS_KEY) — the same retool-360 read credentials.
  const accessKeyId =
    process.env.AWS_360_READ_ACCESS_KEY_ID?.trim() ||
    process.env.AWS_360_WRITE_ACCESS_KEY_ID?.trim() ||
    process.env.AWS_ACCESS_READ_KEY_ID?.trim();
  const secretAccessKey =
    process.env.AWS_360_READ_SECRET_ACCESS_KEY?.trim() ||
    process.env.AWS_360_WRITE_SECRET_ACCESS_KEY?.trim() ||
    process.env.AWS_SECRET_READ_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey };
}

function getS3Client() {
  const region = process.env.AWS_360_REGION?.trim() || process.env.AWS_REGION?.trim() || 'us-east-1';
  const credentials = getAwsCredentials();
  return new S3Client({ region, ...(credentials ? { credentials } : {}) });
}

async function listS3MarkdownKeys(client: S3Client, bucket: string, prefix: string) {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    for (const item of page.Contents ?? []) {
      const key = item.Key?.trim();
      if (!key || key.endsWith('/')) continue;
      if (extname(key).toLowerCase() === '.md') keys.push(key);
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  keys.sort((a, b) => a.localeCompare(b));
  return keys;
}

// --------------------------------------------------------------------------
// Metadata inference
// --------------------------------------------------------------------------
function normalizeRelativePath(value: string) {
  return value.replaceAll('\\', '/').toLowerCase();
}

function keyToRelativePath(s3Key: string, prefix: string) {
  return prefix && s3Key.startsWith(prefix) ? s3Key.slice(prefix.length) : s3Key;
}

function inferSpecialist(relativePath: string): KnowledgeSpecialist {
  const topFolder = relativePath.split('/')[0] ?? '';
  return KNOWLEDGE_FOLDER_SPECIALIST[topFolder] ?? 'general';
}

function inferDocType(fileName: string): KnowledgeDocType {
  const f = fileName.toLowerCase();
  if (f.includes('troubleshoot') || f.includes('complaint')) return 'troubleshooting';
  if (f.includes('faq')) return 'faq';
  if (f.includes('glossary')) return 'glossary';
  if (f.includes('workbook') || f.includes('_full')) return 'workbook';
  if (f.includes('how') || f.includes('guide') || f.includes('procedure') || f.includes('video'))
    return 'howto';
  return 'general';
}

function inferTitle(fileNameWithoutExt: string) {
  const normalized = fileNameWithoutExt
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return normalized || fileNameWithoutExt;
}

function stripFrontmatter(raw: string): { body: string; frontTitle: string | null } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { body: raw, frontTitle: null };
  const titleMatch = match[1].match(/^title:\s*(.+)$/m);
  const frontTitle = titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, '') : null;
  return { body: raw.slice(match[0].length), frontTitle };
}

function markdownToPlainText(md: string) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function summarize(text: string) {
  return text.length <= 280 ? text : `${text.slice(0, 277).trim()}...`;
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

// --------------------------------------------------------------------------
// Heading-aware chunking (B0-190 seed). Splits on markdown headings, keeps a
// breadcrumb section_path, and further splits oversized sections by paragraph.
// --------------------------------------------------------------------------
type KnowledgeChunk = {
  index: number;
  heading: string | null;
  sectionPath: string[];
  text: string;
};

function chunkMarkdown(body: string): KnowledgeChunk[] {
  const lines = body.split('\n');
  const sections: Array<{ heading: string | null; path: string[]; lines: string[] }> = [];
  const headingStack: Array<{ level: number; text: string }> = [];
  let current: { heading: string | null; path: string[]; lines: string[] } = {
    heading: null,
    path: [],
    lines: [],
  };

  const pushCurrent = () => {
    if (current.lines.join('').trim().length > 0 || current.heading) sections.push(current);
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      pushCurrent();
      const level = h[1].length;
      const text = h[2].trim();
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level)
        headingStack.pop();
      headingStack.push({ level, text });
      current = { heading: text, path: headingStack.map((x) => x.text), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  pushCurrent();

  const chunks: KnowledgeChunk[] = [];
  let index = 0;
  for (const section of sections) {
    const text = section.lines.join('\n').trim();
    if (!text && !section.heading) continue;

    if (text.length <= CHUNK_CHAR_BUDGET) {
      chunks.push({ index: index++, heading: section.heading, sectionPath: section.path, text });
      continue;
    }
    // Oversized section: split by blank-line paragraphs into <= budget windows.
    const paras = text.split(/\n{2,}/);
    let buf = '';
    for (const para of paras) {
      if (buf && buf.length + para.length + 2 > CHUNK_CHAR_BUDGET) {
        chunks.push({ index: index++, heading: section.heading, sectionPath: section.path, text: buf.trim() });
        buf = '';
      }
      buf = buf ? `${buf}\n\n${para}` : para;
    }
    if (buf.trim()) {
      chunks.push({ index: index++, heading: section.heading, sectionPath: section.path, text: buf.trim() });
    }
  }
  return chunks;
}

// --------------------------------------------------------------------------
// Seed discovery
// --------------------------------------------------------------------------
async function discoverKnowledgeSeedDocuments(): Promise<KnowledgeSeedDocument[]> {
  const bucket = getS3Bucket();
  const prefix = getS3Prefix();
  const client = getS3Client();
  const keys = await listS3MarkdownKeys(client, bucket, prefix);

  return keys.map((s3Key) => {
    const relativePath = normalizeRelativePath(keyToRelativePath(s3Key, prefix));
    const fileName = basename(s3Key);
    const fileNameWithoutExt = fileName.slice(0, -extname(fileName).length);
    const override = KNOWLEDGE_FILE_OVERRIDES[relativePath];
    return {
      id: createHash('sha1').update(s3Key).digest('hex').slice(0, 20),
      title: override?.title || inferTitle(fileNameWithoutExt),
      specialist: override?.specialist || inferSpecialist(relativePath),
      docType: override?.docType || inferDocType(fileName),
      productLineKey: override?.productLineKey ?? null,
      s3Key,
    } satisfies KnowledgeSeedDocument;
  });
}

function toSourcePk(seed: KnowledgeSeedDocument) {
  return seed.id;
}
function toDocumentKey(seed: KnowledgeSeedDocument) {
  return `knowledge:${seed.id}`;
}
function toSourceUri(seed: KnowledgeSeedDocument) {
  return `s3://${getS3Bucket()}/${seed.s3Key}`;
}
function nowIso() {
  return new Date().toISOString();
}
function clampBatchSize(batchSize?: number) {
  if (!Number.isFinite(batchSize) || !batchSize || batchSize < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.floor(batchSize), MAX_BATCH_SIZE);
}

function buildSourceMetadata(seed: KnowledgeSeedDocument, overrides: JsonObject): JsonObject {
  return {
    ingestion: {
      s3_key: seed.s3Key,
      source_uri: toSourceUri(seed),
      title: seed.title,
      specialist: seed.specialist,
      doc_type: seed.docType,
      product_line_key: seed.productLineKey,
      ...overrides,
    },
  };
}

// --------------------------------------------------------------------------
// DB writes (service role — bypasses RLS)
// --------------------------------------------------------------------------
async function ensureSeedSourceRecord(seed: KnowledgeSeedDocument) {
  const supabase = getSupabaseServiceRoleClient();
  const sourcePk = toSourcePk(seed);
  const timestamp = nowIso();
  const metadata = buildSourceMetadata(seed, { status: 'registered', last_attempt_at: timestamp, last_error: null });

  const { data: existing } = await supabase
    .schema('rag')
    .from('source_record')
    .select('id')
    .eq('source_schema', SOURCE_SCHEMA)
    .eq('source_table', SOURCE_TABLE)
    .eq('source_type', SOURCE_TYPE)
    .eq('source_pk', sourcePk)
    .maybeSingle();

  if (existing?.id) {
    const { error } = await supabase
      .schema('rag')
      .from('source_record')
      .update({ is_active: true, source_uri: toSourceUri(seed), metadata, last_seen_at: timestamp })
      .eq('id', existing.id);
    if (error) throw new Error(`Failed to update source record ${sourcePk}: ${error.message}`);
    return existing.id;
  }

  const { data: inserted, error } = await supabase
    .schema('rag')
    .from('source_record')
    .insert({
      source_schema: SOURCE_SCHEMA,
      source_table: SOURCE_TABLE,
      source_type: SOURCE_TYPE,
      source_pk: sourcePk,
      source_locale: 'EN',
      source_uri: toSourceUri(seed),
      is_active: true,
      metadata,
      last_seen_at: timestamp,
    })
    .select('id')
    .single();
  if (error || !inserted?.id) throw new Error(`Failed to insert source record ${sourcePk}: ${error?.message ?? 'unknown'}`);
  return inserted.id;
}

async function upsertDocument(
  sourceRecordId: string,
  seed: KnowledgeSeedDocument,
  rawMarkdown: string,
  plainText: string,
) {
  const supabase = getSupabaseServiceRoleClient();
  const documentKey = toDocumentKey(seed);
  const metadata: JsonObject = {
    source: 'knowledge',
    s3_key: seed.s3Key,
    source_uri: toSourceUri(seed),
    specialist: seed.specialist,
    doc_type: seed.docType,
    product_line_key: seed.productLineKey,
  };

  const { data: existing } = await supabase
    .schema('rag')
    .from('document')
    .select('id')
    .eq('document_key', documentKey)
    .maybeSingle();

  const payload = {
    source_record_id: sourceRecordId,
    entity_id: null as string | null,
    title: seed.title,
    language_code: 'EN',
    body_text: plainText,
    body_markdown: rawMarkdown,
    summary: summarize(plainText),
    document_kind: DOCUMENT_KIND,
    metadata,
  };

  if (existing?.id) {
    const { error } = await supabase.schema('rag').from('document').update(payload).eq('id', existing.id);
    if (error) throw new Error(`Failed to update document ${documentKey}: ${error.message}`);
    return existing.id;
  }

  const { data: inserted, error } = await supabase
    .schema('rag')
    .from('document')
    .insert({ ...payload, document_key: documentKey })
    .select('id')
    .single();
  if (error || !inserted?.id) throw new Error(`Failed to insert document ${documentKey}: ${error?.message ?? 'unknown'}`);
  return inserted.id;
}

async function replaceDocumentChunks(documentId: string, seed: KnowledgeSeedDocument, chunks: KnowledgeChunk[]) {
  const supabase = getSupabaseServiceRoleClient();
  // Clear prior chunks for idempotent re-ingest, then insert fresh.
  const { error: delError } = await supabase
    .schema('rag')
    .from('document_chunk')
    .delete()
    .eq('document_id', documentId);
  if (delError) throw new Error(`Failed to clear chunks for ${documentId}: ${delError.message}`);

  if (chunks.length === 0) return 0;

  const rows = chunks.map((c) => ({
    chunk_key: `knowledge:${seed.id}:${c.index}`,
    document_id: documentId,
    chunk_index: c.index,
    section_path: c.sectionPath,
    heading: c.heading,
    chunk_text: c.text,
    token_count: estimateTokens(c.text),
    metadata: { specialist: seed.specialist, doc_type: seed.docType } as JsonObject,
  }));

  const { error } = await supabase.schema('rag').from('document_chunk').insert(rows);
  if (error) throw new Error(`Failed to insert chunks for ${documentId}: ${error.message}`);
  return rows.length;
}

async function markSourceRecord(
  sourceRecordId: string,
  seed: KnowledgeSeedDocument,
  params: { status: 'registered' | 'ingested' | 'failed'; chunkCount?: number; lastError?: string | null },
) {
  const supabase = getSupabaseServiceRoleClient();
  const timestamp = nowIso();
  const { error } = await supabase
    .schema('rag')
    .from('source_record')
    .update({
      metadata: buildSourceMetadata(seed, {
        status: params.status,
        chunk_count: params.chunkCount,
        parsed_at: params.status === 'ingested' ? timestamp : undefined,
        last_attempt_at: timestamp,
        last_error: params.lastError ?? null,
      }),
      last_seen_at: timestamp,
      is_active: true,
    })
    .eq('id', sourceRecordId);
  if (error) throw new Error(`Failed to update source status for ${seed.id}: ${error.message}`);
}

async function ingestSeedDocument(seed: KnowledgeSeedDocument) {
  const sourceRecordId = await ensureSeedSourceRecord(seed);
  try {
    const s3 = getS3Client();
    const obj = await s3.send(new GetObjectCommand({ Bucket: getS3Bucket(), Key: seed.s3Key }));
    const raw = await obj.Body?.transformToString('utf-8');
    if (!raw) throw new Error(`S3 object body was empty for key ${seed.s3Key}.`);

    const { body, frontTitle } = stripFrontmatter(raw);
    const effectiveSeed = frontTitle ? { ...seed, title: frontTitle } : seed;
    const plain = markdownToPlainText(body);
    const documentId = await upsertDocument(sourceRecordId, effectiveSeed, body, plain);
    const chunkCount = await replaceDocumentChunks(documentId, effectiveSeed, chunkMarkdown(body));

    await markSourceRecord(sourceRecordId, effectiveSeed, { status: 'ingested', chunkCount, lastError: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected ingestion failure.';
    await markSourceRecord(sourceRecordId, seed, { status: 'failed', lastError: message });
    throw error;
  }
}

// --------------------------------------------------------------------------
// Status dashboard
// --------------------------------------------------------------------------
type SourceRow = { id: string; source_pk: string; metadata: JsonObject | null; updated_at: string };
type DocRow = { id: string; source_record_id: string; updated_at: string };

function asIngestion(metadata: JsonObject | null) {
  const ing = metadata && typeof metadata === 'object' ? (metadata as JsonObject).ingestion : null;
  return (ing && typeof ing === 'object' ? (ing as JsonObject) : null) ?? null;
}
function asString(v: unknown) {
  return typeof v === 'string' && v.trim() ? v : null;
}

async function loadState() {
  const supabase = getSupabaseServiceRoleClient();
  const [{ data: sources }, { data: docs }, { data: chunkDocs }] = await Promise.all([
    supabase
      .schema('rag')
      .from('source_record')
      .select('id, source_pk, metadata, updated_at')
      .eq('source_schema', SOURCE_SCHEMA)
      .eq('source_table', SOURCE_TABLE)
      .eq('source_type', SOURCE_TYPE),
    supabase.schema('rag').from('document').select('id, source_record_id, updated_at').eq('document_kind', DOCUMENT_KIND),
    // Real per-document chunk counts so "ingested" reflects actual chunks, not the
    // source's mutable metadata.ingestion.status (which register-seed resets). The
    // knowledge corpus is well under the 1000-row default cap; only the per-row chunk
    // count column would undercount past that, never the ingested/registered status.
    supabase.schema('rag').from('document_chunk').select('document_id').like('chunk_key', 'knowledge:%'),
  ]);
  const chunkCountByDoc = new Map<string, number>();
  for (const row of (chunkDocs ?? []) as { document_id: string | null }[]) {
    if (row.document_id) chunkCountByDoc.set(row.document_id, (chunkCountByDoc.get(row.document_id) ?? 0) + 1);
  }
  return {
    sources: (sources ?? []) as SourceRow[],
    docs: (docs ?? []) as DocRow[],
    chunkCountByDoc,
  };
}

async function loadChunkTotals() {
  const supabase = getSupabaseServiceRoleClient();
  const rag = supabase.schema('rag');
  const [{ count: total }, { count: embedded }] = await Promise.all([
    rag.from('document_chunk').select('id', { count: 'exact', head: true }).like('chunk_key', 'knowledge:%'),
    (rag.from('document_chunk') as unknown as {
      select(c: string, o: { count: 'exact'; head: true }): {
        like(col: string, val: string): { not(col: string, op: string, val: null): Promise<{ count: number | null }> };
      };
    })
      .select('id', { count: 'exact', head: true })
      .like('chunk_key', 'knowledge:%')
      .not('embedding_large', 'is', null),
  ]);
  const chunks = total ?? 0;
  const embeddedChunks = embedded ?? 0;
  return { chunks, embeddedChunks, pendingChunks: chunks - embeddedChunks };
}

function buildDocumentRow(
  seed: KnowledgeSeedDocument,
  source: SourceRow | null,
  doc: DocRow | null,
  chunkCount: number,
): KnowledgeDashboardDocument {
  const ingestion = asIngestion(source?.metadata ?? null);
  const metaStatus = asString(ingestion?.status);
  let status: KnowledgeDocumentStatus = 'missing';
  if (metaStatus === 'failed') status = 'failed';
  // A linked document with chunks means ingest succeeded — even if a later
  // register-seed reset the source's mutable metadata status back to 'registered'.
  else if (metaStatus === 'ingested' || (doc && chunkCount > 0)) status = 'ingested';
  else if (source) status = 'registered';
  return {
    id: seed.id,
    title: seed.title,
    specialist: seed.specialist,
    docType: seed.docType,
    s3Key: seed.s3Key,
    status,
    sourceRecordId: source?.id ?? null,
    documentId: doc?.id ?? null,
    chunkCount,
    updatedAt: doc?.updated_at ?? source?.updated_at ?? null,
    lastError: asString(ingestion?.last_error),
  };
}

function toDashboard(rows: KnowledgeDashboardDocument[], warning: string | null): KnowledgeDashboardStatus {
  const visible = rows.slice(0, MAX_DASHBOARD_DOCUMENT_ROWS);
  return {
    totals: {
      seeded: rows.length,
      registered: rows.filter((r) => r.status !== 'missing').length,
      ingested: rows.filter((r) => r.status === 'ingested').length,
      failed: rows.filter((r) => r.status === 'failed').length,
      chunks: 0,
      embeddedChunks: 0,
      pendingChunks: 0,
    },
    preview: { showing: visible.length, hidden: Math.max(0, rows.length - visible.length) },
    warning,
    documents: visible,
  };
}

async function withChunkTotals(status: KnowledgeDashboardStatus): Promise<KnowledgeDashboardStatus> {
  try {
    const totals = await loadChunkTotals();
    return { ...status, totals: { ...status.totals, ...totals } };
  } catch {
    return status;
  }
}

async function statusRows(seeds: KnowledgeSeedDocument[]) {
  const { sources, docs, chunkCountByDoc } = await loadState();
  const sourceByPk = new Map(sources.map((s) => [s.source_pk, s]));
  const docBySource = new Map(docs.map((d) => [d.source_record_id, d]));
  return seeds.map((seed) => {
    const source = sourceByPk.get(toSourcePk(seed)) ?? null;
    const doc = source ? (docBySource.get(source.id) ?? null) : null;
    const chunkCount = doc ? (chunkCountByDoc.get(doc.id) ?? 0) : 0;
    return buildDocumentRow(seed, source, doc, chunkCount);
  });
}

export async function getKnowledgeDashboardStatus(): Promise<KnowledgeDashboardStatus> {
  try {
    const seeds = await discoverKnowledgeSeedDocuments();
    return await withChunkTotals(toDashboard(await statusRows(seeds), null));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown S3 discovery failure.';
    return await withChunkTotals(
      toDashboard(
        [],
        `S3 discovery unavailable (${reason}). Configure AWS_360_READ_* (or AWS_ACCESS_READ_KEY_ID / AWS_SECRET_READ_ACCESS_KEY) for reads on retool-360.`,
      ),
    );
  }
}

// --------------------------------------------------------------------------
// Run modes
// --------------------------------------------------------------------------
export async function runKnowledgeIngestion(
  mode: KnowledgeIngestionRunMode,
  batchSize?: number,
): Promise<KnowledgeIngestionRunResult> {
  const startedAt = nowIso();
  const errors: KnowledgeIngestionRunResult['errors'] = [];
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let status: KnowledgeDashboardStatus;

  if (mode === 'embed-next' || mode === 'embed-all') {
    let runCount = 0;
    while (runCount < MAX_EMBEDDING_RUNS) {
      const res = await syncDocumentChunkEmbeddings({
        batchSize,
        maxBatches: mode === 'embed-next' ? 1 : 20,
        documentKind: DOCUMENT_KIND,
      });
      runCount += 1;
      processed += res.chunksEmbedded;
      succeeded += res.chunksEmbedded;
      if (mode === 'embed-next' || res.remainingChunks === 0 || res.chunksEmbedded === 0) break;
    }
    status = await withChunkTotals(toDashboard(await statusRows(await discoverKnowledgeSeedDocuments()), null));
  } else if (mode === 'register-seed') {
    const seeds = await discoverKnowledgeSeedDocuments();
    for (const seed of seeds) {
      processed += 1;
      try {
        await ensureSeedSourceRecord(seed);
        succeeded += 1;
      } catch (error) {
        failed += 1;
        errors.push({ id: seed.id, message: error instanceof Error ? error.message : 'Registration failed.' });
      }
    }
    status = await withChunkTotals(toDashboard(await statusRows(seeds), null));
  } else {
    const seeds = await discoverKnowledgeSeedDocuments();
    const seedById = new Map(seeds.map((s) => [s.id, s]));
    const rows = await statusRows(seeds);
    let candidates = rows.filter((r) => r.status !== 'ingested');
    if (mode === 'retry-failed') candidates = rows.filter((r) => r.status === 'failed');
    if (mode === 'ingest-next') candidates = candidates.slice(0, clampBatchSize(batchSize));

    for (const candidate of candidates) {
      const seed = seedById.get(candidate.id);
      if (!seed) continue;
      processed += 1;
      try {
        await ingestSeedDocument(seed);
        succeeded += 1;
      } catch (error) {
        failed += 1;
        errors.push({ id: seed.id, message: error instanceof Error ? error.message : 'Ingestion failed.' });
      }
    }
    status = await withChunkTotals(toDashboard(await statusRows(seeds), null));
  }

  return { mode, processed, succeeded, failed, startedAt, finishedAt: nowIso(), errors, status };
}
