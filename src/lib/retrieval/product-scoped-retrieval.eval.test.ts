import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveProductEntityByName } from '~/lib/rag/entity-context';

/**
 * B0-251 regression eval — product-scoped retrieval (B0-250: product_key threading
 * through resolveProductEntityByName / searchProductChunks / runProductKnowledgeQuery).
 *
 * Live-Supabase (+ live OpenAI embeddings) integration test, following the precedent
 * set by rag/efficacy-retrieval-lifecycle.test.ts: every other test in this repo mocks
 * its dependencies, so this file documents its own convention and skips gracefully
 * (not failing) when credentials aren't present, since these tests are not wired into
 * a `pnpm exec vitest run` gate that requires them.
 *
 * All product_key/product_line_key values below were verified directly against the
 * live `rag` schema (product_alias, entity, document, document_chunk) before writing
 * these assertions — see the B0-251 report for the exact queries run.
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

// Verified 2026-07-24 via `rag.product_alias` joined to `rag.entity` (entity_type='product').
const ADVANCED_SANITIZER = {
  alias: '79504-00',
  productLineKey: 'E7DBF4CA-0109-4A95-901A-2C307E444263',
  productKey: 'DED05ED7-39F5-4536-A904-165A689F3529',
};

const KLING = {
  alias: '07512-00',
  productLineKey: '110F65B0-FE92-412A-9A03-654586617F2C',
  productKey: '07512',
  // rag.entity.id for the Kling (US) label-tagged product entity.
  entityId: '819f815e-4fe6-5014-9e6f-f1e19cfdc714',
};

// Verified thin coverage: this product line has exactly 1 chunk of indexed content
// (a single product_line_profile chunk listing the variant/SKU), no SDS/label content.
const TRASH_FOAM_CONCENTRATE = {
  productLineKey: '7AFF2D18-3296-43DB-9F2D-D11586C996BC',
  productKey: '12634307-3C8F-4CE6-B95F-C0B23F217024',
};

describe.skipIf(!hasSupabaseCreds)('resolveProductEntityByName resolves SKU/InvtID to a product (B0-251)', () => {
  it('resolves a known SKU to both its product_line_key and product_key', async () => {
    const result = await resolveProductEntityByName(ADVANCED_SANITIZER.alias);
    expect(result.productLineKey).toBe(ADVANCED_SANITIZER.productLineKey);
    expect(result.productKey).toBe(ADVANCED_SANITIZER.productKey);
  });

  it('resolves a second known SKU (Kling) to both keys', async () => {
    const result = await resolveProductEntityByName(KLING.alias);
    expect(result.productLineKey).toBe(KLING.productLineKey);
    expect(result.productKey).toBe(KLING.productKey);
  });

  it('returns nulls for an alias that does not exist (no false-positive resolution)', async () => {
    const result = await resolveProductEntityByName('not-a-real-sku-zzz999');
    expect(result.productLineKey).toBeNull();
    expect(result.productKey).toBeNull();
  });
});

describe.skipIf(!hasSupabaseCreds || !hasOpenAiCreds)(
  'product-scoped and line-scoped retrieval behavior (B0-250/B0-251)',
  () => {
    it(
      'product-scoped query (explicit productKey) surfaces the resolved product\'s own tagged content',
      async () => {
        const { ragQueryForProductKnowledgeWithMeta } = await import('~/lib/retrieval/product-knowledge');
        const result = await ragQueryForProductKnowledgeWithMeta({
          query: 'What are the hazards and signal word for Kling toilet bowl cleaner?',
          productLineKey: KLING.productLineKey,
          productKey: KLING.productKey,
        });

        expect(result.sources.length).toBeGreaterThan(0);
        expect(result.retrieval.strategy).toBe('explicit_product_line');
        // Coverage exists for this SKU's line (its label docs are tagged at the product tier), so
        // the anchored attempt should succeed directly without needing the B0-250 fallback retry.
        expect(result.retrieval.usedProductKeyFallback).toBe(false);
        // At least one surfaced source should carry a non-null product_key — proving the
        // product-tier tag threads through to the match/source objects (B0-250's `productKey`
        // field on `CuratedSource`). This originally surfaced a real gap: `rag.match_corpus_chunks`/
        // `_hybrid` (scope="all") had no `filter_product_key` parameter at all (only
        // `match_product_chunks*`/scope="products" did), so `productKey` was inert on this exact
        // code path -- fixed in a follow-up migration
        // (20260724130000_add_filter_product_key_to_corpus_match.sql) that adds the parameter to
        // both corpus-scope RPCs, mirroring match_product_chunks' existing predicate.
        expect(result.sources.some((s) => s.productKey != null)).toBe(true);
      },
      20_000,
    );

    it(
      'line-scoped query (no productKey) behaves exactly as before B0-250: unchanged',
      async () => {
        const { ragQueryForProductKnowledgeWithMeta } = await import('~/lib/retrieval/product-knowledge');
        const result = await ragQueryForProductKnowledgeWithMeta({
          query: 'What are the hazards and signal word for Kling toilet bowl cleaner?',
          productLineKey: KLING.productLineKey,
          // productKey intentionally omitted.
        });

        expect(result.sources.length).toBeGreaterThan(0);
        expect(result.retrieval.strategy).toBe('explicit_product_line');
        // No explicit product key was supplied, so the B0-250 fallback-retry branch can never
        // trigger (its guard is `curated.length === 0 && explicitProductKey`) — this is the
        // pre-B0-250 code path, verified unchanged.
        expect(result.retrieval.usedProductKeyFallback).toBe(false);
      },
      20_000,
    );

    it(
      'thin real coverage (1 indexed chunk for the whole line) still returns content, not an empty result',
      async () => {
        const { ragQueryForProductKnowledgeWithMeta } = await import('~/lib/retrieval/product-knowledge');
        const result = await ragQueryForProductKnowledgeWithMeta({
          query: 'What variant and SKU information is available for Trash Foam Concentrate?',
          productLineKey: TRASH_FOAM_CONCENTRATE.productLineKey,
          productKey: TRASH_FOAM_CONCENTRATE.productKey,
        });

        expect(result.sources.length).toBeGreaterThan(0);
      },
      20_000,
    );

    it(
      'line fallback: an explicit product key with zero eligible coverage for its line sets ' +
        'usedProductKeyFallback and does not throw, and returns zero sources since neither the ' +
        'line nor the product key correspond to any real content',
      async () => {
        const { ragQueryForProductKnowledgeWithMeta } = await import('~/lib/retrieval/product-knowledge');
        const nonceLineKey = '00000000-0000-4000-8000-000000000000';
        const nonceProductKey = '00000000-0000-4000-8000-000000000001';

        const result = await ragQueryForProductKnowledgeWithMeta({
          query: 'What is the dilution ratio for this product?',
          productLineKey: nonceLineKey,
          productKey: nonceProductKey,
        });

        expect(result.retrieval.strategy).toBe('explicit_product_line');
        expect(result.retrieval.usedProductKeyFallback).toBe(true);
        expect(result.sources.length).toBe(0);
      },
      20_000,
    );
  },
);

/**
 * B0-479 — confirm alias-resolved `product_line_key` flows through hybrid retrieval routing
 * end-to-end: `resolveProductEntityByName` (an alias-table hit, exactly as every
 * `product-tools.ts` call site invokes it) -> non-null `productLineKey` -> passed into
 * `ragQueryForProductKnowledgeWithMeta` as an explicit key -> `strategy: 'explicit_product_line'`,
 * never falling through to the broad-probe `resolveProductLineFromMatches` path (that call only
 * happens in the branch reached when there is NO explicit key -- see product-knowledge.ts).
 *
 * Also confirms the B0-479 telemetry addition: `retrieval.explicitKeySource` tags *why* the key
 * was explicit -- `'alias_exact'` here, since `KLING.alias` ('07512-00') is a verified exact
 * `rag.product_alias.alias_norm` match (not the tokenized-fuzzy or title-match fallbacks).
 */
describe.skipIf(!hasSupabaseCreds || !hasOpenAiCreds)(
  'alias-resolved productLineKey flows through hybrid retrieval routing (B0-479)',
  () => {
    it(
      'an alias name resolves via the exact-alias path and anchors retrieval, not the broad probe',
      async () => {
        const resolved = await resolveProductEntityByName(KLING.alias);
        expect(resolved.productLineKey).toBe(KLING.productLineKey);
        expect(resolved.productKey).toBe(KLING.productKey);
        expect(resolved.resolutionSource).toBe('alias_exact');

        const { ragQueryForProductKnowledgeWithMeta } = await import('~/lib/retrieval/product-knowledge');
        const result = await ragQueryForProductKnowledgeWithMeta({
          query: 'What are the hazards and signal word for this product?',
          productLineKey: resolved.productLineKey,
          productKey: resolved.productKey,
          productLineKeySource: resolved.resolutionSource,
        });

        expect(result.sources.length).toBeGreaterThan(0);
        expect(result.retrieval.strategy).toBe('explicit_product_line');
        expect(result.retrieval.explicitKeySource).toBe('alias_exact');
        // The explicit-key branch never calls `resolveProductLineFromMatches` (the broad-probe
        // path) -- its own productLineResolution is synthesized directly from the explicit key,
        // which is the concrete, checkable proof that the broad probe was bypassed.
        expect(result.retrieval.productLineResolution?.lockReason).toBe('explicit_filter');
        expect(result.retrieval.productLineResolution?.lockedProductLineKey).toBe(
          KLING.productLineKey,
        );
        expect(result.retrieval.productLineResolution?.candidates).toEqual([]);
      },
      20_000,
    );

    it(
      'a caller that supplies an explicit key without a resolutionSource is tagged unspecified, not misattributed to alias',
      async () => {
        const { ragQueryForProductKnowledgeWithMeta } = await import('~/lib/retrieval/product-knowledge');
        const result = await ragQueryForProductKnowledgeWithMeta({
          query: 'What are the hazards and signal word for this product?',
          productLineKey: KLING.productLineKey,
          productKey: KLING.productKey,
          // productLineKeySource intentionally omitted -- simulates a caller that predates B0-479.
        });

        expect(result.retrieval.strategy).toBe('explicit_product_line');
        expect(result.retrieval.explicitKeySource).toBe('unspecified');
      },
      20_000,
    );
  },
);
