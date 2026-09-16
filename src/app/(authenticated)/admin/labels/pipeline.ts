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

// B0-259 — recurring label sync: the master corpus has no printed "source_year" marker
// and no extractor-version field existed anywhere in this pipeline before this ticket
// (verified live against rag.document.metadata for a sample of label docs). Change
// detection instead uses two markers:
//   1. S3 ETag (free from the LIST call, see listS3MarkdownKeys) as the "did the file on
//      S3 change" signal, stored in rag.source_record.checksum.
//   2. LABEL_EXTRACTOR_VERSION (bump this when the parsing/chunking logic below changes)
//      stamped into rag.document.metadata.extractor_ver -- lets a future code change force
//      re-processing of already-ingested, byte-identical files.
const LABEL_EXTRACTOR_VERSION = '1';

/** S3 ETags for non-multipart uploads are quoted MD5 hex; normalize for comparison only. */
function normalizeEtag(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^"|"$/g, '');
  return trimmed || null;
}

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
  // B0-544: document-level token estimate (rag.document.token_count).
  tokenCount: number | null;
  updatedAt: string | null;
  lastError: string | null;
  /** B0-259: true when the S3 ETag no longer matches the checksum captured at last ingest -- the master changed and this row needs re-sync even though status is still "ingested". */
  needsResync: boolean;
  /** B0-259: true when the label frontmatter's `needs_review` flag is set (low-confidence extraction). */
  needsReview: boolean;
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
    /** B0-259: ingested docs whose S3 master changed since last ingest (needsResync=true). */
    changed: number;
    /** B0-259: docs flagged needs_review in their label frontmatter. */
    needsReview: number;
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

type S3MarkdownListing = { key: string; etag: string | null; lastModifiedIso: string | null };

async function listS3MarkdownKeys(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<S3MarkdownListing[]> {
  const items: S3MarkdownListing[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    for (const item of page.Contents ?? []) {
      const key = item.Key?.trim();
      if (!key || key.endsWith('/')) continue;
      if (extname(key).toLowerCase() === '.md') {
        items.push({
          key,
          etag: normalizeEtag(item.ETag),
          lastModifiedIso: item.LastModified ? item.LastModified.toISOString() : null,
        });
      }
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  items.sort((a, b) => a.key.localeCompare(b.key));
  return items;
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
  const listing = await listS3MarkdownKeys(client, bucket, prefix);

  const seeds: LabelSeedDocument[] = [];
  for (const { key: s3Key, etag, lastModifiedIso } of listing) {
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
      etag,
      lastModifiedIso,
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
  ingestedBy: string | null,
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
    // B0-259: stamp the extractor version that produced this row. Bump
    // LABEL_EXTRACTOR_VERSION when parsing/chunking logic changes so a future sync run
    // can detect "extractor changed" even for a byte-identical S3 file.
    extractor_ver: LABEL_EXTRACTOR_VERSION,
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
    // B0-544: document-level token estimate, same ceil(length / 4) convention used
    // for document_chunk.token_count in replaceDocumentChunks below.
    token_count: estimateTokens(bodyText),
    metadata,
    // B0-1021: stamp whoever most recently triggered this ingestion/re-ingestion run.
    ingested_by: ingestedBy,
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
      // B0-259: persist the S3 ETag as the change-detection baseline for the NEXT sync
      // run's needsResync comparison (see buildDocumentRow). Only stamped on a
      // successful ingest -- a failed run keeps the last-known-good checksum.
      ...(params.status === 'ingested' ? { checksum: seed.etag } : {}),
      last_seen_at: timestamp,
      is_active: true,
    })
    .eq('id', sourceRecordId);
  if (error) throw new Error(`Failed to update source status for ${seed.id}: ${error.message}`);
}

async function ingestSeedDocument(seed: LabelSeedDocument, ingestedBy: string | null) {
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

    const documentId = await upsertDocument(
      sourceRecordId,
      entityId,
      documentKey,
      seed,
      fm,
      body,
      plainText,
      ingestedBy,
    );
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
type SourceRow = {
  id: string;
  source_pk: string;
  metadata: JsonObject | null;
  updated_at: string;
  checksum: string | null;
};
type DocRow = {
  id: string;
  source_record_id: string;
  entity_id: string | null;
  updated_at: string;
  metadata: JsonObject | null;
  token_count: number | null;
};

function isNeedsReview(metadata: JsonObject | null): boolean {
  return metadata != null && typeof metadata === 'object' && (metadata as JsonObject).needs_review === true;
}

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
      .select('id, source_pk, metadata, updated_at, checksum')
      .eq('source_schema', SOURCE_SCHEMA)
      .eq('source_type', SOURCE_TYPE),
    supabase
      .schema('rag')
      .from('document')
      .select('id, source_record_id, entity_id, updated_at, metadata, token_count')
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

  // B0-259: only meaningful once ingested (nothing to "re-sync" for a row that's never
  // been ingested) and only when we have BOTH a captured baseline checksum and a current
  // S3 etag to compare -- a null baseline means this row predates checksum tracking, so
  // treat it as up to date rather than forcing a mass re-ingest on first deploy of this
  // feature (the next real content change will establish the first real diff).
  const storedChecksum = normalizeEtag(source?.checksum ?? null);
  const currentEtag = normalizeEtag(seed.etag);
  const needsResync =
    status === 'ingested' && storedChecksum != null && currentEtag != null && storedChecksum !== currentEtag;

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
    tokenCount: doc?.token_count ?? null,
    updatedAt: doc?.updated_at ?? source?.updated_at ?? null,
    lastError: asString(ingestion?.last_error),
    needsResync,
    needsReview: isNeedsReview(doc?.metadata ?? null),
  };
}

function toDashboard(
  rows: LabelDashboardDocument[],
  linkedToEntity: number,
  warning: string | null,
): LabelDashboardStatus {
  const visible = rows.slice(0, MAX_DASHBOARD_DOCUMENT_ROWS);
  const changed = rows.filter((r) => r.needsResync).length;
  const needsReview = rows.filter((r) => r.needsReview).length;

  // B0-259 alerting (work item 3): the dashboard `warning` banner is the existing,
  // established alert surface for this pipeline (already used for "S3 discovery
  // unavailable" above) -- reused here rather than inventing a new notification
  // channel. A human visiting /admin/labels sees it immediately; see
  // maybeSendLabelSyncAlert() for the optional, explicitly-opt-in Sentry push alert.
  const alertParts: string[] = [];
  if (changed > 0) {
    alertParts.push(
      `${changed} label${changed === 1 ? '' : 's'} changed on S3 since last ingest — run "Ingest all pending" to re-sync.`,
    );
  }
  if (needsReview > 0) {
    alertParts.push(
      `${needsReview} label${needsReview === 1 ? '' : 's'} flagged needs_review (low-confidence extraction) — spot-check before relying on them for regulated claims.`,
    );
  }
  const combinedWarning = [warning, alertParts.join(' ') || null].filter(Boolean).join(' ') || null;

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
      changed,
      needsReview,
    },
    preview: { showing: visible.length, hidden: Math.max(0, rows.length - visible.length) },
    warning: combinedWarning,
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
  ingestedBy: string | null = null,
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
    // B0-259: "not yet ingested" OR "ingested but the S3 master changed since" -- this is
    // what makes ingest-next/ingest-all a genuine re-sync rather than a one-time backfill.
    let candidates = rows.filter((r) => r.status !== 'ingested' || r.needsResync);
    if (mode === 'retry-failed') candidates = rows.filter((r) => r.status === 'failed');
    if (mode === 'ingest-next') candidates = candidates.slice(0, clampBatchSize(batchSize));

    for (const candidate of candidates) {
      const seed = seedById.get(candidate.id);
      if (!seed) continue;
      processed += 1;
      try {
        await ingestSeedDocument(seed, ingestedBy);
        succeeded += 1;
      } catch (error) {
        failed += 1;
        errors.push({ id: seed.id, message: error instanceof Error ? error.message : 'Ingestion failed.' });
      }
    }
    const { rows: finalRows, linkedToEntity } = await statusRows(seeds);
    status = await withChunkTotals(toDashboard(finalRows, linkedToEntity, null));
  }

  await maybeSendLabelSyncAlert(status, mode);

  return { mode, processed, succeeded, failed, startedAt, finishedAt: nowIso(), errors, status };
}

// --------------------------------------------------------------------------
// B0-259 alerting (work item 3), part 2: optional push alert via Sentry.
//
// This is a NEW usage pattern for this codebase -- Sentry is otherwise only used via
// its Next.js auto-instrumentation (unhandled exceptions / request errors, see
// sentry.server.config.ts, src/instrumentation.ts), never via a manual
// `captureMessage` for a business-logic condition. It's gated behind an explicit env
// var so it can't start firing in production as a side effect of this change, and so
// whoever enables it can first confirm a Sentry alert rule exists for these messages
// (this repo does not manage Sentry alert-routing/Slack/email config, which lives in
// the Sentry project settings). The dashboard `warning` banner above is the primary,
// always-on alert surface and does not require this.
// --------------------------------------------------------------------------
function isLabelSyncSentryAlertEnabled() {
  return process.env.LABEL_SYNC_SENTRY_ALERTS === 'true';
}

async function maybeSendLabelSyncAlert(status: LabelDashboardStatus, mode: LabelIngestionRunMode) {
  if (!isLabelSyncSentryAlertEnabled()) return;
  const { changed, needsReview, failed } = status.totals;
  if (changed === 0 && needsReview === 0 && failed === 0) return;

  try {
    const Sentry = await import('@sentry/nextjs');
    Sentry.captureMessage('label_sync_alert', {
      level: 'warning',
      tags: { pipeline: 'label_ingestion', mode },
      extra: { changed, needsReview, failed, seeded: status.totals.seeded },
    });
  } catch {
    // Alerting is best-effort — never fail the sync run because the alert couldn't send.
  }
}
