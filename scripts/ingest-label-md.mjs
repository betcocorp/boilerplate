/**
 * Ingests the curated Betco/EnviroZyme/Basic Coatings/1950-Brands label-md
 * corpus (s3://retool-360/labels/<brand>/*.md) into the RAG corpus as
 * document_kind='label' documents + chunks, then embeds pending chunks.
 *
 * This is a standalone, idempotent, one-time/rerunnable batch job — it does
 * NOT go through the Next.js app (unlike scripts/run-rag-pipeline.mjs, which
 * calls HTTP routes). It talks to Supabase + S3 + OpenAI directly, reusing
 * the same rag.chunk_document_text() RPC and text-embedding-3-large model
 * the rest of the corpus uses, so chunking/embeddings stay consistent.
 *
 * Usage:
 *   node scripts/ingest-label-md.mjs [--limit N] [--dry-run] [--skip-embeddings]
 *
 * Env (from .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   AWS_360_READ_ACCESS_KEY_ID, AWS_360_READ_SECRET_ACCESS_KEY, AWS_360_REGION,
 *   OPENAI_API_KEY.
 *
 * After this completes, add 'label' to requiredDocumentKinds in
 * src/lib/retrieval/product-knowledge.ts (done alongside this script) so the
 * new document_kind gets a guaranteed retrieval slot, not just opportunistic
 * ranked recall.
 */

import { readFileSync } from 'fs';
import { resolve, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';

import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import yaml from 'js-yaml';
import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Load .env.local (same loader as run-rag-pipeline.mjs)
// ---------------------------------------------------------------------------
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, '../.env.local');
try {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // already set in environment
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_EMBEDDINGS = args.includes('--skip-embeddings');
const limitArgIdx = args.indexOf('--limit');
const LIMIT = limitArgIdx !== -1 ? Number(args[limitArgIdx + 1]) : null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const BUCKET = 'retool-360';
const PREFIX = 'labels/';
const DOCUMENT_KIND = 'label';
const SOURCE_SCHEMA = 'label_md';
const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMENSIONS = 3072;

function getS3Client() {
  const region = process.env.AWS_360_REGION?.trim() || 'us-east-1';
  const accessKeyId = process.env.AWS_360_READ_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_360_READ_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Missing AWS_360_READ_ACCESS_KEY_ID / AWS_360_READ_SECRET_ACCESS_KEY in .env.local');
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in .env.local');
  return new OpenAI({ apiKey });
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// S3 discovery
// ---------------------------------------------------------------------------
async function listLabelMdKeys(s3) {
  const keys = [];
  let ContinuationToken;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key && extname(obj.Key) === '.md') keys.push(obj.Key);
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

// ---------------------------------------------------------------------------
// Frontmatter + body parsing
// ---------------------------------------------------------------------------
function parseLabelMd(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error('No YAML frontmatter block found');
  }
  const fm = yaml.load(match[1]) ?? {};
  const body = match[2] ?? '';
  return { fm, body };
}

/**
 * Converts the label-md body (markdown ## headings with trailing HTML
 * comments) into the plain "Heading:\nbody" convention rag.chunk_document_text
 * expects (regex: ^[A-Za-z][A-Za-z0-9 /&()_-]*:$), and prepends a synthesized
 * overview block carrying key identifying facts so chunk 0 is self-contained.
 */
function buildBodyText(fm, body) {
  const lines = body.split(/\r?\n/);
  const overviewLines = [];
  const convertedLines = [];
  let sawFirstHeading = false;
  let sawH1 = false;

  const headingRe = /^##\s+(.+?)\s*(?:<!--.*-->)?\s*$/;

  for (const rawLine of lines) {
    const h2 = rawLine.match(headingRe);
    if (h2) {
      sawFirstHeading = true;
      const headingText = h2[1].trim().replace(/[^A-Za-z0-9 /&()_-]/g, '').trim();
      convertedLines.push(`${headingText}:`);
      continue;
    }
    if (!sawFirstHeading) {
      // Still in the pre-heading intro area (H1 title + lead paragraph).
      if (!sawH1 && rawLine.startsWith('# ')) {
        sawH1 = true;
        continue; // title is already captured via fm.product below
      }
      overviewLines.push(rawLine);
    } else {
      convertedLines.push(rawLine);
    }
  }

  const overviewHeader = [
    `Product: ${fm.product ?? 'Unknown product'}${fm.sub_name ? ' — ' + fm.sub_name : ''}`,
    `Brand: ${fm.brand ?? 'Unknown'}`,
    fm.sku ? `SKU: ${fm.sku}` : null,
    fm.epa_reg_no ? `EPA Reg. No.: ${fm.epa_reg_no}` : null,
    fm.din_no ? `DIN: ${fm.din_no}` : null,
  ].filter(Boolean).join('\n');

  const overviewBody = overviewLines.join('\n').trim();
  const overview = overviewBody ? `${overviewHeader}\n\n${overviewBody}` : overviewHeader;

  return `${overview}\n\n${convertedLines.join('\n').trim()}`.trim();
}

function brandFromKey(key) {
  // labels/<brand>/<file>.md
  const parts = key.split('/');
  return parts.length >= 3 ? parts[1] : 'unknown';
}

function fileStem(key) {
  return basename(key, extname(key));
}

// ---------------------------------------------------------------------------
// Supabase upserts
// ---------------------------------------------------------------------------
async function findOrCreateSourceRecord(supabase, { brandFolder, stem, s3Key }) {
  const { data: existing, error: findErr } = await supabase
    .schema('rag')
    .from('source_record')
    .select('id, source_table')
    .eq('source_schema', SOURCE_SCHEMA)
    .eq('source_pk', stem)
    .eq('source_locale', 'en')
    .maybeSingle();

  if (findErr) throw new Error(`source_record lookup failed for ${stem}: ${findErr.message}`);
  if (existing) return existing;

  const sourceTable = brandFolder.replace(/-/g, '_');
  const { data: inserted, error: insErr } = await supabase
    .schema('rag')
    .from('source_record')
    .insert({
      source_schema: SOURCE_SCHEMA,
      source_table: sourceTable,
      source_pk: stem,
      source_locale: 'en',
      source_type: 'label',
      source_uri: `s3://${BUCKET}/${s3Key}`,
      is_active: true,
      metadata: { brand: brandFolder, s3_key: s3Key },
    })
    .select('id, source_table')
    .single();

  if (insErr) throw new Error(`source_record insert failed for ${stem}: ${insErr.message}`);
  return inserted;
}

async function findEntityId(supabase, labelMdPath) {
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

async function upsertDocument(supabase, params) {
  const { documentKey, sourceRecordId, entityId, title, bodyMarkdown, bodyText, metadata } = params;

  const { data: existing, error: findErr } = await supabase
    .schema('rag')
    .from('document')
    .select('id')
    .eq('document_key', documentKey)
    .maybeSingle();
  if (findErr) throw new Error(`document lookup failed for ${documentKey}: ${findErr.message}`);

  const row = {
    document_key: documentKey,
    source_record_id: sourceRecordId,
    entity_id: entityId,
    document_kind: DOCUMENT_KIND,
    title,
    language_code: 'EN',
    body_text: bodyText,
    body_markdown: bodyMarkdown,
    metadata,
  };

  if (existing) {
    const { error: updErr } = await supabase
      .schema('rag')
      .from('document')
      .update(row)
      .eq('id', existing.id);
    if (updErr) throw new Error(`document update failed for ${documentKey}: ${updErr.message}`);
    return existing.id;
  }

  const { data: inserted, error: insErr } = await supabase
    .schema('rag')
    .from('document')
    .insert(row)
    .select('id')
    .single();
  if (insErr) throw new Error(`document insert failed for ${documentKey}: ${insErr.message}`);
  return inserted.id;
}

async function rechunkDocument(supabase, { documentId, documentKey, title, bodyText }) {
  const { data: chunks, error: rpcErr } = await supabase
    .schema('rag')
    .rpc('chunk_document_text', { p_body_text: bodyText, p_title: title });
  if (rpcErr) throw new Error(`chunk_document_text failed for ${documentKey}: ${rpcErr.message}`);

  const rows = (chunks ?? []).map((c) => ({
    chunk_key: `${documentKey}:chunk:${c.chunk_index}`,
    document_id: documentId,
    chunk_index: c.chunk_index,
    section_path: c.section_path,
    heading: c.heading,
    chunk_text: c.chunk_text,
    token_count: c.token_count,
    metadata: { document_kind: DOCUMENT_KIND, chunk_index: c.chunk_index, section_heading: c.heading },
  }));

  // Delete existing chunks for this document, then insert fresh ones — this
  // is a full batch job (not a live incremental sync), so a clean rebuild
  // per document is simplest and correctness-safe on reruns.
  const { error: delErr } = await supabase
    .schema('rag')
    .from('document_chunk')
    .delete()
    .eq('document_id', documentId);
  if (delErr) throw new Error(`chunk delete failed for ${documentKey}: ${delErr.message}`);

  if (rows.length === 0) return 0;

  const { error: insErr } = await supabase.schema('rag').from('document_chunk').insert(rows);
  if (insErr) throw new Error(`chunk insert failed for ${documentKey}: ${insErr.message}`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Embeddings (mirrors src/lib/rag/embeddings.ts syncDocumentChunkEmbeddings,
// scoped to document_kind='label', so behaviour matches the rest of the app)
// ---------------------------------------------------------------------------
function buildEmbeddingInput(chunk) {
  const heading = chunk.heading?.trim();
  const chunkText = chunk.chunk_text.trim();
  return heading ? `Heading: ${heading}\n\n${chunkText}` : chunkText;
}

function toVectorLiteral(embedding) {
  return `[${embedding.join(',')}]`;
}

async function embedPendingLabelChunks(supabase, openai) {
  const batchSize = 25;
  let totalEmbedded = 0;

  for (;;) {
    const { data: chunks, error } = await supabase
      .schema('rag')
      .from('document_chunk')
      .select('id, chunk_key, heading, chunk_text, document!inner(document_kind)')
      .eq('document.document_kind', DOCUMENT_KIND)
      .is('embedding_large', null)
      .not('chunk_text', 'is', null)
      .neq('chunk_text', '')
      .order('updated_at', { ascending: true })
      .limit(batchSize);

    if (error) throw new Error(`Failed to load pending label chunks: ${error.message}`);
    if (!chunks || chunks.length === 0) break;

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: chunks.map(buildEmbeddingInput),
    });

    const embeddings = response.data.map((d) => d.embedding);
    if (embeddings.length !== chunks.length) {
      throw new Error(`Expected ${chunks.length} embeddings, got ${embeddings.length}`);
    }

    for (const [i, chunk] of chunks.entries()) {
      const embedding = embeddings[i];
      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Embedding for ${chunk.chunk_key} had ${embedding.length} dims, expected ${EMBEDDING_DIMENSIONS}`);
      }
      const { error: updErr } = await supabase
        .schema('rag')
        .from('document_chunk')
        .update({ embedding_large: toVectorLiteral(embedding), embedding_model_large: EMBEDDING_MODEL })
        .eq('id', chunk.id);
      if (updErr) throw new Error(`Failed to persist embedding for ${chunk.chunk_key}: ${updErr.message}`);
    }

    totalEmbedded += chunks.length;
    log(`  Embedded ${totalEmbedded} chunks so far…`);

    if (chunks.length < batchSize) break;
  }

  return totalEmbedded;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const s3 = getS3Client();
  const supabase = getSupabase();

  log(`Listing s3://${BUCKET}/${PREFIX}…`);
  let keys = await listLabelMdKeys(s3);
  log(`Found ${keys.length} .md files.`);
  if (LIMIT) {
    keys = keys.slice(0, LIMIT);
    log(`--limit ${LIMIT}: processing first ${keys.length} files only.`);
  }

  let processed = 0;
  let totalChunks = 0;
  let failed = 0;

  for (const key of keys) {
    const brandFolder = brandFromKey(key);
    const stem = fileStem(key);
    const labelMdPath = key.slice(PREFIX.length); // "<brand>/<file>.md"

    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      const raw = await streamToString(res.Body);
      const { fm, body } = parseLabelMd(raw);
      const bodyText = buildBodyText(fm, body);
      const title = `${fm.product ?? stem}${fm.sub_name ? ' — ' + fm.sub_name : ''}`;

      if (DRY_RUN) {
        log(`[dry-run] ${labelMdPath} -> title="${title}" bodyText=${bodyText.length} chars`);
        processed += 1;
        continue;
      }

      const sourceRecord = await findOrCreateSourceRecord(supabase, { brandFolder, stem, s3Key: key });
      const entityId = await findEntityId(supabase, labelMdPath);
      const documentKey = `label_md:${sourceRecord.source_table}:${stem}:en`;

      const documentId = await upsertDocument(supabase, {
        documentKey,
        sourceRecordId: sourceRecord.id,
        entityId,
        title,
        bodyMarkdown: body,
        bodyText,
        metadata: {
          brand: fm.brand ?? brandFolder,
          sku: fm.sku ?? null,
          label_md_path: labelMdPath,
          needs_review: fm.needs_review ?? null,
          extraction_method: fm.extraction_method ?? null,
        },
      });

      const chunkCount = await rechunkDocument(supabase, { documentId, documentKey, title, bodyText });
      totalChunks += chunkCount;
      processed += 1;

      if (processed % 25 === 0) {
        log(`Processed ${processed}/${keys.length} documents (${totalChunks} chunks so far)…`);
      }
    } catch (err) {
      failed += 1;
      console.error(`FAILED: ${key}: ${err instanceof Error ? err.message : err}`);
    }
  }

  log(`Document/chunk sync complete: ${processed} processed, ${failed} failed, ${totalChunks} chunks upserted.`);

  if (DRY_RUN) {
    log('Dry run — skipping embeddings.');
    return;
  }

  if (SKIP_EMBEDDINGS) {
    log('Skipping embeddings (--skip-embeddings passed). Run again without the flag to embed.');
    return;
  }

  log('=== Embedding pending label chunks ===');
  const openai = getOpenAI();
  const embedded = await embedPendingLabelChunks(supabase, openai);
  log(`Embedded ${embedded} chunks. Done.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
