import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-1079 (epic B0-1073) — coverage sanity check for `rag.product_line_web_url` (B0-1074).
 *
 * There is no pure TypeScript URL-building helper to unit test: the URL
 * (`'https://www.betco.com/ProductsDetail?productID=' || upper(pl."ProdLineKey")`) is built
 * entirely inside the SQL view, and nothing in this codebase reconstructs it from a raw
 * `product_line_key` in TS -- `fetchProductLineWebUrls()` (`~/lib/retrieval/document-assembly.ts`)
 * only ever reads the already-built `web_url` column back out. Per B0-1079's own AC, the
 * fallback for that case is this coverage-sanity test alone.
 *
 * Live-Supabase integration test, following the same convention as
 * `product-scoped-retrieval.eval.test.ts` / `sds-content-language.test.ts`: skips (never fails)
 * when `SUPABASE_SERVICE_ROLE_KEY` is absent, since these tests are not wired into a plain
 * `pnpm exec vitest run` gate that requires live credentials.
 *
 * Verified live 2026-09-23: 288 rows, line 311 present (see the B0-1074 migration file and the
 * "Product page URL derivation" section of `rag-data-relationships.md` for the full picture).
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

describe.skipIf(!hasSupabaseCreds)('rag.product_line_web_url coverage (B0-1074/B0-1079)', () => {
  it('returns between 250 and 400 rows and includes line 311 (Fight Bac RTU)', async () => {
    const rag = getSupabaseServiceRoleClient().schema('rag') as unknown as {
      from(table: string): {
        select(cols: string): Promise<{
          data: Array<{ product_line_key: string; prod_line_id: string | null; web_url: string }> | null;
          error: { message: string } | null;
        }>;
      };
    };

    const { data, error } = await rag.from('product_line_web_url').select('product_line_key, prod_line_id, web_url');
    if (error) throw new Error(`rag.product_line_web_url read failed: ${error.message}`);

    const rows = data ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(250);
    expect(rows.length).toBeLessThanOrEqual(400);

    const line311 = rows.find((row) => row.prod_line_id === '311');
    expect(line311).toBeDefined();
    expect(line311?.web_url).toBe(
      'https://www.betco.com/ProductsDetail?productID=CA352FDA-543F-4D28-BB61-371247F351D4',
    );

    // No duplicate product_line_key rows (the view's `distinct on` should have deduped the
    // known triplicated legacy.prod_line rows).
    const uniqueKeys = new Set(rows.map((row) => row.product_line_key));
    expect(uniqueKeys.size).toBe(rows.length);
  });
});
