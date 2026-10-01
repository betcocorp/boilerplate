import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-235 retrieval regression test — a superseded/never_activated/unused efficacy
 * document must not surface from default retrieval, while the current/active version
 * does. Exercises the real production chain: rag.sync_efficacy_chunks (B0-228) then
 * rag.match_corpus_chunks_hybrid's efficacy scope + lifecycle_status guard (B0-230/235),
 * not a mocked stand-in — this is genuinely a live-Supabase integration test.
 *
 * Every other test in this repo is a pure unit test (mocked deps, no network), so
 * there is no existing convention to follow for a DB-level regression test. This file
 * loads .env.local itself (matching how scripts/run-rag-pipeline.mjs documents its own
 * "Environment variables read from .env.local" integration behavior) and skips
 * gracefully — not failing — when Supabase credentials aren't present, since tests
 * are not currently wired into CI (see .github/workflows/eval-gate.yml) and this must
 * not break a plain `pnpm exec vitest run` on a machine without those secrets.
 */

function loadEnvLocalIfNeeded() {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return;
  }
  const envPath = path.resolve(__dirname, '../../../.env.local');
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

const hasSupabaseCreds = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const ZERO_EMBEDDING = `[${new Array(3072).fill(0).join(',')}]`;

describe.skipIf(!hasSupabaseCreds)('efficacy retrieval excludes non-active lifecycle (B0-235)', () => {
  const nonce = `zzzb0235${randomUUID().replace(/-/g, '')}`;
  const activeKey = `test:efficacy:${nonce}:active`;
  const supersededKey = `test:efficacy:${nonce}:superseded`;
  let sourceRecordId: string;

  beforeAll(async () => {
    const rag = getSupabaseServiceRoleClient().schema('rag');

    const { data: sourceRecord, error: sourceRecordError } = await rag
      .from('source_record')
      .insert({
        source_schema: 'efficacy',
        source_table: 'document',
        source_type: 's3_markdown',
        source_pk: `test-${nonce}`,
        is_active: true,
      })
      .select('id')
      .single();
    if (sourceRecordError || !sourceRecord) {
      throw new Error(`Failed to seed test source_record: ${sourceRecordError?.message}`);
    }
    sourceRecordId = sourceRecord.id;

    const body = (label: string) => `# Bactericidal Efficacy

## AOAC Use-Dilution Method

| Organism | Contact Time | Log Reduction |
|---|---|---|
| Staphylococcus aureus ${nonce} ${label} | 60 sec | 6.0 |
`;

    const { error: docsError } = await rag.from('document').insert([
      {
        document_key: activeKey,
        source_record_id: sourceRecordId,
        document_kind: 'efficacy',
        title: `Test Efficacy Active ${nonce}`,
        language_code: 'EN',
        body_text: body('active'),
        body_markdown: body('active'),
        lifecycle_status: 'active',
        is_current: true,
      },
      {
        document_key: supersededKey,
        source_record_id: sourceRecordId,
        document_kind: 'efficacy',
        title: `Test Efficacy Superseded ${nonce}`,
        language_code: 'EN',
        body_text: body('superseded'),
        body_markdown: body('superseded'),
        lifecycle_status: 'superseded',
        is_current: false,
      },
    ]);
    if (docsError) {
      throw new Error(`Failed to seed test documents: ${docsError.message}`);
    }

    // Drain sync_efficacy_chunks until our two seeded documents are chunked (bounded
    // to avoid an infinite loop if something upstream is also mid-sync).
    for (let i = 0; i < 10; i += 1) {
      const { data, error } = await rag.rpc('sync_efficacy_chunks', { p_language_code: 'EN' });
      if (error) throw new Error(`sync_efficacy_chunks failed: ${error.message}`);
      const result = data as { documents_processed?: number; has_more?: boolean } | null;
      if (!result?.has_more) break;
    }
  }, 30_000);

  afterAll(async () => {
    if (!sourceRecordId) return;
    const rag = getSupabaseServiceRoleClient().schema('rag');
    // ON DELETE CASCADE: source_record -> document -> document_chunk.
    await rag.from('source_record').delete().eq('id', sourceRecordId);
  });

  it('surfaces the active document but not the superseded one, for scope=efficacy', async () => {
    const rag = getSupabaseServiceRoleClient().schema('rag');
    const { data, error } = await rag.rpc('match_corpus_chunks_hybrid', {
      query_embedding: ZERO_EMBEDDING,
      query_text: nonce,
      match_count: 10,
      filter_scope: 'efficacy',
    });

    expect(error).toBeNull();
    const titles = (data ?? []).map((row) => row.document_title);
    expect(titles).toContain(`Test Efficacy Active ${nonce}`);
    expect(titles).not.toContain(`Test Efficacy Superseded ${nonce}`);
  });

  it(
    'also excludes the superseded document under the default scope=all',
    async () => {
      const rag = getSupabaseServiceRoleClient().schema('rag');
      const { data, error } = await rag.rpc('match_corpus_chunks_hybrid', {
        query_embedding: ZERO_EMBEDDING,
        query_text: nonce,
        match_count: 10,
        filter_scope: 'all',
      });

      expect(error).toBeNull();
      const titles = (data ?? []).map((row) => row.document_title);
      expect(titles).toContain(`Test Efficacy Active ${nonce}`);
      expect(titles).not.toContain(`Test Efficacy Superseded ${nonce}`);
    },
    // scope=all ANN-scans the full corpus (thousands of SDS/product chunks) with a
    // degenerate all-zero query vector (measured ~12s via EXPLAIN ANALYZE — a
    // pre-existing characteristic of a zero-vector cosine-distance HNSW scan, not
    // something introduced here), unlike the efficacy-scoped query above which is
    // pre-filtered to a handful of rows.
    30_000,
  );

  it('history remains directly addressable by document id despite the retrieval exclusion', async () => {
    const rag = getSupabaseServiceRoleClient().schema('rag');
    const { data, error } = await rag
      .from('document')
      .select('id, lifecycle_status')
      .eq('document_key', supersededKey)
      .single();

    expect(error).toBeNull();
    expect(data?.lifecycle_status).toBe('superseded');
  });
});
