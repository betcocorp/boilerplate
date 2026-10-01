import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * B0-272 follow-up regression — `filter_section_type` was being threaded into every
 * `scope: 'all'` corpus search in `runProductKnowledgeQuery`, but the RPC applies it as
 * a hard SQL filter against `rag.document_chunk.section_type`, which only ever carries
 * fine-grained GHS values (e.g. `organism_contact_time`) on SDS chunks — label/knowledge
 * chunks are always the coarse `label`/`knowledge` bucket. Any query matching one of the
 * SDS-oriented patterns in `inferSectionTypeFromQuery` (contact time, dilution, "how to
 * store", etc. — all common label phrasing too) silently zeroed out every label/knowledge
 * chunk, which is what actually broke the B0-272 prose-fallback fix in production despite
 * both `get_efficacy_data` and `search_product_docs` being called as instructed.
 *
 * Live-Supabase (+ live OpenAI embeddings) integration test, following the precedent set by
 * product-scoped-retrieval.eval.test.ts — skips gracefully without credentials.
 *
 * Verified 2026-07-27 directly against the live `rag` schema: label document
 * `3d46dbf6-76fe-41a1-8c62-5dfc09c7e298` ("GE Fight Bac RTU", contains "The surface must
 * remain visibly wet for at least 60 seconds") has `section_type = 'label'` on all its
 * chunks. Calling `match_corpus_chunks_hybrid` for this query with no section filter
 * surfaces it top-ranked (similarity ~0.611, 30 rows); with `filter_section_type:
 * 'organism_contact_time'` (what `inferSectionTypeFromQuery` returns for this query)
 * added, it returns 0 rows.
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
const hasOpenAiCreds = Boolean(process.env.OPENAI_API_KEY);

const GE_FIGHT_BAC_RTU_LABEL_DOC_ID = '3d46dbf6-76fe-41a1-8c62-5dfc09c7e298';

describe.skipIf(!hasSupabaseCreds || !hasOpenAiCreds)(
  'broad (unanchored) product-knowledge search no longer excludes label content on a contact-time-style query (B0-272 follow-up)',
  () => {
    it(
      'surfaces the GE Fight Bac RTU label chunk for a contact-time query with no product line resolved',
      async () => {
        const { ragQueryForProductKnowledgeWithMeta } = await import('~/lib/retrieval/product-knowledge');

        const result = await ragQueryForProductKnowledgeWithMeta({
          query: 'GE Fight Bac RTU contact time',
        });

        expect(result.sources.length).toBeGreaterThan(0);
        expect(result.sources.some((s) => s.documentId === GE_FIGHT_BAC_RTU_LABEL_DOC_ID)).toBe(
          true,
        );
      },
      45_000,
    );
  },
);
