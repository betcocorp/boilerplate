/**
 * B0-797 — Re-ingests the hygiene/skin-care efficacy markdown after
 * scripts/convert-efficacy-hygiene-pdfs.mjs has republished it to S3.
 *
 * Why a script and not the /admin/efficacy panel: the shared S3 ingestion
 * pipeline (src/lib/rag/s3-ingestion-pipeline.ts) only ingests documents whose
 * status is not already 'ingested', so it has no path for "the S3 object changed,
 * re-read it". It also never chunks — chunking is rag.sync_efficacy_chunks
 * (B0-228), which only picks up documents that currently have ZERO chunks.
 * So a re-conversion needs: update document -> delete its stale chunks ->
 * drain sync_efficacy_chunks -> embed.
 *
 * Everything here matches the pipeline's contracts exactly so the admin panel
 * keeps working afterwards:
 *   document_key   = 'efficacy:' + sha1(s3Key).slice(0,20)   (toDocumentKey)
 *   body_markdown  = the S3 object verbatim
 *   body_text      = markdownToPlainText(body_markdown)
 *   summary        = summarize(body_text)  (280 chars)
 *   token_count    = ceil(len/4)
 *
 * PRESERVED, NOT REBUILT: rag.document.entity_id and metadata.formula_code from
 * B0-232's backfill. The pipeline's upsert replaces metadata wholesale, which
 * would drop formula_code; this script merges instead, and never touches
 * entity_id or is_current (is_current is B0-796's).
 *
 * Idempotent: a document whose S3 checksum already matches and that already has
 * more than one chunk is skipped unless --force.
 *
 * Usage:
 *   node scripts/reingest-efficacy-hygiene-md.mjs --dry-run
 *   node scripts/reingest-efficacy-hygiene-md.mjs --write [--skip-embeddings]
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const __dir = dirname(fileURLToPath(import.meta.url));

try {
  for (const line of readFileSync(resolve(__dir, '../.env.local'), 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1).trim();
  }
} catch {
  // already exported
}

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const FORCE = args.includes('--force');
const SKIP_EMBEDDINGS = args.includes('--skip-embeddings');

const BUCKET = 'retool-360';
const MD_PREFIX = 'efficacy/markdown/hygiene-skin-care/';
const DOCUMENT_KIND = 'efficacy';
const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMENSIONS = 3072;

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

function getS3() {
  const region = process.env.AWS_360_REGION?.trim() || 'us-east-1';
  const accessKeyId = process.env.AWS_360_READ_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_360_READ_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) throw new Error('Missing AWS_360_READ_* credentials.');
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// --- mirrors src/lib/rag/markdown-chunking.ts -------------------------------
const markdownToPlainText = (md) =>
  md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
const summarize = (text, maxLength = 280) =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength - 3).trim()}...`;
const estimateTokens = (text) => Math.max(1, Math.ceil(text.length / 4));
// --- mirrors s3-ingestion-pipeline.ts toDocumentKey -------------------------
const toDocumentKey = (s3Key) =>
  `${DOCUMENT_KIND}:${createHash('sha1').update(s3Key).digest('hex').slice(0, 20)}`;

async function listMdKeys(s3) {
  const keys = [];
  let ContinuationToken;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: MD_PREFIX, ContinuationToken }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key?.endsWith('.md')) keys.push(obj.Key);
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys.sort();
}

async function getMarkdown(s3, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  return { text: buffer.toString('utf8'), checksum: createHash('sha256').update(buffer).digest('hex') };
}

async function embedPendingEfficacyChunks(supabase, openai) {
  const batchSize = 25;
  let total = 0;
  let inputTokens = 0;
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
    if (error) throw new Error(`Failed to load pending efficacy chunks: ${error.message}`);
    if (!chunks || chunks.length === 0) break;

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: chunks.map((chunk) =>
        chunk.heading?.trim()
          ? `Heading: ${chunk.heading.trim()}\n\n${chunk.chunk_text.trim()}`
          : chunk.chunk_text.trim(),
      ),
    });
    inputTokens += response.usage?.prompt_tokens ?? 0;

    for (const [index, chunk] of chunks.entries()) {
      const embedding = response.data[index]?.embedding;
      if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Bad embedding for ${chunk.chunk_key}`);
      }
      const { error: updateError } = await supabase
        .schema('rag')
        .from('document_chunk')
        .update({
          embedding_large: `[${embedding.join(',')}]`,
          embedding_model_large: EMBEDDING_MODEL,
        })
        .eq('id', chunk.id);
      if (updateError) throw new Error(`Failed to persist embedding: ${updateError.message}`);
    }
    total += chunks.length;
    log(`  embedded ${total} chunks…`);
  }
  return { total, inputTokens };
}

async function main() {
  const s3 = getS3();
  const supabase = getSupabase();

  const keys = await listMdKeys(s3);
  log(`${keys.length} hygiene/skin-care markdown objects in S3.`);

  const { data: documents, error: docError } = await supabase
    .schema('rag')
    .from('document')
    .select('id, document_key, title, entity_id, metadata, source_record_id')
    .eq('document_kind', DOCUMENT_KIND);
  if (docError) throw new Error(`Failed to load efficacy documents: ${docError.message}`);
  const byKey = new Map(documents.map((doc) => [doc.document_key, doc]));

  let updated = 0;
  let skipped = 0;
  const missing = [];
  const touchedIds = [];

  for (const key of keys) {
    const documentKey = toDocumentKey(key);
    const doc = byKey.get(documentKey);
    if (!doc) {
      missing.push(key);
      continue;
    }

    const { text, checksum } = await getMarkdown(s3, key);
    const { count: chunkCount } = await supabase
      .schema('rag')
      .from('document_chunk')
      .select('id', { count: 'exact', head: true })
      .eq('document_id', doc.id);

    const { data: sourceRecord } = await supabase
      .schema('rag')
      .from('source_record')
      .select('id, checksum')
      .eq('id', doc.source_record_id)
      .maybeSingle();

    if (!FORCE && sourceRecord?.checksum === checksum && (chunkCount ?? 0) > 1) {
      skipped += 1;
      continue;
    }

    const bodyText = markdownToPlainText(text);
    // Merge, never replace: B0-232's formula_code lives here and entity_id is
    // never in this payload, so both survive.
    const metadata = { ...(doc.metadata ?? {}), source: DOCUMENT_KIND, s3_key: key };

    if (!WRITE) {
      log(
        `[dry-run] ${key.slice(MD_PREFIX.length)} — md ${text.length} chars, body_text ${bodyText.length} chars, ${chunkCount ?? 0} existing chunk(s), formula_code=${metadata.formula_code ?? 'null'}`,
      );
      updated += 1;
      continue;
    }

    const { error: updateError } = await supabase
      .schema('rag')
      .from('document')
      .update({
        body_markdown: text,
        body_text: bodyText,
        summary: summarize(bodyText),
        token_count: estimateTokens(bodyText),
        metadata,
      })
      .eq('id', doc.id);
    if (updateError) throw new Error(`document update failed for ${key}: ${updateError.message}`);

    const { error: deleteError } = await supabase
      .schema('rag')
      .from('document_chunk')
      .delete()
      .eq('document_id', doc.id);
    if (deleteError) throw new Error(`chunk delete failed for ${key}: ${deleteError.message}`);

    const { error: sourceError } = await supabase
      .schema('rag')
      .from('source_record')
      .update({ checksum, last_seen_at: new Date().toISOString() })
      .eq('id', doc.source_record_id);
    if (sourceError) throw new Error(`source_record update failed for ${key}: ${sourceError.message}`);

    touchedIds.push(doc.id);
    updated += 1;
  }

  log(`${updated} document(s) ${WRITE ? 'updated' : 'would be updated'}, ${skipped} unchanged, ${missing.length} with no matching rag.document row.`);
  for (const key of missing) log(`  NO DOCUMENT ROW: ${key}`);

  if (!WRITE) {
    log('Dry run — no writes, no chunking, no embeddings.');
    return;
  }

  log('Draining rag.sync_efficacy_chunks…');
  for (let round = 0; round < 25; round += 1) {
    const { data, error } = await supabase.schema('rag').rpc('sync_efficacy_chunks', {
      p_language_code: 'EN',
    });
    if (error) throw new Error(`sync_efficacy_chunks failed: ${error.message}`);
    log(`  ${JSON.stringify(data)}`);
    if (!data?.has_more) break;
  }

  if (SKIP_EMBEDDINGS) {
    log('Skipping embeddings (--skip-embeddings).');
    return;
  }

  log('Embedding pending efficacy chunks…');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { total, inputTokens } = await embedPendingEfficacyChunks(supabase, openai);
  // text-embedding-3-large list price, USD per 1M input tokens (2026-09).
  log(`Embedded ${total} chunks (${inputTokens} input tokens, ~$${((inputTokens / 1e6) * 0.13).toFixed(4)}).`);
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
