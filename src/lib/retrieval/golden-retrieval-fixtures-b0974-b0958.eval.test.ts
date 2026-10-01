import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { executeProductTool } from '~/lib/tools/product-tools';

/**
 * B0-974 / B0-958 — golden-prompt retrieval fixtures ("expected document in the retrieved set").
 *
 * Live-Supabase (+ live OpenAI embeddings, + Cohere when configured) integration test, following
 * `product-scoped-retrieval.eval.test.ts`: skips (does not fail) without credentials, so it is not
 * part of the mocked unit gate. Document ids / titles / line keys were read from the live `rag`
 * schema on 2026-09-14 (see the two tickets for the queries).
 *
 * Each case goes through `executeProductTool` — the same entry the workflow's speculative pre-fetch
 * and the model's own tool calls use — so it exercises `classifyRetrievalIntent`, the curation
 * rules and the B0-958 line-tier merge together, not one layer in isolation.
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

const hasLiveCreds = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.OPENAI_API_KEY,
);

type SourcePayload = { documentId: string; title: string; documentKind: string; productLineKey: string | null };

function sourcesOf(payload: Record<string, unknown>): SourcePayload[] {
  return (payload.sources as SourcePayload[] | undefined) ?? [];
}

/** VCT 339b3004 — the traffic schedule lives in either of these two knowledge documents. */
const VCT_REOPENING_DOCS = [
  'feba31db-d949-4df4-9037-93499957e5ef', // "VCT Reopening to Traffic"
  '2d9f03a9-1fce-4aa9-a5a0-cd39a80a7a65', // "vct finish open to traffic timing"
];
/** SportsZone 6eeebab8 — the only "annual recoats" sentence in the corpus. */
const GYM_SANDING_LIFETIME_DOC = '29d72700-4ceb-44e0-825e-da5bfe2c3856';

/** B0-958 — line `226`, "Concentrated Deodorizing Liquid": 10 current SDS titled `226…`. */
const LINE_226 = '67385609-6E07-4B67-B1F2-203E4A28B2BB';

describe.skipIf(!hasLiveCreds)('B0-974 — golden prompts retrieve their answer document', () => {
  it(
    'VCT: "how soon can people walk on the VCT floor after the last coat?" reaches a reopening doc',
    async () => {
      const out = await executeProductTool(
        'search_product_docs',
        { freeformQuery: 'how soon can people walk on the VCT floor after the last coat?' },
        undefined,
        // The signals call labels this `single_value`; B0-974 must still widen it.
        { answerShape: 'single_value' },
      );
      const ids = sourcesOf(out).map((s) => s.documentId);
      expect(ids.some((id) => VCT_REOPENING_DOCS.includes(id))).toBe(true);
    },
    90_000,
  );

  it(
    'SportsZone: "How often should a wood sport floor be recoated?" reaches the sanding-lifetime doc',
    async () => {
      const out = await executeProductTool(
        'search_product_docs',
        { freeformQuery: 'How often should a wood sport floor be recoated?' },
        undefined,
        { answerShape: 'single_value' },
      );
      const ids = sourcesOf(out).map((s) => s.documentId);
      expect(ids).toContain(GYM_SANDING_LIFETIME_DOC);
    },
    90_000,
  );
});

describe.skipIf(!hasLiveCreds)('B0-958 — a product-tier consumer name reaches its line-tier SDS', () => {
  it(
    'get_safety_constraints("Best Scent Lemon Zest") cites an SDS of line 226 and nothing off-line',
    async () => {
      const out = await executeProductTool('get_safety_constraints', {
        productId: 'Best Scent Lemon Zest',
      });
      const sources = sourcesOf(out);
      const sds = sources.filter((s) => s.documentKind === 'sds');
      expect(sds.length).toBeGreaterThan(0);
      for (const s of sds) {
        expect(s.title).toMatch(/^226/);
        expect(s.productLineKey).toBe(LINE_226);
      }
      // Cross-line guard: every line-bearing source is on the resolved line.
      for (const s of sources) {
        if (s.productLineKey !== null) expect(s.productLineKey).toBe(LINE_226);
      }
      const retrieval = out.retrieval as { usedLineKindSupplement?: boolean } | undefined;
      expect(retrieval?.usedLineKindSupplement).toBe(true);
    },
    90_000,
  );
});
