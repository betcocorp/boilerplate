import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import yaml from 'js-yaml';
import { basename, extname } from 'node:path';

import { syncDocumentChunkEmbeddings } from '~/lib/rag/embeddings';
import {
  chunkMarkdown,
  estimateTokens,
  markdownToPlainText,
  summarize,
} from '~/lib/rag/markdown-chunking';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import type { Json as RagJson } from '~/types/supabase.rag';

import {
  LABEL_FILE_OVERRIDES,
  LABEL_FOLDER_BRAND,
  LABEL_S3_BUCKET_DEFAULT,
  LABEL_S3_PREFIX_DEFAULT,
  type LabelBrand,
  type LabelSeedDocument,
} from './manifest';

// Matches the identity already established by the Path B entity/fact bootstrap
// (label-md/_rag_import) — this pipeline extends those rows rather than
// creating a parallel keying scheme.
const SOURCE_SCHEMA = 'label_md';
const SOURCE_TYPE = 'label';
const SOURCE_LOCALE = 'en';
const DOCUMENT_KIND = 'label';
const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const MAX_EMBEDDING_RUNS = 25;
const MAX_DASHBOARD_DOCUMENT_ROWS = 900;

type JsonObject = { [key: string]: RagJson | undefined };

export type LabelIngestionRunMode =
  | 'register-seed'
  | 'ingest-next'
  | 'ingest-all'
  | 'retry-failed'
  | 'embed-next'
  | 'embed-all';

type LabelDocumentStatus = 'missing' | 'registered' | 'ingested' | 'failed';

export type LabelDashboardDocument = {
  id: string;
  title: string;
  brand: LabelBrand;
  sku: string | null;
  s3Key: string;
  status: LabelDocumentStatus;
  sourceRecordId: string | null;
  documentId: string | null;
  chunkCount: number;
  updatedAt: string | null;
  lastError: string | null;
};

export type LabelDashboardStatus = {
  totals: {
    seeded: number;
    registered: number;
    ingested: number;
    failed: number;
    chunks: number;
    embeddedChunks: number;
    pendingChunks: number;
    linkedToEntity: number;
  };
  preview: { showing: number; hidden: number };
  warning: string | null;
  documents: LabelDashboardDocument[];
};

export type LabelIngestionRunResult = {
  mode: LabelIngestionRunMode;
  processed: number;
  succeeded: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
  errors: Array<{ id: string; message: string }>;
  status: LabelDashboardStatus;
};

// --------------------------------------------------------------------------
// S3 (retool-360, us-east-1) — same bucket/creds as the knowledge panel.
// --------------------------------------------------------------------------
function getS3Bucket() {
  return process.env.LABEL_S3_BUCKET?.trim() || LABEL_S3_BUCKET_DEFAULT;
}

function getS3Prefix() {
  const prefix = process.env.LABEL_S3_PREFIX?.trim() || LABEL_S3_PREFIX_DEFAULT;
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

function getAwsCredentials() {
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
// Metadata inference (cheap, filename-only — full accuracy comes from
// frontmatter read at ingest time, same pattern as the knowledge panel).
// --------------------------------------------------------------------------
function keyToRelativePath(s3Key: string, prefix: string) {
  return prefix && s3Key.startsWith(prefix) ? s3Key.slice(prefix.length) : s3Key;
}

function inferBrand(relativePath: string): LabelBrand | null {
  const topFolder = relativePath.split('/')[0]?.toLowerCase() ?? '';
  return LABEL_FOLDER_BRAND[topFolder] ?? null;
}

/** File stems follow "<sku>_<slug>.md" (e.g. "07512_kling.md"). */
function inferSkuAndTitle(fileNameWithoutExt: string): { sku: string | null; title: string } {
  const match = fileNameWithoutExt.match(/^([A-Za-z0-9]+)_(.+)$/);
  if (!match) return { sku: null, title: inferTitleFromSlug(fileNameWithoutExt) };
  return { sku: match[1], title: inferTitleFromSlug(match[2]) };
}

function inferTitleFromSlug(slug: string) {
  const normalized = slug
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return normalized || slug;
}

type LabelFrontmatter = {
  sku?: string;
  brand?: string;
  product?: string;
  sub_name?: string;
  epa_reg_no?: string | null;
  din_no?: string | null;
  sds_number?: string | null;
  needs_review?: boolean;
  extraction_method?: string;
};

function parseLabelMd(raw: string): { fm: LabelFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error('No YAML frontmatter block found.');
  const fm = (yaml.load(match[1]) ?? {}) as LabelFrontmatter;
  return { fm, body: match[2] ?? '' };
}

/**
 * Strips the leading "# Title" line and lead paragraph, replacing them with a
 * synthesized identity block (Product/Brand/SKU/EPA reg/DIN) so the Overview
 * chunk is self-contained without duplicating the H1 verbatim.
 */
function buildDocumentBody(fm: LabelFrontmatter, rawBody: string): string {
  const lines = rawBody.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.startsWith('# '));
  const rest = idx === -1 ? lines : lines.slice(idx + 1);

  const identity = [
    `Product: ${fm.product ?? 'Unknown product'}${fm.sub_name ? ` — ${fm.sub_name}` : ''}`,
    `Brand: ${fm.brand ?? 'Unknown'}`,
    fm.sku ? `SKU: ${fm.sku}` : null,
    fm.epa_reg_no ? `EPA Reg. No.: ${fm.epa_reg_no}` : null,
    fm.din_no ? `DIN: ${fm.din_no}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return `${identity}\n\n${rest.join('\n').trim()}`.trim();
}

// --------------------------------------------------------------------------
// Seed discovery
// --------------------------------------------------------------------------
async function discoverLabelSeedDocuments(): Promise<LabelSeedDocument[]> {
  const bucket = getS3Bucket();
  const prefix = getS3Prefix();
  const client = getS3Client();
  const keys = await listS3MarkdownKeys(client, bucket, prefix);

  const seeds: LabelSeedDocument[] = [];
  for (const s3Key of keys) {
    const relativePath = keyToRelativePath(s3Key, prefix);
    const brand = inferBrand(relativePath);
    if (!brand) continue; // unrecognized top-level folder — skip rather than mis-key

    const fileName = basename(s3Key);
    const fileNameWithoutExt = fileName.slice(0, -extname(fileName).length);
    const { sku, title } = inferSkuAndTitle(fileNameWithoutExt);
    const override = LABEL_FILE_OVERRIDES[relativePath.toLowerCase()];

    seeds.push({
      id: fileNameWithoutExt,
      title: override?.title || title,
      brand: override?.brand || brand,
      sku: override?.sku ?? sku,
      s3Key,
      labelMdPath: relativePath,
    });
  }
  return seeds;
}

function toSourcePk(seed: LabelSeedDocument) {
  return seed.id;
}
function toDocumentKey(seed: LabelSeedDocument, brand: LabelBrand) {
  return `label_md:${brand}:${seed.id}:en`;
}
function toSourceUri(seed: LabelSeedDocument) {
  return `s3://${getS3Bucket()}/${seed.s3Key}`;
}
function nowIso() {
  return new Date().toISOString();
}
function clampBatchSize(batchSize?: number) {
  if (!Number.isFinite(batchSize) || !batchSize || batchSize < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.floor(batchSize), MAX_BATCH_SIZE);
}

function buildSourceMetadata(seed: LabelSeedDocument, overrides: JsonObject): JsonObject {
  return {
    ingestion: {
      s3_key: seed.s3Key,
      source_uri: toSourceUri(seed),
      title: seed.title,
      brand: seed.brand,
      sku: seed.sku,
      label_md_path: seed.labelMdPath,
      ...overrides,
    },
  };
}

// --------------------------------------------------------------------------
// DB writes (service role — bypasses RLS)
// --------------------------------------------------------------------------
async function ensureSeedSourceRecord(seed: LabelSeedDocument) {
  const supabase = getSupabaseServiceRoleClient();
  const sourcePk = toSourcePk(seed);
  const timestamp = nowIso();
  const metadata = buildSourceMetadata(seed, { status: 'registered', last_attempt_at: timestamp, last_error: null });

  const { data: existing } = await supabase
    .schema('rag')
    .from('source_record')
    .select('id, source_table')
    .eq('source_schema', SOURCE_SCHEMA)
    .eq('source_pk', sourcePk)
    .eq('source_locale', SOURCE_LOCALE)
    .maybeSingle();

  if (existing?.id) {
    const { error } = await supabase
      .schema('rag')
      .from('source_record')
      .update({ is_active: true, source_uri: toSourceUri(seed), metadata, last_seen_at: timestamp })
      .eq('id', existing.id);
    if (error) throw new Error(`Failed to update source record ${sourcePk}: ${error.message}`);
    return { id: existing.id, sourceTable: existing.source_table as LabelBrand };
  }

  const { data: inserted, error } = await supabase
    .schema('rag')
    .from('source_record')
    .insert({
      source_schema: SOURCE_SCHEMA,
      source_table: seed.brand,
      source_type: SOURCE_TYPE,
      source_pk: sourcePk,
      source_locale: SOURCE_LOCALE,
      source_uri: toSourceUri(seed),
      is_active: true,
      metadata,
      last_seen_at: timestamp,
    })
    .select('id, source_table')
    .single();
  if (error || !inserted?.id) throw new Error(`Failed to insert source record ${sourcePk}: ${error?.message ?? 'unknown'}`);
  return { id: inserted.id, sourceTable: inserted.source_table as LabelBrand };
}

async function findEntityId(labelMdPath: string): Promise<string | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema('rag')
    .from('entity')
    .select('id')
    .eq('entity_type', 'product')
    .filter('metadata->>label_md_path', 'eq', labelMdPath)
    .maybeSingle();
  if (error) return null;
  return data?.id ?? null;
}

async function upsertDocument(
  sourceRecordId: string,
  entityId: string | null,
  documentKey: string,
  seed: LabelSeedDocument,
  fm: LabelFrontmatter,
  rawMarkdown: string,
  bodyText: string,
) {
  const supabase = getSupabaseServiceRoleClient();
  const metadata: JsonObject = {
    source: 'label_md',
    s3_key: seed.s3Key,
    source_uri: toSourceUri(seed),
    brand: fm.brand ?? seed.brand,
    sku: fm.sku ?? seed.sku,
    label_md_path: seed.labelMdPath,
    epa_reg_no: fm.epa_reg_no ?? null,
    din_no: fm.din_no ?? null,
    sds_number: fm.sds_number ?? null,
    needs_review: fm.needs_review ?? null,
    extraction_method: fm.extraction_method ?? null,
  };

  const title = `${fm.product ?? seed.title}${fm.sub_name ? ` — ${fm.sub_name}` : ''}`;

  const { data: existing } = await supabase
    .schema('rag')
    .from('document')
    .select('id')
    .eq('document_key', documentKey)
    .maybeSingle();

  const payload = {
    source_record_id: sourceRecordId,
    entity_id: entityId,
    title,
    language_code: 'EN',
    body_text: bodyText,
    body_markdown: rawMarkdown,
    summary: summarize(bodyText),
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

async function replaceDocumentChunks(
  documentId: string,
  documentKey: string,
  fm: LabelFrontmatter,
  seed: LabelSeedDocument,
  chunks: ReturnType<typeof chunkMarkdown>,
) {
  const supabase = getSupabaseServiceRoleClient();
  const { error: delError } = await supabase
    .schema('rag')
    .from('document_chunk')
    .delete()
    .eq('document_id', documentId);
  if (delError) throw new Error(`Failed to clear chunks for ${documentId}: ${delError.message}`);

  if (chunks.length === 0) return 0;

  const rows = chunks.map((c) => ({
    chunk_key: `${documentKey}:${c.index}`,
    document_id: documentId,
    chunk_index: c.index,
    section_path: c.sectionPath,
    heading: c.heading,
    chunk_text: c.text,
    token_count: estimateTokens(c.text),
    metadata: { brand: fm.brand ?? seed.brand, sku: fm.sku ?? seed.sku } as JsonObject,
  }));

  const { error } = await supabase.schema('rag').from('document_chunk').insert(rows);
  if (error) throw new Error(`Failed to insert chunks for ${documentId}: ${error.message}`);
  return rows.length;
}

async function markSourceRecord(
  sourceRecordId: string,
  seed: LabelSeedDocument,
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

async function ingestSeedDocument(seed: LabelSeedDocument) {
  const { id: sourceRecordId, sourceTable } = await ensureSeedSourceRecord(seed);
  try {
    const s3 = getS3Client();
    const obj = await s3.send(new GetObjectCommand({ Bucket: getS3Bucket(), Key: seed.s3Key }));
    const raw = await obj.Body?.transformToString('utf-8');
    if (!raw) throw new Error(`S3 object body was empty for key ${seed.s3Key}.`);

    const { fm, body } = parseLabelMd(raw);
    const documentKey = toDocumentKey(seed, sourceTable);
    // body_markdown keeps the true, unmodified source (post-frontmatter) for
    // display. Chunking and the plain-text search field both derive from the
    // identity-enriched version (H1 replaced by a Product/Brand/SKU block) so
    // the Overview chunk is self-contained without duplicating the H1 verbatim.
    const bodyForChunking = buildDocumentBody(fm, body);
    const plainText = markdownToPlainText(bodyForChunking);
    const entityId = await findEntityId(seed.labelMdPath);

    const documentId = await upsertDocument(sourceRecordId, entityId, documentKey, seed, fm, body, plainText);
    const chunkCount = await replaceDocumentChunks(documentId, documentKey, fm, seed, chunkMarkdown(bodyForChunking));

    await markSourceRecord(sourceRecordId, seed, { status: 'ingested', chunkCount, lastError: null });
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
type DocRow = { id: string; source_record_id: string; entity_id: string | null; updated_at: string };

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
      .eq('source_type', SOURCE_TYPE),
    supabase
      .schema('rag')
      .from('document')
      .select('id, source_record_id, entity_id, updated_at')
      .eq('document_kind', DOCUMENT_KIND),
    supabase.schema('rag').from('document_chunk').select('document_id').like('chunk_key', 'label_md:%'),
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
    rag.from('document_chunk').select('id', { count: 'exact', head: true }).like('chunk_key', 'label_md:%'),
    (rag.from('document_chunk') as unknown as {
      select(c: string, o: { count: 'exact'; head: true }): {
        like(col: string, val: string): { not(col: string, op: string, val: null): Promise<{ count: number | null }> };
      };
    })
      .select('id', { count: 'exact', head: true })
      .like('chunk_key', 'label_md:%')
      .not('embedding_large', 'is', null),
  ]);
  const chunks = total ?? 0;
  const embeddedChunks = embedded ?? 0;
  return { chunks, embeddedChunks, pendingChunks: chunks - embeddedChunks };
}

function buildDocumentRow(
  seed: LabelSeedDocument,
  source: SourceRow | null,
  doc: DocRow | null,
  chunkCount: number,
): LabelDashboardDocument {
  const ingestion = asIngestion(source?.metadata ?? null);
  const metaStatus = asString(ingestion?.status);
  let status: LabelDocumentStatus = 'missing';
  if (metaStatus === 'failed') status = 'failed';
  else if (metaStatus === 'ingested' || (doc && chunkCount > 0)) status = 'ingested';
  else if (source) status = 'registered';
  return {
    id: seed.id,
    title: seed.title,
    brand: seed.brand,
    sku: seed.sku,
    s3Key: seed.s3Key,
    status,
    sourceRecordId: source?.id ?? null,
    documentId: doc?.id ?? null,
    chunkCount,
    updatedAt: doc?.updated_at ?? source?.updated_at ?? null,
    lastError: asString(ingestion?.last_error),
  };
}

function toDashboard(
  rows: LabelDashboardDocument[],
  linkedToEntity: number,
  warning: string | null,
): LabelDashboardStatus {
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
      linkedToEntity,
    },
    preview: { showing: visible.length, hidden: Math.max(0, rows.length - visible.length) },
    warning,
    documents: visible,
  };
}

async function withChunkTotals(status: LabelDashboardStatus): Promise<LabelDashboardStatus> {
  try {
    const totals = await loadChunkTotals();
    return { ...status, totals: { ...status.totals, ...totals } };
  } catch {
    return status;
  }
}

async function statusRows(seeds: LabelSeedDocument[]) {
  const { sources, docs, chunkCountByDoc } = await loadState();
  const sourceByPk = new Map(sources.map((s) => [s.source_pk, s]));
  const docBySource = new Map(docs.map((d) => [d.source_record_id, d]));
  const rows = seeds.map((seed) => {
    const source = sourceByPk.get(toSourcePk(seed)) ?? null;
    const doc = source ? (docBySource.get(source.id) ?? null) : null;
    const chunkCount = doc ? (chunkCountByDoc.get(doc.id) ?? 0) : 0;
    return buildDocumentRow(seed, source, doc, chunkCount);
  });
  const linkedToEntity = docs.filter((d) => d.entity_id != null).length;
  return { rows, linkedToEntity };
}

export async function getLabelDashboardStatus(): Promise<LabelDashboardStatus> {
  try {
    const seeds = await discoverLabelSeedDocuments();
    const { rows, linkedToEntity } = await statusRows(seeds);
    return await withChunkTotals(toDashboard(rows, linkedToEntity, null));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown S3 discovery failure.';
    return await withChunkTotals(
      toDashboard(
        [],
        0,
        `S3 discovery unavailable (${reason}). Configure AWS_360_READ_* (or AWS_ACCESS_READ_KEY_ID / AWS_SECRET_READ_ACCESS_KEY) for reads on retool-360.`,
      ),
    );
  }
}

// --------------------------------------------------------------------------
// Run modes
// --------------------------------------------------------------------------
export async function runLabelIngestion(
  mode: LabelIngestionRunMode,
  batchSize?: number,
): Promise<LabelIngestionRunResult> {
  const startedAt = nowIso();
  const errors: LabelIngestionRunResult['errors'] = [];
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let status: LabelDashboardStatus;

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
    const seeds = await discoverLabelSeedDocuments();
    const { rows, linkedToEntity } = await statusRows(seeds);
    status = await withChunkTotals(toDashboard(rows, linkedToEntity, null));
  } else if (mode === 'register-seed') {
    const seeds = await discoverLabelSeedDocuments();
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
    const { rows, linkedToEntity } = await statusRows(seeds);
    status = await withChunkTotals(toDashboard(rows, linkedToEntity, null));
  } else {
    const seeds = await discoverLabelSeedDocuments();
    const seedById = new Map(seeds.map((s) => [s.id, s]));
    const { rows } = await statusRows(seeds);
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
    const { rows: finalRows, linkedToEntity } = await statusRows(seeds);
    status = await withChunkTotals(toDashboard(finalRows, linkedToEntity, null));
  }

  return { mode, processed, succeeded, failed, startedAt, finishedAt: nowIso(), errors, status };
}
