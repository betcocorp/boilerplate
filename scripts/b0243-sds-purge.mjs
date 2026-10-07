/**
 * B0-243 — Purge the out-of-policy SDS documents identified by
 * scripts/b0243-sds-scope-audit.mjs (src/lib/training/sds-scope-audit-report.json).
 *
 * For each purge candidate:
 *   1. Set rag.source_record.is_active = false (matches how the steady-state
 *      rag.sync_sds_chunks() function already treats deactivated documents).
 *   2. Delete its rag.document_chunk rows (embeddings live as columns on this
 *      table, so this removes chunks + embeddings together).
 *
 * The rag.document row itself is NOT deleted -- body_text/metadata are kept, so
 * this is reversible (re-activate + re-run rag.sync_sds_chunks() to re-chunk/
 * re-embed) rather than a hard, unrecoverable delete.
 *
 * Confirmed via mcp__supabase live query before running: 1,799 candidates, all
 * with a documentId + sourceRecordId. Run only after explicit user confirmation
 * (given 2026-07-24 in the B0-243 Jira thread).
 *
 * Usage:
 *   node --env-file=.env.local scripts/b0243-sds-purge.mjs
 *
 * Env (from .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { createClient } from '@supabase/supabase-js';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '..');
const REPORT_PATH = join(REPO_ROOT, 'src/lib/training/sds-scope-audit-report.json');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Run with --env-file=.env.local.',
  );
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  const candidates = report.purgeCandidates;
  console.log('Purge candidates loaded from report:', candidates.length);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { db: { schema: 'rag' } });

  const sourceRecordIds = [...new Set(candidates.map((c) => c.sourceRecordId).filter(Boolean))];
  const documentIds = [...new Set(candidates.map((c) => c.documentId).filter(Boolean))];

  console.log('Deactivating source_record rows:', sourceRecordIds.length);
  let deactivated = 0;
  for (const batch of chunkArray(sourceRecordIds, 500)) {
    const { data, error } = await supabase
      .schema('rag')
      .from('source_record')
      .update({ is_active: false })
      .in('id', batch)
      .select('id');
    if (error) throw new Error(`source_record deactivation failed: ${error.message}`);
    deactivated += data.length;
  }
  console.log('source_record rows deactivated:', deactivated);

  console.log('Deleting document_chunk rows for', documentIds.length, 'documents');
  let chunksDeleted = 0;
  for (const batch of chunkArray(documentIds, 500)) {
    const { data, error } = await supabase
      .schema('rag')
      .from('document_chunk')
      .delete()
      .in('document_id', batch)
      .select('id');
    if (error) throw new Error(`document_chunk delete failed: ${error.message}`);
    chunksDeleted += data.length;
  }
  console.log('document_chunk rows deleted:', chunksDeleted);

  // Verification pass.
  let remainingActive = 0;
  let remainingChunks = 0;
  for (const batch of chunkArray(sourceRecordIds, 500)) {
    const { count, error } = await supabase
      .schema('rag')
      .from('source_record')
      .select('id', { count: 'exact', head: true })
      .in('id', batch)
      .eq('is_active', true);
    if (error) throw new Error(`Verification query failed: ${error.message}`);
    remainingActive += count ?? 0;
  }
  for (const batch of chunkArray(documentIds, 500)) {
    const { count, error } = await supabase
      .schema('rag')
      .from('document_chunk')
      .select('id', { count: 'exact', head: true })
      .in('document_id', batch);
    if (error) throw new Error(`Verification query failed: ${error.message}`);
    remainingChunks += count ?? 0;
  }

  console.log('\n=== Verification ===');
  console.log('Purge-candidate source_records still active (expect 0):', remainingActive);
  console.log('Purge-candidate documents still with chunks (expect 0):', remainingChunks);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
