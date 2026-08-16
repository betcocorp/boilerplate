import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveProductEntityByName } from '~/lib/rag/entity-context';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-482 — live-Supabase integration coverage for `rag.match_product_alias_fuzzy` (the trigram
 * fuzzy alias RPC) and its wiring into `resolveProductEntityByName`.
 *
 * Follows the precedent set by `~/lib/retrieval/product-scoped-retrieval.eval.test.ts`: skips
 * gracefully (not failing) when Supabase credentials aren't present, rather than mocking the DB
 * like the rest of this repo's unit tests do.
 *
 * The three typo/partial-match cases below and their expected top match / `product_line_key`
 * were verified directly against the live `rag.product_alias` table via `execute_sql` (trigram
 * `similarity()` computed with the same normalization the RPC applies -- lowercase + trim) before
 * writing these assertions -- see the B0-482 report for the exact queries run. Each has a wide
 * similarity margin over its runner-up (no near-tie with a different product line), so they are
 * clean single-answer cases, not ambiguity-tiebreak scenarios (those are covered by the mocked
 * unit suite in entity-context.test.ts).
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

type FuzzyMatchRpcRow = {
  alias_norm: string;
  alias: string;
  product_line_key: string | null;
  entity_id: string | null;
  verified: boolean;
  alias_type: string | null;
  confidence: number | null;
  similarity: number;
};

type FuzzyMatchRpcClient = {
  rpc: (
    fn: 'match_product_alias_fuzzy',
    args: { query: string; similarity_threshold?: number; max_results?: number },
  ) => Promise<{ data: FuzzyMatchRpcRow[] | null; error: { message: string } | null }>;
};

async function callFuzzyMatchRpc(
  query: string,
  args?: { similarity_threshold?: number; max_results?: number },
) {
  const rag = getSupabaseServiceRoleClient().schema('rag');
  const { data, error } = await (rag as unknown as FuzzyMatchRpcClient).rpc(
    'match_product_alias_fuzzy',
    { query, ...args },
  );
  if (error) throw new Error(`match_product_alias_fuzzy RPC failed: ${error.message}`);
  return data ?? [];
}

// Verified live 2026-08-15 via `select alias_norm, product_line_key, similarity(alias_norm, ...)
// from rag.product_alias where alias_norm % ... order by similarity desc` -- see B0-482 report.
const ACRYLIC_POLYMER_FLOOR_FINISH = {
  typoQuery: 'acrylic polymer flor finish',
  productLineKey: 'C6CC3B63-5DDB-4FCF-B5D1-6BC5CDFD21A8',
  topSimilarity: 0.896552,
};
const AGGRESSIVE_NO_RINSE_STRIPPER = {
  typoQuery: 'agressive no-rinse stripper',
  productLineKey: '75FCC5DE-ECD2-4AD3-8117-3A397A3A916D',
  topSimilarity: 0.9,
};
const ACID_FREE_BATHROOM_CLEANER = {
  typoQuery: 'acid free bathrom cleaner',
  productLineKey: '5DA2C45A-E3EC-4693-902C-8589705D1E71',
  topSimilarity: 0.892857,
};

describe.skipIf(!hasSupabaseCreds)('rag.match_product_alias_fuzzy RPC (B0-482)', () => {
  it.each([
    ['acrylic polymer flor finish (missing "o")', ACRYLIC_POLYMER_FLOOR_FINISH],
    ['agressive no-rinse stripper (missing "g")', AGGRESSIVE_NO_RINSE_STRIPPER],
    ['acid free bathrom cleaner (missing "o")', ACID_FREE_BATHROOM_CLEANER],
  ])('returns the correct top match for a real typo case: %s', async (_label, fixture) => {
    const rows = await callFuzzyMatchRpc(fixture.typoQuery);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].product_line_key).toBe(fixture.productLineKey);
    expect(rows[0].similarity).toBeCloseTo(fixture.topSimilarity, 5);
    // Ranked descending by similarity.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].similarity).toBeLessThanOrEqual(rows[i - 1].similarity);
    }
  });

  it('returns no rows for a query with no plausible trigram match (no guessing below threshold)', async () => {
    const rows = await callFuzzyMatchRpc('zzqx not a real betco product name qqzz', { similarity_threshold: 0.35 });
    expect(rows).toEqual([]);
  });

  it('respects a caller-supplied similarity_threshold rather than the RPC default', async () => {
    // A high threshold should filter out even a genuine typo match.
    const rows = await callFuzzyMatchRpc(ACRYLIC_POLYMER_FLOOR_FINISH.typoQuery, {
      similarity_threshold: 0.99,
    });
    expect(rows).toEqual([]);
  });

  it('respects max_results', async () => {
    const rows = await callFuzzyMatchRpc(ACRYLIC_POLYMER_FLOOR_FINISH.typoQuery, {
      similarity_threshold: 0.1,
      max_results: 2,
    });
    expect(rows.length).toBeLessThanOrEqual(2);
  });
});

describe.skipIf(!hasSupabaseCreds)(
  'resolveProductEntityByName wires the fuzzy RPC as a fallback tier (B0-482/B0-483)',
  () => {
    it('resolves a typo query with no exact/tokenized alias match via the fuzzy trigram tier', async () => {
      const result = await resolveProductEntityByName(ACID_FREE_BATHROOM_CLEANER.typoQuery);
      expect(result.productLineKey).toBe(ACID_FREE_BATHROOM_CLEANER.productLineKey);
      expect(result.resolutionSource).toBe('alias_fuzzy_trgm');
    });

    it('does not guess for a nonsense query -- falls through every tier to null', async () => {
      const result = await resolveProductEntityByName('zzqx not a real betco product name qqzz');
      expect(result).toEqual({
        productLineKey: null,
        productKey: null,
        resolutionSource: null,
        ambiguousAlias: false,
        matchedAliasId: null,
        matchedAliasConfidence: null,
      });
    });
  },
);
