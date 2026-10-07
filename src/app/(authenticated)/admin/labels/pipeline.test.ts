import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getLabelDashboardStatus } from './pipeline';

/**
 * B0-259 work item 1 — live verification that the change-detection dashboard status
 * (S3 ETag listing + rag.source_record.checksum comparison + needs_review surfacing)
 * runs end-to-end against the real retool-360/labels S3 prefix and the real corpus,
 * without mutating anything (read-only: S3 ListObjectsV2 + Supabase selects, no writes,
 * no embeddings). Deliberately does NOT call runLabelIngestion() here -- that would
 * re-embed/re-ingest real corpus rows and is not something a test suite should do.
 *
 * Same "load .env.local, skip gracefully without creds" convention as
 * rag/efficacy-retrieval-lifecycle.test.ts.
 */

function loadEnvLocalIfNeeded() {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return;
  }
  const envPath = path.resolve(__dirname, '../../../../../.env.local');
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvLocalIfNeeded();

const hasCreds = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    (process.env.AWS_ACCESS_READ_KEY_ID || process.env.AWS_360_READ_ACCESS_KEY_ID),
);

describe.skipIf(!hasCreds)('label sync change-detection dashboard (B0-259)', () => {
  it('lists real S3 label files, computes changed/needsReview totals, and does not error', async () => {
    const status = await getLabelDashboardStatus();

    expect(status.totals.seeded).toBeGreaterThan(0);
    expect(typeof status.totals.changed).toBe('number');
    expect(typeof status.totals.needsReview).toBe('number');
    expect(status.totals.changed).toBeGreaterThanOrEqual(0);
    expect(status.totals.needsReview).toBeGreaterThanOrEqual(0);

    // First run after this feature ships: no source_record has a captured checksum yet
    // (verified live via SQL — 0 of 795), so nothing should be flagged "changed" until
    // the next real ingest establishes a baseline. This is a deliberate design choice
    // (see buildDocumentRow's comment) to avoid a surprise mass re-ingest.
    expect(status.totals.changed).toBe(0);
  }, 30_000);
});
