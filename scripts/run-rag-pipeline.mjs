/**
 * Drives the full RAG pipeline rebuild via direct Supabase REST API calls.
 *
 * Usage:
 *   node scripts/run-rag-pipeline.mjs [step]
 *
 * Steps (default = all):
 *   docs       — sync product_line_profile documents (picks up view changes)
 *   chunks     — rechunk all updated documents
 *   embeddings — embed all pending chunks
 *   all        — all three in order (default)
 *
 * Environment variables read from .env.local (loaded automatically).
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Load .env.local
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

const RAG_SYNC_API_KEY = process.env.RAG_SYNC_API_KEY;

if (!RAG_SYNC_API_KEY) {
  console.error('Missing RAG_SYNC_API_KEY');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function fmtResult(data) {
  if (!data) return '(no data)';
  const keys = ['documents_processed', 'chunks_upserted', 'stale_chunks_deleted',
                 'source_records_upserted', 'remaining_documents', 'remaining_source_rows',
                 'has_more'];
  return keys
    .filter(k => data[k] !== undefined)
    .map(k => `${k}=${data[k]}`)
    .join('  ');
}

const BASE_URL = process.env.NEXTAUTH_URL || 'http://localhost:3000';
const AUTH_HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${RAG_SYNC_API_KEY}`,
};

async function callSyncRoute(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: '{}',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Step 1 — document sync
// ---------------------------------------------------------------------------
async function syncDocuments() {
  log('=== STEP 1: Document sync (product_line_profile) ===');
  let pass = 0;
  for (;;) {
    pass++;
    log(`  Pass ${pass}…`);
    const data = await callSyncRoute('/api/rag/docs/sync');
    log(`  ${fmtResult(data)}`);
    if (!data?.has_more) break;
  }
  log(`Document sync complete after ${pass} pass(es).`);
}

// ---------------------------------------------------------------------------
// Step 2 — chunk sync
// ---------------------------------------------------------------------------
async function syncChunks() {
  log('=== STEP 2: Chunk sync (product_line_profile) ===');
  let pass = 0;
  for (;;) {
    pass++;
    log(`  Pass ${pass}…`);
    const data = await callSyncRoute('/api/rag/chunks/sync');
    log(`  ${fmtResult(data)}`);
    if (!data?.has_more) break;
  }
  log(`Chunk sync complete after ${pass} pass(es).`);
}

// ---------------------------------------------------------------------------
// Step 3 — embedding sync (via the existing HTTP route)
// ---------------------------------------------------------------------------
async function syncEmbeddings() {
  log('=== STEP 3: Embedding sync ===');
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  const url = `${baseUrl}/api/rag/embeddings/sync`;

  let pass = 0;
  for (;;) {
    pass++;
    log(`  Pass ${pass}…`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RAG_SYNC_API_KEY}`,
      },
      body: JSON.stringify({ batchSize: 25, maxBatches: 4 }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`  HTTP ${res.status}: ${text}`);
      process.exit(1);
    }

    const data = await res.json();
    const embedded = data.chunksEmbedded ?? 0;
    const remaining = data.remainingChunks ?? 0;
    log(`  chunksEmbedded=${embedded}  remainingChunks=${remaining}`);

    if (remaining === 0 || embedded === 0) break;
  }
  log(`Embedding sync complete after ${pass} pass(es).`);
}

// ---------------------------------------------------------------------------
// Backfill — SDS section headings
// ---------------------------------------------------------------------------
async function backfillSdsHeadings() {
  log('=== BACKFILL: SDS section headings ===');
  let pass = 0;
  for (;;) {
    pass++;
    log(`  Pass ${pass}…`);
    const res = await fetch(`${BASE_URL}/api/rag/backfill/sds-headings`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: '{}',
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`  HTTP ${res.status}: ${text}`);
      process.exit(1);
    }
    const data = await res.json();
    log(`  chunksEnriched=${data.chunksEnriched}  remainingChunks=${data.remainingChunks}`);
    // Stop when no rows were enriched — remaining may never reach 0 for chunks
    // that contain no recognisable GHS section header pattern.
    if (!data?.hasMore || data.chunksEnriched === 0) break;
  }
  log(`SDS heading enrichment complete after ${pass} pass(es).`);
}

// ---------------------------------------------------------------------------
// Backfill — token counts for SDS chunks
// ---------------------------------------------------------------------------
async function backfillTokenCounts() {
  log('=== BACKFILL: token_count for SDS chunks ===');
  let pass = 0;
  for (;;) {
    pass++;
    log(`  Pass ${pass}…`);
    const res = await fetch(`${BASE_URL}/api/rag/backfill/token-counts`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: '{}',
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`  HTTP ${res.status}: ${text}`);
      process.exit(1);
    }
    const data = await res.json();
    log(`  chunksUpdated=${data.chunksUpdated}  remainingChunks=${data.remainingChunks}`);
    if (!data?.hasMore) break;
  }
  log(`Token-count backfill complete after ${pass} pass(es).`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const step = process.argv[2] ?? 'all';

try {
  if (step === 'docs'        || step === 'all') await syncDocuments();
  if (step === 'chunks'      || step === 'all') await syncChunks();
  if (step === 'embeddings'  || step === 'all') await syncEmbeddings();
  if (step === 'token-counts') await backfillTokenCounts();
  if (step === 'sds-headings') await backfillSdsHeadings();
  log('Done.');
} catch (err) {
  console.error('Fatal:', err);
  process.exit(1);
}
